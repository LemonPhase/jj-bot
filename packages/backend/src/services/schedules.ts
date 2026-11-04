// Schedules: task templates started on a cron schedule in a time zone. This
// module holds the user's side (list, save, edit, delete) and the checks a
// save makes; the worker's scheduler (worker/scheduler.ts) starts them.
// Schedules are the user's: no agent tool lists, creates or edits them.
import {
  type CreateScheduleCommand,
  createScheduleCommandSchema,
  MAX_ENABLED_SCHEDULES,
  MAX_SCHEDULES,
  nextFires,
  SCHEDULE_FIRES_SHOWN,
  type Schedule,
  type ScheduleDetail,
  type SchedulerStatus,
  type StoredTrigger,
  triggerProblem,
  type UpdateScheduleCommand,
  updateScheduleCommandSchema,
} from "@jj/contracts";
import {
  type Executor,
  readInstanceSetting,
  type ScheduleFireRow,
  type ScheduleRow,
  scheduleFires,
  schedules,
  type Tx,
  taskTemplates,
} from "@jj/db";
import { and, asc, count, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { EngineContext } from "../context";
import { DomainError, notFound, parseCommand } from "../errors";
import { hint } from "../events";
import { toSchedule, toScheduleFire } from "../records";
import { templateTaskCap } from "./templates";

/** The instance setting holding when a worker last ran a scheduler pass. */
export const SCHEDULER_PASS_KEY = "scheduler.last_pass_at";

/** Each schedule's latest fire by due time. */
async function latestFires(
  exec: Executor,
  scheduleIds: string[],
): Promise<Map<string, ScheduleFireRow>> {
  if (scheduleIds.length === 0) return new Map();
  const rows = await exec
    .selectDistinctOn([scheduleFires.scheduleId])
    .from(scheduleFires)
    .where(inArray(scheduleFires.scheduleId, scheduleIds))
    .orderBy(
      scheduleFires.scheduleId,
      desc(scheduleFires.scheduledFor),
      desc(scheduleFires.recordedAt),
    );
  return new Map(rows.map((row) => [row.scheduleId, row]));
}

/** Rows with their latest fires, as the contract shapes them. */
export async function withLastFires(
  exec: Executor,
  rows: ScheduleRow[],
): Promise<Schedule[]> {
  const fires = await latestFires(
    exec,
    rows.map((row) => row.id),
  );
  return rows.map((row) => toSchedule(row, fires.get(row.id) ?? null));
}

async function scheduleRow(
  exec: Executor,
  scheduleId: string,
  lock = false,
): Promise<ScheduleRow> {
  const query = exec
    .select()
    .from(schedules)
    .where(eq(schedules.id, scheduleId));
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw notFound("Schedule", scheduleId);
  return row;
}

/** The scheduler's state: its last pass and the server's settings. */
export async function schedulerStatus(
  ctx: EngineContext,
): Promise<SchedulerStatus> {
  const stored = await readInstanceSetting(ctx.db, SCHEDULER_PASS_KEY);
  const lastPass = stored ? new Date(stored) : undefined;
  return {
    lastPassAt:
      lastPass && !Number.isNaN(lastPass.getTime())
        ? lastPass.toISOString()
        : null,
    minIntervalMinutes: ctx.config.scheduleMinIntervalMinutes,
    graceMinutes: ctx.config.scheduleGraceMinutes,
  };
}

/** `GET /api/schedules`, oldest first, with the scheduler's state. */
export async function listSchedules(ctx: EngineContext): Promise<{
  schedules: Schedule[];
  scheduler: SchedulerStatus;
}> {
  const rows = await ctx.db
    .select()
    .from(schedules)
    .orderBy(asc(schedules.createdAt), asc(schedules.id));
  return {
    schedules: await withLastFires(ctx.db, rows),
    scheduler: await schedulerStatus(ctx),
  };
}

/** `GET /api/schedules/:id`: the schedule and its latest fires, newest first. */
export async function getSchedule(
  ctx: EngineContext,
  scheduleId: string,
): Promise<ScheduleDetail> {
  const row = await scheduleRow(ctx.db, scheduleId);
  const fires = await ctx.db
    .select()
    .from(scheduleFires)
    .where(eq(scheduleFires.scheduleId, scheduleId))
    .orderBy(desc(scheduleFires.scheduledFor), desc(scheduleFires.recordedAt))
    .limit(SCHEDULE_FIRES_SHOWN);
  return {
    schedule: toSchedule(row, fires[0] ?? null),
    fires: fires.map(toScheduleFire),
  };
}

interface Draft {
  name: string;
  templateId: string;
  trigger: StoredTrigger;
  instructions: string;
  enabled: boolean;
  keepWorkspaces: number;
  chatUpdates: "attention" | "all";
}

/**
 * The checks every save makes, in the save's transaction: the trigger
 * (`triggerProblem` against the server's minimum interval), the template
 * (it exists, and its task cap resolves to an amount), and the limits
 * (MAX_SCHEDULES, MAX_ENABLED_SCHEDULES). Returns the next fire.
 */
async function checkSave(
  tx: Tx,
  ctx: EngineContext,
  draft: Draft,
  existingId: string | undefined,
): Promise<Date | null> {
  const now = ctx.clock();
  const problem = triggerProblem(
    draft.trigger,
    now,
    ctx.config.scheduleMinIntervalMinutes,
  );
  if (problem)
    throw new DomainError("VALIDATION_FAILED", `trigger: ${problem}`, {
      field: "trigger",
    });
  // Shared: a delete of the template waits for this save, then sees it.
  const [template] = await tx
    .select()
    .from(taskTemplates)
    .where(eq(taskTemplates.id, draft.templateId))
    .for("share");
  if (!template)
    throw new DomainError(
      "VALIDATION_FAILED",
      `templateId: unknown task template ${draft.templateId}.`,
      { field: "templateId" },
    );
  if ((await templateTaskCap(tx, template)) === null)
    throw new DomainError(
      "VALIDATION_FAILED",
      `templateId: "${template.title}" starts tasks with no spend cap, and a scheduled task needs one. Give the template a cap, or its coordinator's runtime profile a task cap.`,
      { field: "templateId" },
    );
  // Concurrent saves count one at a time, so the limits hold.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext('jj-bot:schedules'))`,
  );
  const others = existingId ? ne(schedules.id, existingId) : undefined;
  if (!existingId) {
    const [stored] = await tx.select({ value: count() }).from(schedules);
    if ((stored?.value ?? 0) >= MAX_SCHEDULES)
      throw new DomainError(
        "CONFLICT",
        `This server keeps at most ${MAX_SCHEDULES} schedules; delete one before saving another.`,
        { limit: MAX_SCHEDULES },
      );
  }
  if (draft.enabled) {
    const [enabled] = await tx
      .select({ value: count() })
      .from(schedules)
      .where(and(eq(schedules.enabled, true), others));
    if ((enabled?.value ?? 0) >= MAX_ENABLED_SCHEDULES)
      throw new DomainError(
        "CONFLICT",
        `At most ${MAX_ENABLED_SCHEDULES} schedules can be enabled at once; disable one first.`,
        { limit: MAX_ENABLED_SCHEDULES },
      );
  }
  return draft.enabled ? (nextFires(draft.trigger, now, 1)[0] ?? null) : null;
}

/** `POST /api/schedules`. */
export async function createSchedule(
  ctx: EngineContext,
  input: CreateScheduleCommand,
): Promise<{ schedule: Schedule }> {
  const command = parseCommand(createScheduleCommandSchema, input);
  const draft: Draft = {
    name: command.name,
    templateId: command.templateId,
    trigger: command.trigger,
    instructions: command.instructions ?? "",
    enabled: command.enabled ?? true,
    keepWorkspaces: command.keepWorkspaces ?? 10,
    chatUpdates: command.chatUpdates ?? "attention",
  };
  const row = await ctx.db.transaction(async (tx) => {
    const nextFireAt = await checkSave(tx, ctx, draft, undefined);
    const now = ctx.clock();
    const [inserted] = await tx
      .insert(schedules)
      .values({
        id: ctx.ids("schedule"),
        ...draft,
        trigger: draft.trigger as unknown as Record<string, unknown>,
        overlap: "skip",
        nextFireAt,
        pausedReason: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!inserted) throw new Error("The schedule insert returned no row.");
    await hint(tx, { type: "schedules.changed" });
    return inserted;
  });
  return { schedule: toSchedule(row, null) };
}

/**
 * `PATCH /api/schedules/:id`: the patch merged onto the stored schedule and
 * checked as a save. Every edit computes the next fire from now, so nothing
 * missed while it was disabled or due starts afterwards; enabling clears a
 * pause.
 */
export async function updateSchedule(
  ctx: EngineContext,
  scheduleId: string,
  input: UpdateScheduleCommand,
): Promise<{ schedule: Schedule }> {
  const command = parseCommand(updateScheduleCommandSchema, input);
  const row = await ctx.db.transaction(async (tx) => {
    const current = await scheduleRow(tx, scheduleId, true);
    const draft: Draft = {
      name: command.name ?? current.name,
      templateId: command.templateId ?? current.templateId,
      trigger: command.trigger ?? (current.trigger as unknown as StoredTrigger),
      instructions: command.instructions ?? current.instructions,
      enabled: command.enabled ?? current.enabled,
      keepWorkspaces: command.keepWorkspaces ?? current.keepWorkspaces,
      chatUpdates: command.chatUpdates ?? current.chatUpdates,
    };
    const nextFireAt = await checkSave(tx, ctx, draft, scheduleId);
    const [updated] = await tx
      .update(schedules)
      .set({
        ...draft,
        trigger: draft.trigger as unknown as Record<string, unknown>,
        nextFireAt,
        pausedReason: command.enabled === true ? null : current.pausedReason,
        updatedAt: ctx.clock(),
      })
      .where(eq(schedules.id, scheduleId))
      .returning();
    if (!updated) throw notFound("Schedule", scheduleId);
    await hint(tx, { type: "schedules.changed" });
    return updated;
  });
  const [schedule] = await withLastFires(ctx.db, [row]);
  return { schedule: schedule as Schedule };
}

/** `DELETE /api/schedules/:id`, with its fires. Its tasks keep running and keep their `scheduleId`. */
export async function deleteSchedule(
  ctx: EngineContext,
  scheduleId: string,
): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(schedules)
      .where(eq(schedules.id, scheduleId))
      .returning({ id: schedules.id });
    if (!deleted) throw notFound("Schedule", scheduleId);
    await hint(tx, { type: "schedules.changed" });
  });
}
