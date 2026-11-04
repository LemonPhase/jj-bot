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
  firesBetween,
  formatFireTime,
  minimumGapMinutes,
  nextFires,
  SCHEDULE_FIRES_KEPT,
  type ScheduleFireOutcome,
  type StoredTrigger,
} from "@jj/contracts";
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
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notInArray,
  or,
} from "drizzle-orm";
import type { EngineContext } from "../context";
import { DomainError, errorMessage } from "../errors";
import { emit, hint } from "../events";
import { SCHEDULER_PASS_KEY } from "../services/schedules";
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
    outcomes.push({ scheduleId: handled.scheduleId, outcome: handled.outcome });
    if (handled.outcome === "started")
      await trimWorkspaces(ctx, handled, options.holds ?? (() => false)).catch(
        (error: unknown) =>
          ctx.logger.warn(
            `Removing old workspaces of schedule ${handled.scheduleId} failed`,
            { error: errorMessage(error) },
          ),
      );
  }
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
  outcome: ScheduleFireOutcome;
  keepWorkspaces: number;
}

interface Fire {
  outcome: ScheduleFireOutcome;
  reason?: string;
  taskId?: string;
  code?: string;
  details?: unknown;
  /** The template cannot start: the schedule is paused. */
  pause?: boolean;
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
    await record(tx, ctx, schedule, first, {
      outcome: "refused",
      code: "VALIDATION_FAILED",
      reason: `The schedule's times cannot be computed: ${errorMessage(error)}`,
    });
    await settle(tx, ctx, schedule, { next: null, pause: false });
    return { scheduleId: schedule.id, outcome: "refused", keepWorkspaces: 0 };
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
      first,
      {
        outcome: "missed",
        reason: `The scheduler did not run within ${graceMinutes} minutes of ${
          missed.length === 1 ? "this time" : `these ${missed.length} times`
        }: the server or its worker was not running.`,
      },
      missed.length,
    );
  let fire: Fire = { outcome: "missed" };
  if (!late) {
    fire = await fireDue(tx, ctx, schedule, trigger, latest);
    await record(tx, ctx, schedule, latest, fire);
  }
  await settle(tx, ctx, schedule, { next, pause: fire.pause === true });
  return {
    scheduleId: schedule.id,
    outcome: fire.outcome,
    keepWorkspaces: schedule.keepWorkspaces,
  };
}

/** What the scheduler does about the latest due time, inside the pass's transaction. */
async function fireDue(
  tx: Tx,
  ctx: EngineContext,
  schedule: ScheduleRow,
  trigger: StoredTrigger,
  dueAt: Date,
): Promise<Fire> {
  const minimum = ctx.config.scheduleMinIntervalMinutes;
  const gap = minimumGapMinutes(trigger, dueAt);
  if (gap !== null && gap < minimum)
    return {
      outcome: "refused",
      code: "VALIDATION_FAILED",
      reason: `The schedule runs ${gap} minutes apart at times, under this server's minimum of ${minimum} minutes between runs; change its times.`,
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
      pause: true,
    };
  if ((await templateTaskCap(tx, template)) === null)
    return {
      outcome: "refused",
      code: "VALIDATION_FAILED",
      reason: `"${template.title}" would start a task with no spend cap, and a scheduled task needs one. Give the template or its coordinator's runtime profile a task cap, then enable the schedule again.`,
      pause: true,
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
      pause: error.code !== "SPEND_CAP_REACHED",
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
): Promise<void> {
  await tx.insert(scheduleFires).values({
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
}

/** Moves the schedule past now (or pauses it), keeps its newest fires, and sends the hint. */
async function settle(
  tx: Tx,
  ctx: EngineContext,
  schedule: ScheduleRow,
  { next, pause }: { next: Date | null; pause: boolean },
): Promise<void> {
  await tx
    .update(schedules)
    .set(
      pause
        ? {
            enabled: false,
            pausedReason: "template_unusable",
            nextFireAt: null,
          }
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
 * Keeps the `task` workspaces of the schedule's newest `keepWorkspaces`
 * finished tasks and removes the older ones' through the sandbox drivers.
 * Artifacts, transcripts and the task log stay. Each removal is marked on
 * the task first, under its lock and only while it is finished with nothing
 * queued or running, so a continuation after the mark knows it starts on a
 * fresh workspace; a removal that fails clears the mark again for a later
 * fire to retry.
 */
async function trimWorkspaces(
  ctx: EngineContext,
  handled: Handled,
  holds: (taskId: string) => boolean,
): Promise<void> {
  const finished = await ctx.db
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.scheduleId, handled.scheduleId),
        inArray(tasks.status, [...FINISHED_TASK_STATUSES]),
        isNull(tasks.workspaceRemovedAt),
      ),
    )
    .orderBy(desc(tasks.createdAt), desc(tasks.id));
  const removable = finished.slice(handled.keepWorkspaces);
  if (removable.length === 0) return;
  const infos = await ctx.drivers.list();
  const drivers = ctx.drivers
    .all()
    .filter(
      (driver) =>
        driver.removeWorkspace &&
        infos.some((info) => info.id === driver.id && info.available),
    );
  if (drivers.length === 0) return;
  for (const { id } of removable) {
    if (holds(id)) continue;
    const marked = await ctx.db.transaction(async (tx) => {
      const task = await lockTask(tx, id);
      if (
        !task ||
        task.workspaceRemovedAt ||
        !(FINISHED_TASK_STATUSES as readonly string[]).includes(task.status)
      )
        return undefined;
      const [active] = await tx
        .select({ value: count() })
        .from(jobs)
        .where(
          and(eq(jobs.taskId, id), inArray(jobs.status, ["queued", "running"])),
        );
      if ((active?.value ?? 0) > 0) return undefined;
      const at = ctx.clock();
      await tx
        .update(tasks)
        .set({ workspaceRemovedAt: at })
        .where(eq(tasks.id, id));
      return at;
    });
    if (!marked) continue;
    let removed = false;
    let failure: unknown;
    for (const driver of drivers)
      try {
        const result = await driver.removeWorkspace?.({
          mode: "task",
          workspaceKey: id,
        });
        removed ||= result?.removed === true;
      } catch (error) {
        failure ??= error;
      }
    await ctx.db.transaction(async (tx) => {
      await lockTask(tx, id);
      if (failure)
        await tx
          .update(tasks)
          .set({ workspaceRemovedAt: null })
          .where(and(eq(tasks.id, id), eq(tasks.workspaceRemovedAt, marked)));
      if (removed)
        await emit(tx, id, {
          type: "workspace.removed",
          payload: {
            scheduleId: handled.scheduleId,
            keepWorkspaces: handled.keepWorkspaces,
          },
        });
    });
    if (failure)
      ctx.logger.warn(`Removing the workspace of task ${id} failed`, {
        error: errorMessage(failure),
      });
  }
}
