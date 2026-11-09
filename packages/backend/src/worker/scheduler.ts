// The scheduler pass. The worker runs it when it starts and every
// `schedulerIntervalMs` (30 s): it records when it ran (`lastPassAt`), then
// takes each due schedule (enabled, `next_fire_at` passed) with
// `FOR UPDATE SKIP LOCKED`, one per transaction, so concurrent passes on
// several workers never take the same one and never wait on each other.
//
// In that transaction it handles the schedule's latest due time, records the
// earlier ones it missed, and moves `next_fire_at` past now. The task a fire
// starts and the fire's row (unique on the schedule and the due time) are
// written in that same transaction, so no due time starts two tasks, after a
// crash or a race included. Every time comes from the engine's clock.
import {
  FINISHED_TASK_STATUSES,
  SCHEDULE_FIRES_KEPT,
  type ScheduleFireOutcome,
  type SchedulePausedReason,
  type StoredTrigger,
} from "@jj/contracts";
import {
  firesBetween,
  formatFireTime,
  minimumGapMinutes,
  nextFires,
} from "@jj/contracts/schedule-rules";
import {
  approvals,
  jobs,
  type ScheduleRow,
  scheduleFires,
  schedules,
  type Tx,
  tasks,
  taskTemplates,
  writeInstanceSetting,
} from "@jj/db";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
} from "drizzle-orm";
import type { EngineContext } from "../context";
import { DomainError, errorMessage } from "../errors";
import { emit, hint } from "../events";
import {
  SCHEDULER_PASS_KEY,
  WORKSPACE_REMOVAL_STALE_MS,
  workspaceRemovalUnderWay,
} from "../services/schedules";
import { lockTask } from "../services/sessions";
import { startTemplateTx, templateTaskCap } from "../services/templates";

/** At most this many schedules are handled in one pass; the rest wait for the next. */
const FIRES_PER_PASS = 100;
/** Due times a stopped scheduler's missed row counts at most. */
const MISSED_COUNT_LIMIT = 100_000;

/** A task of the schedule that has not finished: a due time meanwhile is skipped. */
const OPEN_STATUSES = ["queued", "running", "waiting"] as const;

export interface SchedulerOptions {
  /** Whether this worker holds the task's sandbox, whose workspace is then not removed. */
  holds?: (taskId: string) => boolean;
}

export interface SchedulerPass {
  /** The fires recorded, one per schedule handled (a missed row of earlier due times aside). */
  outcomes: { scheduleId: string; outcome: ScheduleFireOutcome }[];
}

/**
 * One scheduler pass at the engine clock's now. Never throws for one
 * schedule: a schedule whose transaction fails is logged, left due and
 * retried by the next pass.
 */
export async function runSchedulerPass(
  ctx: EngineContext,
  options: SchedulerOptions = {},
): Promise<SchedulerPass> {
  const now = ctx.clock();
  await writeInstanceSetting(ctx.db, SCHEDULER_PASS_KEY, now.toISOString());
  const outcomes: SchedulerPass["outcomes"] = [];
  const failed: string[] = [];
  for (let index = 0; index < FIRES_PER_PASS; index += 1) {
    let picked: string | undefined;
    let handled: Handled | undefined;
    try {
      handled = await ctx.db.transaction(async (tx) => {
        const schedule = await nextDue(tx, now, failed);
        if (!schedule) return undefined;
        picked = schedule.id;
        return fireSchedule(tx, ctx, schedule, now);
      });
    } catch (error) {
      if (!picked) throw error;
      failed.push(picked);
      ctx.logger.warn(`The scheduler could not handle schedule ${picked}`, {
        error: errorMessage(error),
      });
      continue;
    }
    if (!handled) break;
    if (handled.outcome)
      outcomes.push({
        scheduleId: handled.scheduleId,
        outcome: handled.outcome,
      });
  }
  // Every pass, so a removal that could not happen then is retried.
  await trimWorkspaces(ctx, options.holds ?? (() => false)).catch(
    (error: unknown) =>
      ctx.logger.warn("Removing old workspaces of scheduled tasks failed", {
        error: errorMessage(error),
      }),
  );
  return { outcomes };
}

/** The earliest due schedule no other pass holds, locked. */
async function nextDue(
  tx: Tx,
  now: Date,
  skip: string[],
): Promise<ScheduleRow | undefined> {
  const [row] = await tx
    .select()
    .from(schedules)
    .where(
      and(
        eq(schedules.enabled, true),
        isNotNull(schedules.nextFireAt),
        lte(schedules.nextFireAt, now),
        skip.length > 0 ? notInArray(schedules.id, skip) : undefined,
      ),
    )
    .orderBy(asc(schedules.nextFireAt), asc(schedules.id))
    .limit(1)
    .for("update", { skipLocked: true });
  return row;
}

interface Handled {
  scheduleId: string;
  /** The latest due time's outcome; undefined when it was recorded already. */
  outcome?: ScheduleFireOutcome;
}

interface Fire {
  outcome: ScheduleFireOutcome;
  reason?: string;
  taskId?: string;
  code?: string;
  details?: unknown;
  /** Why the schedule is turned off with this fire, when it is. */
  pause?: SchedulePausedReason;
}

async function fireSchedule(
  tx: Tx,
  ctx: EngineContext,
  schedule: ScheduleRow,
  now: Date,
): Promise<Handled> {
  const trigger = schedule.trigger as unknown as StoredTrigger;
  const first = schedule.nextFireAt as Date;
  let due: Date[];
  let next: Date | null;
  try {
    due = [first, ...firesBetween(trigger, first, now, MISSED_COUNT_LIMIT)];
    next = nextFires(trigger, now, 1)[0] ?? null;
  } catch (error) {
    // The zone is unknown to this runtime's ICU now: nothing can be computed.
    const fire: Fire = {
      outcome: "refused",
      code: "VALIDATION_FAILED",
      reason: `The schedule's times cannot be computed: ${errorMessage(error)}`,
      pause: "no_next_fire",
    };
    await record(tx, ctx, schedule, first, fire, 0, true);
    await settle(tx, ctx, schedule, { next: null, pause: fire.pause });
    return { scheduleId: schedule.id, outcome: "refused" };
  }
  // A due time recorded already (an edit on a clock behind the worker's
  // can set one again) is not handled twice: the schedule moves past it.
  const recorded = new Set(
    (
      await tx
        .select({ at: scheduleFires.scheduledFor })
        .from(scheduleFires)
        .where(
          and(
            eq(scheduleFires.scheduleId, schedule.id),
            gte(scheduleFires.scheduledFor, first),
            lte(scheduleFires.scheduledFor, now),
          ),
        )
    ).map((row) => row.at.getTime()),
  );
  due = due.filter((at) => !recorded.has(at.getTime()));
  if (due.length === 0) {
    await settle(tx, ctx, schedule, nextOrPause(next));
    return { scheduleId: schedule.id };
  }
  const latest = due.at(-1) as Date;
  const graceMinutes = ctx.config.scheduleGraceMinutes;
  const late = now.getTime() - latest.getTime() > graceMinutes * 60_000;
  const missed = late ? due : due.slice(0, -1);
  if (missed.length > 0)
    await record(
      tx,
      ctx,
      schedule,
      missed[0] as Date,
      {
        outcome: "missed",
        reason: `The scheduler did not run within ${graceMinutes} minutes of ${
          missed.length === 1 ? "this time" : `these ${missed.length} times`
        }: the server or its worker was not running.`,
      },
      missed.length,
      true,
    );
  let fire: Fire = { outcome: "missed" };
  if (!late) {
    fire = await fireDue(tx, ctx, schedule, trigger, latest);
    // Strict: the unique key is what lets no due time start two tasks.
    await record(tx, ctx, schedule, latest, fire);
  }
  await settle(
    tx,
    ctx,
    schedule,
    fire.pause ? { next: null, pause: fire.pause } : nextOrPause(next),
  );
  return { scheduleId: schedule.id, outcome: fire.outcome };
}

/** The schedule's next fire, or a pause when none is found in the horizon. */
const nextOrPause = (
  next: Date | null,
): { next: Date | null; pause?: SchedulePausedReason } =>
  next ? { next } : { next: null, pause: "no_next_fire" };

/** What the scheduler does about the latest due time, inside the pass's transaction. */
async function fireDue(
  tx: Tx,
  ctx: EngineContext,
  schedule: ScheduleRow,
  trigger: StoredTrigger,
  dueAt: Date,
): Promise<Fire> {
  const minimum = ctx.config.scheduleMinIntervalMinutes;
  // From just before the due time, so the gap after it counts: a save
  // measures a year ahead, and a leap-day pair saved earlier shows only here.
  const gap = minimumGapMinutes(
    trigger,
    new Date(dueAt.getTime() - 1),
    minimum,
  );
  if (gap !== null && gap < minimum)
    return {
      outcome: "refused",
      code: "VALIDATION_FAILED",
      reason: `The schedule runs ${gap} minutes apart at times, under this server's minimum of ${minimum} minutes between runs; change its times, then turn it on again.`,
      pause: "interval_too_short",
    };
  const open = await openTask(tx, schedule.id);
  if (open) return { outcome: "skipped", taskId: open.id, reason: open.reason };
  const [template] = await tx
    .select()
    .from(taskTemplates)
    .where(eq(taskTemplates.id, schedule.templateId))
    .for("share");
  if (!template)
    return {
      outcome: "refused",
      code: "TEMPLATE_UNUSABLE",
      reason: "The schedule's template no longer exists.",
      pause: "template_unusable",
    };
  if ((await templateTaskCap(tx, template)) === null)
    return {
      outcome: "refused",
      code: "VALIDATION_FAILED",
      reason: `"${template.title}" would start a task with no spend cap, and a scheduled task needs one. Give the template or its coordinator's runtime profile a task cap, then turn the schedule on again.`,
      pause: "template_unusable",
    };
  try {
    // A savepoint: a refusal leaves nothing of the start behind.
    const task = await tx.transaction((start) =>
      startTemplateTx(
        start,
        ctx,
        template,
        schedule.instructions ? { instructions: schedule.instructions } : {},
        {
          id: schedule.id,
          chatUpdates: schedule.chatUpdates,
          note: `Started by schedule "${schedule.name}" for ${formatFireTime(
            dueAt,
            trigger.timeZone,
          )}; the user may not be watching.`,
        },
      ),
    );
    return { outcome: "started", taskId: task.id };
  } catch (error) {
    if (!(error instanceof DomainError)) throw error;
    return {
      outcome: "refused",
      code: error.code,
      reason: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
      // A cap lifts on its own or when raised; anything else is the template's.
      ...(error.code !== "SPEND_CAP_REACHED"
        ? { pause: "template_unusable" as const }
        : {}),
    };
  }
}

/** The schedule's newest task that has not finished, with why a due time waits for it. */
async function openTask(
  tx: Tx,
  scheduleId: string,
): Promise<{ id: string; reason: string } | undefined> {
  const [task] = await tx
    .select({
      id: tasks.id,
      status: tasks.status,
      cancelRequestedAt: tasks.cancelRequestedAt,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.scheduleId, scheduleId),
        or(
          inArray(tasks.status, [...OPEN_STATUSES]),
          and(
            isNotNull(tasks.cancelRequestedAt),
            ne(tasks.status, "cancelled"),
          ),
        ),
      ),
    )
    .orderBy(desc(tasks.createdAt), desc(tasks.id))
    .limit(1);
  if (!task) return undefined;
  const [held] = await tx
    .select({ value: count() })
    .from(approvals)
    .where(and(eq(approvals.taskId, task.id), eq(approvals.status, "pending")));
  const reason = task.cancelRequestedAt
    ? "The previous run is stopping."
    : (held?.value ?? 0) > 0
      ? "The previous run is waiting for your approval."
      : task.status === "waiting"
        ? "The previous run is waiting for you."
        : "The previous run has not finished.";
  return { id: task.id, reason };
}

async function record(
  tx: Tx,
  ctx: EngineContext,
  schedule: ScheduleRow,
  scheduledFor: Date,
  fire: Fire,
  missedCount = 0,
  /** Leave a row recorded already for that time as it is. */
  lenient = false,
): Promise<void> {
  const insert = tx.insert(scheduleFires).values({
    id: ctx.ids("scheduleFire"),
    scheduleId: schedule.id,
    scheduledFor,
    recordedAt: ctx.clock(),
    outcome: fire.outcome,
    reason: fire.reason ?? null,
    code: fire.code ?? null,
    details:
      fire.details !== undefined
        ? (JSON.parse(JSON.stringify(fire.details)) as Record<string, unknown>)
        : null,
    missedCount,
    taskId: fire.taskId ?? null,
  });
  await (lenient
    ? insert.onConflictDoNothing({
        target: [scheduleFires.scheduleId, scheduleFires.scheduledFor],
      })
    : insert);
}

/** Moves the schedule past now (or pauses it), keeps its newest fires, and sends the hint. */
async function settle(
  tx: Tx,
  ctx: EngineContext,
  schedule: ScheduleRow,
  { next, pause }: { next: Date | null; pause?: SchedulePausedReason },
): Promise<void> {
  await tx
    .update(schedules)
    .set(
      pause
        ? { enabled: false, pausedReason: pause, nextFireAt: null }
        : { nextFireAt: next },
    )
    .where(eq(schedules.id, schedule.id));
  const kept = tx
    .select({ id: scheduleFires.id })
    .from(scheduleFires)
    .where(eq(scheduleFires.scheduleId, schedule.id))
    .orderBy(desc(scheduleFires.scheduledFor), desc(scheduleFires.recordedAt))
    .limit(SCHEDULE_FIRES_KEPT);
  await tx
    .delete(scheduleFires)
    .where(
      and(
        eq(scheduleFires.scheduleId, schedule.id),
        notInArray(scheduleFires.id, kept),
      ),
    );
  await hint(tx, { type: "schedules.changed" });
}

/**
 * Keeps the `task` workspaces of each schedule's newest `keepWorkspaces`
 * finished tasks and removes the older ones through the driver that holds
 * each (`tasks.workspace_driver`). It runs every pass, so a removal that
 * could not happen (the driver unavailable or refusing, the sandbox held, a
 * job queued) is retried by a later pass. A task with no `task` workspace
 * (an ephemeral one, or none) is neither counted nor removed. Artifacts,
 * transcripts and the task log stay.
 *
 * A removal is claimed on the task (`workspace_removing_at`) under its lock,
 * only while it is finished with nothing queued or running; a continuation
 * meanwhile is refused. The removal is recorded (`workspace_removed_at`,
 * `workspace.removed`) only once the driver answers that it removed the
 * workspace; a failure releases the claim, and an answer that there was
 * none records nothing and forgets the task's driver, so it is not asked
 * again. A claim older than
 * WORKSPACE_REMOVAL_STALE_MS was lost by a worker that stopped: each pass
 * releases it first, whether or not the task is still one to remove.
 */
async function trimWorkspaces(
  ctx: EngineContext,
  holds: (taskId: string) => boolean,
): Promise<void> {
  await ctx.db
    .update(tasks)
    .set({ workspaceRemovingAt: null })
    .where(
      lt(
        tasks.workspaceRemovingAt,
        new Date(ctx.clock().getTime() - WORKSPACE_REMOVAL_STALE_MS),
      ),
    );
  const rows = await ctx.db
    .select({
      id: tasks.id,
      scheduleId: tasks.scheduleId,
      driver: tasks.workspaceDriver,
      keep: schedules.keepWorkspaces,
    })
    .from(tasks)
    .innerJoin(schedules, eq(schedules.id, tasks.scheduleId))
    .where(
      and(
        inArray(tasks.status, [...FINISHED_TASK_STATUSES]),
        isNotNull(tasks.workspaceDriver),
        isNull(tasks.workspaceRemovedAt),
      ),
    )
    .orderBy(asc(tasks.scheduleId), desc(tasks.createdAt), desc(tasks.id));
  const removable: typeof rows = [];
  const seen = new Map<string, number>();
  for (const row of rows) {
    const index = seen.get(row.scheduleId as string) ?? 0;
    seen.set(row.scheduleId as string, index + 1);
    if (index >= row.keep) removable.push(row);
  }
  if (removable.length === 0) return;
  const infos = await ctx.drivers.list();
  for (const row of removable) {
    const driver = ctx.drivers.get(row.driver as string);
    if (
      !driver?.removeWorkspace ||
      !infos.some((info) => info.id === driver.id && info.available) ||
      holds(row.id)
    )
      continue;
    const claimed = await ctx.db.transaction(async (tx) => {
      const task = await lockTask(tx, row.id);
      const now = ctx.clock();
      if (
        !task ||
        task.workspaceRemovedAt ||
        task.workspaceDriver !== driver.id ||
        !(FINISHED_TASK_STATUSES as readonly string[]).includes(task.status) ||
        workspaceRemovalUnderWay(task, now)
      )
        return undefined;
      const [active] = await tx
        .select({ value: count() })
        .from(jobs)
        .where(
          and(
            eq(jobs.taskId, row.id),
            inArray(jobs.status, ["queued", "running"]),
          ),
        );
      if ((active?.value ?? 0) > 0) return undefined;
      await tx
        .update(tasks)
        .set({ workspaceRemovingAt: now })
        .where(eq(tasks.id, row.id));
      return now;
    });
    if (!claimed) continue;
    let removed: boolean | undefined;
    let failure: unknown;
    try {
      ({ removed } = await driver.removeWorkspace({
        mode: "task",
        workspaceKey: row.id,
      }));
    } catch (error) {
      failure = error;
    }
    await ctx.db.transaction(async (tx) => {
      const task = await lockTask(tx, row.id);
      if (task?.workspaceRemovingAt?.getTime() !== claimed.getTime()) return;
      await tx
        .update(tasks)
        .set(
          failure
            ? { workspaceRemovingAt: null }
            : removed
              ? { workspaceRemovingAt: null, workspaceRemovedAt: ctx.clock() }
              : // The driver found none: nothing removed, nothing to keep or
                // ask about again until a sandbox makes one.
                { workspaceRemovingAt: null, workspaceDriver: null },
        )
        .where(eq(tasks.id, row.id));
      if (removed)
        await emit(tx, ctx, row.id, {
          type: "workspace.removed",
          payload: {
            scheduleId: row.scheduleId as string,
            keepWorkspaces: row.keep,
          },
        });
    });
    if (failure)
      ctx.logger.warn(
        `Removing the workspace of task ${row.id} failed; a later pass retries`,
        { error: errorMessage(failure) },
      );
  }
}
