// Event retention. A compaction pass shrinks the event logs of tasks that
// finished longer ago than `eventRetentionDays`: it deletes activity and the
// record snapshots a later one supersedes, and drops output previews, while
// the records (tasks, sessions, transcripts, messages, artifacts, checks,
// usage, approvals and chat updates) stay whole. Every event the engine reads
// back is kept, and for any cursor n, folding the kept events after n onto
// the view at n gives the latest view, so a stream resumed from inside the
// compacted range converges. Each task is compacted in one transaction under
// its row lock; a pass is idempotent and resumable.
import type { TaskEventType } from "@jj/contracts";
import {
  approvals,
  type Executor,
  jobs,
  runs,
  sessions,
  type Tx,
  taskEvents,
  tasks,
} from "@jj/db";
import {
  and,
  asc,
  count,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
  notInArray,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type { EngineContext } from "../context";
import { errorMessage } from "../errors";
import { emit } from "../events";

/**
 * What compaction does to an event of each type at or below the task's
 * `through`:
 * - `keep`: kept as it is;
 * - `delete`: deleted (activity a finished task no longer needs);
 * - `strip`: kept without its preview `field`;
 * - `latest`: a snapshot of a record (`path` names its id in the payload):
 *   only the latest snapshot of each record is kept.
 * Typed over every event type, so a new type must be classified here.
 */
export const COMPACTION: Readonly<
  Record<
    TaskEventType,
    | { action: "keep" | "delete" }
    | { action: "strip"; field: string }
    | { action: "latest"; record: "task" | "session" | "approval" }
  >
> = {
  "task.created": { action: "keep" },
  "task.updated": { action: "latest", record: "task" },
  "task.goal_changed": { action: "keep" },
  "task.reopened": { action: "keep" },
  "task.finished": { action: "keep" },
  "task.compacted": { action: "keep" },
  "message.posted": { action: "keep" },
  "session.created": { action: "latest", record: "session" },
  "session.updated": { action: "latest", record: "session" },
  "run.started": { action: "delete" },
  "run.finished": { action: "keep" },
  "model.started": { action: "delete" },
  "model.finished": { action: "strip", field: "text" },
  "tool.started": { action: "delete" },
  "tool.finished": { action: "strip", field: "output" },
  "artifact.created": { action: "keep" },
  "artifact.updated": { action: "keep" },
  "steering.received": { action: "keep" },
  "verification.started": { action: "keep" },
  "verification.checked": { action: "keep" },
  "verification.finished": { action: "keep" },
  "spend.capped": { action: "keep" },
  "spend.threshold": { action: "keep" },
  "approval.requested": { action: "latest", record: "approval" },
  "approval.updated": { action: "latest", record: "approval" },
  "mcp.server": { action: "keep" },
  "workspace.removed": { action: "keep" },
  "cancellation.requested": { action: "keep" },
  "cancellation.completed": { action: "keep" },
};

const typesWhere = (
  match: (rule: (typeof COMPACTION)[TaskEventType]) => boolean,
) =>
  (Object.keys(COMPACTION) as TaskEventType[]).filter((type) =>
    match(COMPACTION[type]),
  );

const DELETED = typesWhere((rule) => rule.action === "delete");
const SNAPSHOTS = typesWhere((rule) => rule.action === "latest");
const STRIPPED = (Object.keys(COMPACTION) as TaskEventType[]).flatMap(
  (type) => {
    const rule = COMPACTION[type];
    return rule.action === "strip" ? [{ type, field: rule.field }] : [];
  },
);

/**
 * The record a snapshot event is of: the task, or a session or approval by
 * its id. Built from the constant rules above, never from input.
 */
const SNAPSHOT_RECORD = sql.raw(
  `case ${SNAPSHOTS.map((type) => {
    const rule = COMPACTION[type] as { record: string };
    return rule.record === "task"
      ? `when type = '${type}' then 'task'`
      : `when type = '${type}' then '${rule.record}:' || (payload -> '${rule.record}' ->> 'id')`;
  }).join(" ")} end`,
);

const FINISHED = ["completed", "failed", "cancelled"] as const;

/**
 * A task compaction may touch now: completed, failed or cancelled before
 * `finishedBefore`, with something new since its last compaction, and with
 * nothing left that could still act on its events: no session or job queued
 * or running, no run open or pending a snapshot, no pending approval and no
 * stop in progress. A waiting task is never compacted.
 */
function compactable(finishedBefore: Date): SQL {
  return and(
    ...compactableButForSnapshots(finishedBefore),
    sql`not ${pendingSnapshot}`,
  ) as SQL;
}

/** A run of the task is pending its final snapshot. */
const pendingSnapshot = sql`exists (select 1 from ${runs} where ${runs.taskId} = ${tasks.id} and ${runs.snapshotPending})`;

/** Every guard of `compactable` but the pending snapshot's. */
function compactableButForSnapshots(finishedBefore: Date): SQL[] {
  return [
    inArray(tasks.status, [...FINISHED]),
    isNotNull(tasks.finishedAt),
    lt(tasks.finishedAt, finishedBefore),
    gt(tasks.eventSeq, sql`${tasks.eventsCompactedThrough} + 1`),
    or(isNull(tasks.cancelRequestedAt), eq(tasks.status, "cancelled")) as SQL,
    sql`not exists (select 1 from ${sessions} where ${sessions.taskId} = ${tasks.id} and ${sessions.status} in ('queued', 'running'))`,
    sql`not exists (select 1 from ${jobs} where ${jobs.taskId} = ${tasks.id} and ${jobs.status} in ('queued', 'running'))`,
    sql`not exists (select 1 from ${runs} where ${runs.taskId} = ${tasks.id} and ${runs.status} = 'running')`,
    sql`not exists (select 1 from ${approvals} where ${approvals.taskId} = ${tasks.id} and ${approvals.status} = 'pending')`,
  ];
}

export interface TaskCompaction {
  taskId: string;
  through: number;
  removed: number;
  stripped: number;
}

/**
 * Compacts one task's events in `tx`, if it may be compacted now: locks its
 * row, checks it again under the lock, deletes and rewrites, sets
 * `events_compacted_through` and appends `task.compacted`. Undefined when the
 * task is not (or no longer) compactable.
 */
export async function compactTask(
  tx: Tx,
  ctx: EngineContext,
  taskId: string,
  finishedBefore: Date,
): Promise<TaskCompaction | undefined> {
  const [locked] = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .for("update");
  if (!locked) return undefined;
  // Checked in a statement of its own once the lock is held: on PostgreSQL a
  // statement that waited for the lock still reads its subqueries from the
  // snapshot it started with, and would miss work committed meanwhile.
  const [task] = await tx
    .select({ id: tasks.id, through: tasks.eventSeq })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), compactable(finishedBefore)));
  if (!task) return undefined;
  const { through } = task;
  const inRange = and(
    eq(taskEvents.taskId, taskId),
    sql`${taskEvents.sequence} <= ${through}`,
  );
  const activity = await tx
    .delete(taskEvents)
    .where(and(inRange, inArray(taskEvents.type, DELETED)))
    .returning({ id: taskEvents.id });
  const superseded = (await tx.execute(sql`
    delete from ${taskEvents} using (
      select id, sequence, max(sequence) over (partition by record) as latest
      from (
        select id, sequence, ${SNAPSHOT_RECORD} as record
        from ${taskEvents}
        where task_id = ${taskId} and sequence <= ${through}
          and type in (${sql.join(
            SNAPSHOTS.map((type) => sql`${type}`),
            sql`, `,
          )})
      ) as snapshots
    ) as ranked
    where ${taskEvents.id} = ranked.id and ranked.sequence < ranked.latest
    returning ${taskEvents.id}
  `)) as unknown as { rows: unknown[] };
  let stripped = 0;
  for (const { type, field } of STRIPPED) {
    const rows = await tx
      .update(taskEvents)
      .set({ payload: sql`${taskEvents.payload} - ${field}::text` })
      .where(
        and(
          inRange,
          eq(taskEvents.type, type),
          sql`(${taskEvents.payload} -> ${field}::text) is not null`,
        ),
      )
      .returning({ id: taskEvents.id });
    stripped += rows.length;
  }
  const removed = activity.length + superseded.rows.length;
  await tx
    .update(tasks)
    .set({ eventsCompactedThrough: through })
    .where(eq(tasks.id, taskId));
  await emit(tx, ctx, taskId, {
    type: "task.compacted",
    payload: { through, removed, stripped },
  });
  return { taskId, through, removed, stripped };
}

export interface CompactionPass {
  tasks: TaskCompaction[];
  removed: number;
  stripped: number;
  /** The pass stopped at its task or time budget with candidates left. */
  more: boolean;
  /** Tasks whose compaction failed; the next passes skip them for a while. */
  failed: string[];
  /**
   * Finished tasks past the cutoff that the pass leaves alone only because
   * a run of theirs is still pending a snapshot.
   */
  waitingOnSnapshots: number;
  /** PGlite's `VACUUM task_events` ran after this pass. */
  vacuumed: boolean;
}

/** How long the passes skip a task whose compaction failed. */
export const FAILED_TASK_RETRY_MS = 24 * 60 * 60_000;
/** PGlite vacuums at most this often: it holds the process while it runs. */
export const VACUUM_INTERVAL_MS = 24 * 60 * 60_000;

/** What one engine's passes remember between them. */
interface PassMemory {
  /** Task id to when its compaction last failed. */
  failed: Map<string, number>;
  lastVacuumAt: number;
  removedSinceVacuum: number;
}

const memories = new WeakMap<EngineContext, PassMemory>();

function memoryOf(ctx: EngineContext): PassMemory {
  let memory = memories.get(ctx);
  if (!memory) {
    memory = { failed: new Map(), lastVacuumAt: 0, removedSinceVacuum: 0 };
    memories.set(ctx, memory);
  }
  return memory;
}

/** An error's class and database code, never its message, which may quote data. */
function errorClass(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const code =
    (error as { code?: unknown }).code ??
    (error.cause as { code?: unknown } | undefined)?.code;
  return typeof code === "string" ? `${error.name} (${code})` : error.name;
}

/** When a task must have finished to be compacted now; null when retention is off. */
export function retentionCutoff(ctx: EngineContext): Date | null {
  const days = ctx.config.eventRetentionDays;
  if (days === 0) return null;
  return new Date(ctx.clock().getTime() - days * 24 * 60 * 60_000);
}

/** The tasks a pass would compact now, oldest finish first, but those in `skip`. */
export function compactionCandidates(
  exec: Executor,
  finishedBefore: Date,
  limit: number,
  skip: readonly string[] = [],
): Promise<{ id: string }[]> {
  return exec
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        compactable(finishedBefore),
        skip.length > 0 ? notInArray(tasks.id, [...skip]) : undefined,
      ),
    )
    .orderBy(asc(tasks.finishedAt), asc(tasks.id))
    .limit(limit);
}

/**
 * Finished tasks past the cutoff, with events to compact, that compaction
 * leaves alone only because a finished run of theirs is still pending a
 * snapshot (its sandbox was gone before the final snapshot could run): every
 * other guard lets them be compacted.
 */
export async function waitingOnSnapshots(
  exec: Executor,
  finishedBefore: Date,
): Promise<number> {
  const [row] = await exec
    .select({ value: count() })
    .from(tasks)
    .where(and(...compactableButForSnapshots(finishedBefore), pendingSnapshot));
  return row?.value ?? 0;
}

export interface CompactionPassOptions {
  /** Replaces the retention cutoff (a pass asked for by hand). */
  finishedBefore?: Date;
  /** Checked before each task: true stops the pass there (the worker is stopping). */
  stop?: () => boolean;
}

/**
 * One compaction pass: at most `compactionMaxTasks` tasks, starting none
 * after `compactionMaxMs`, each in its own transaction. A task whose
 * compaction fails is logged by id and error class, and skipped by this
 * engine's passes for FAILED_TASK_RETRY_MS, so it never holds the others
 * up. On PGlite, a pass that leaves nothing to compact ends with `VACUUM
 * task_events`, at most once in VACUUM_INTERVAL_MS, since it holds the
 * process while it runs; on PostgreSQL autovacuum reuses the space.
 */
export async function compactionPass(
  ctx: EngineContext,
  options: CompactionPassOptions = {},
): Promise<CompactionPass> {
  const pass: CompactionPass = {
    tasks: [],
    removed: 0,
    stripped: 0,
    more: false,
    failed: [],
    waitingOnSnapshots: 0,
    vacuumed: false,
  };
  const finishedBefore = options.finishedBefore ?? retentionCutoff(ctx);
  if (!finishedBefore) return pass;
  const memory = memoryOf(ctx);
  const started = Date.now();
  for (const [taskId, at] of memory.failed)
    if (started - at >= FAILED_TASK_RETRY_MS) memory.failed.delete(taskId);
  const { compactionMaxTasks: maxTasks, compactionMaxMs: maxMs } = ctx.config;
  const candidates = await compactionCandidates(
    ctx.db,
    finishedBefore,
    maxTasks + 1,
    [...memory.failed.keys()],
  );
  let tried = 0;
  for (const candidate of candidates.slice(0, maxTasks)) {
    if (Date.now() - started >= maxMs || options.stop?.()) break;
    tried += 1;
    let done: TaskCompaction | undefined;
    try {
      done = await ctx.db.transaction((tx) =>
        compactTask(tx, ctx, candidate.id, finishedBefore),
      );
    } catch (error) {
      memory.failed.set(candidate.id, Date.now());
      pass.failed.push(candidate.id);
      ctx.logger.warn(
        "Compacting a task's events failed; the next passes skip it for a day",
        { taskId: candidate.id, error: errorClass(error) },
      );
      continue;
    }
    if (!done) continue;
    pass.tasks.push(done);
    pass.removed += done.removed;
    pass.stripped += done.stripped;
  }
  pass.more = candidates.length > tried;
  ctx.metrics.eventsCompacted(pass.removed, pass.stripped);
  pass.waitingOnSnapshots = await waitingOnSnapshots(ctx.db, finishedBefore);
  ctx.metrics.compactionWaitingOnSnapshots(pass.waitingOnSnapshots);
  memory.removedSinceVacuum += pass.removed;
  if (
    ctx.dbMode === "pglite" &&
    !pass.more &&
    memory.removedSinceVacuum > 0 &&
    Date.now() - memory.lastVacuumAt >= VACUUM_INTERVAL_MS
  ) {
    memory.lastVacuumAt = Date.now();
    memory.removedSinceVacuum = 0;
    pass.vacuumed = await ctx.db
      .execute(sql`vacuum task_events`)
      .then(() => true)
      .catch((error: unknown) => {
        ctx.logger.warn("Vacuuming task_events after compaction failed", {
          error: errorMessage(error),
        });
        return false;
      });
  }
  const line =
    pass.tasks.length > 0 || pass.failed.length > 0
      ? ctx.logger.info
      : ctx.logger.debug;
  line?.call(
    ctx.logger,
    `Compacted the events of ${pass.tasks.length} task(s)`,
    {
      tasks: pass.tasks.length,
      taskIds: pass.tasks.map((task) => task.taskId),
      removed: pass.removed,
      stripped: pass.stripped,
      more: pass.more,
      failed: pass.failed,
      waitingOnSnapshots: pass.waitingOnSnapshots,
      vacuumed: pass.vacuumed,
    },
  );
  return pass;
}
