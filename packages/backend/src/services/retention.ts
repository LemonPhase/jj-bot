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
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lt,
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
  "steering.received": { action: "keep" },
  "verification.started": { action: "keep" },
  "verification.checked": { action: "keep" },
  "verification.finished": { action: "keep" },
  "spend.capped": { action: "keep" },
  "spend.threshold": { action: "keep" },
  "approval.requested": { action: "latest", record: "approval" },
  "approval.updated": { action: "latest", record: "approval" },
  "mcp.server": { action: "keep" },
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
    inArray(tasks.status, [...FINISHED]),
    isNotNull(tasks.finishedAt),
    lt(tasks.finishedAt, finishedBefore),
    gt(tasks.eventSeq, sql`${tasks.eventsCompactedThrough} + 1`),
    or(isNull(tasks.cancelRequestedAt), eq(tasks.status, "cancelled")),
    sql`not exists (select 1 from ${sessions} where ${sessions.taskId} = ${tasks.id} and ${sessions.status} in ('queued', 'running'))`,
    sql`not exists (select 1 from ${jobs} where ${jobs.taskId} = ${tasks.id} and ${jobs.status} in ('queued', 'running'))`,
    sql`not exists (select 1 from ${runs} where ${runs.taskId} = ${tasks.id} and (${runs.status} = 'running' or ${runs.snapshotPending}))`,
    sql`not exists (select 1 from ${approvals} where ${approvals.taskId} = ${tasks.id} and ${approvals.status} = 'pending')`,
  ) as SQL;
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
  const [task] = await tx
    .select({ id: tasks.id, through: tasks.eventSeq })
    .from(tasks)
    .where(and(eq(tasks.id, taskId), compactable(finishedBefore)))
    .for("update");
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
}

/** When a task must have finished to be compacted now; null when retention is off. */
export function retentionCutoff(ctx: EngineContext): Date | null {
  const days = ctx.config.eventRetentionDays;
  if (days === 0) return null;
  return new Date(ctx.clock().getTime() - days * 24 * 60 * 60_000);
}

/** The tasks a pass would compact now, oldest finish first. */
export function compactionCandidates(
  exec: Executor,
  finishedBefore: Date,
  limit: number,
): Promise<{ id: string }[]> {
  return exec
    .select({ id: tasks.id })
    .from(tasks)
    .where(compactable(finishedBefore))
    .orderBy(asc(tasks.finishedAt), asc(tasks.id))
    .limit(limit);
}

export interface CompactionPassOptions {
  /** Replaces the retention cutoff (a pass asked for by hand). */
  finishedBefore?: Date;
  /** Checked before each task: true stops the pass there (the worker is stopping). */
  stop?: () => boolean;
}

/**
 * One compaction pass: at most `compactionMaxTasks` tasks, starting none
 * after `compactionMaxMs`, each in its own transaction. On PGlite the space
 * is reclaimed afterwards with `VACUUM task_events`; on PostgreSQL
 * autovacuum reuses it.
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
  };
  const finishedBefore = options.finishedBefore ?? retentionCutoff(ctx);
  if (!finishedBefore) return pass;
  const started = Date.now();
  const { compactionMaxTasks: maxTasks, compactionMaxMs: maxMs } = ctx.config;
  const candidates = await compactionCandidates(
    ctx.db,
    finishedBefore,
    maxTasks + 1,
  );
  let tried = 0;
  for (const candidate of candidates.slice(0, maxTasks)) {
    if (Date.now() - started >= maxMs || options.stop?.()) break;
    tried += 1;
    const done = await ctx.db.transaction((tx) =>
      compactTask(tx, ctx, candidate.id, finishedBefore),
    );
    if (!done) continue;
    pass.tasks.push(done);
    pass.removed += done.removed;
    pass.stripped += done.stripped;
  }
  pass.more = candidates.length > tried;
  ctx.metrics.eventsCompacted(pass.removed, pass.stripped);
  if (pass.removed > 0 && ctx.dbMode === "pglite")
    await ctx.db.execute(sql`vacuum task_events`).catch((error: unknown) =>
      ctx.logger.warn("Vacuuming task_events after compaction failed", {
        error: errorMessage(error),
      }),
    );
  const line = pass.tasks.length > 0 ? ctx.logger.info : ctx.logger.debug;
  line?.call(
    ctx.logger,
    `Compacted the events of ${pass.tasks.length} task(s)`,
    {
      tasks: pass.tasks.length,
      taskIds: pass.tasks.map((task) => task.taskId),
      removed: pass.removed,
      stripped: pass.stripped,
      more: pass.more,
    },
  );
  return pass;
}
