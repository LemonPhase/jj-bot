import { z } from "zod";
import { apiErrorCodeSchema } from "./api";
import { refineOneLine } from "./bots";
import {
  hasSomeField,
  idSchema,
  SOME_FIELD_REQUIRED,
  timestampSchema,
} from "./common";
import { canonicalTimeZone, cronFires, cronInstants, parseCron } from "./cron";
import { TEMPLATE_INSTRUCTIONS_LIMIT } from "./templates";

/**
 * Schedules: a task template started on a cron schedule in a time zone, by
 * the worker's scheduler. A start is the template's start (`templateTaskCommand`)
 * with the schedule's instructions, so a scheduled task is the task a manual
 * start makes, with `scheduleId` set. Schedules are the user's: no agent tool
 * lists, creates or edits them, so a task cannot schedule more work.
 */

/** Most schedules a server keeps; a save past it answers CONFLICT. */
export const MAX_SCHEDULES = 50;
/** Most enabled schedules; enabling one past it answers CONFLICT. */
export const MAX_ENABLED_SCHEDULES = 20;
/** How far ahead the schedule functions look, in days. */
export const SCHEDULE_LOOKAHEAD_DAYS = 366;
/** Fires `GET /api/schedules/:id` returns, newest first. */
export const SCHEDULE_FIRES_SHOWN = 50;
/** Fires the server keeps per schedule; older ones are deleted. */
export const SCHEDULE_FIRES_KEPT = 200;
/** Longest schedule name, in UTF-16 code units. */
export const SCHEDULE_NAME_LIMIT = 80;
/** Finished scheduled tasks whose workspaces a schedule keeps, by default. */
export const DEFAULT_KEEP_WORKSPACES = 10;
export const MAX_KEEP_WORKSPACES = 50;
/** The scheduler's minimum interval bounds, in minutes (`JJ_SCHEDULE_MIN_INTERVAL_MINUTES`). */
export const SCHEDULE_MIN_INTERVAL_BOUNDS = { min: 15, max: 1440 } as const;
/**
 * Clients warn that schedules may not fire once the scheduler's last pass
 * (`scheduler.lastPassAt`) is older than this; a running worker passes every
 * 30 seconds.
 */
export const SCHEDULER_STALE_MS = 2 * 60_000;

const DAY_MS = 24 * 60 * 60_000;
const LOOKAHEAD_MS = SCHEDULE_LOOKAHEAD_DAYS * DAY_MS;

/**
 * A 5-field cron expression (see `cron.ts` for the grammar). Stored as
 * written, trimmed, with its fields separated by single spaces.
 */
export const cronSchema = z
  .string()
  .max(200)
  .transform((cron) => cron.trim().split(/\s+/).join(" "))
  .superRefine((cron, context) => {
    const parsed = parseCron(cron);
    if (!parsed.ok)
      context.addIssue({ code: "custom", message: parsed.problem });
  });

/** An IANA time zone name this runtime knows, stored in its canonical form. */
export const timeZoneSchema = z
  .string()
  .max(64)
  .transform((name, context) => {
    const canonical = canonicalTimeZone(name);
    if (canonical === undefined) {
      context.addIssue({
        code: "custom",
        message: `"${name.trim()}" is not a time zone this server knows; use an IANA name such as Europe/London.`,
      });
      return z.NEVER;
    }
    return canonical;
  });

/**
 * When a schedule fires, discriminated on `kind`. Version 1 has only `cron`:
 * the expression read on the zone's wall clock.
 */
export const scheduleTriggerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cron"),
    cron: cronSchema,
    timeZone: timeZoneSchema,
  }),
]);

/**
 * A trigger as records carry it, checked by its writer: the read side does
 * not parse the expression or the zone again, so a zone this runtime's ICU
 * does not know still reads.
 */
export const storedTriggerSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("cron"),
    cron: z.string().min(1),
    timeZone: z.string().min(1),
  }),
]);

/**
 * The instants a trigger fires at strictly after `after`, ascending, at most
 * `n` of them, looking SCHEDULE_LOOKAHEAD_DAYS ahead. Empty for an
 * expression that does not parse or never fires in that window. Throws a
 * RangeError for a zone this runtime does not know.
 */
export function nextFires(
  trigger: StoredTrigger,
  after: Date,
  n: number,
): Date[] {
  const parsed = parseCron(trigger.cron);
  if (!parsed.ok || n <= 0) return [];
  const fires: Date[] = [];
  const from = after.getTime();
  for (const instant of cronInstants(
    parsed.fields,
    trigger.timeZone,
    from,
    from + LOOKAHEAD_MS,
  )) {
    fires.push(new Date(instant));
    if (fires.length >= n) break;
  }
  return fires;
}

/**
 * The fires strictly after `after` and at most `until`, ascending, at most
 * `limit` of them; for counting what a stopped scheduler missed.
 */
export function firesBetween(
  trigger: StoredTrigger,
  after: Date,
  until: Date,
  limit: number,
): Date[] {
  const parsed = parseCron(trigger.cron);
  if (!parsed.ok) return [];
  const fires: Date[] = [];
  for (const instant of cronInstants(
    parsed.fields,
    trigger.timeZone,
    after.getTime(),
    until.getTime(),
  )) {
    fires.push(new Date(instant));
    if (fires.length >= limit) break;
  }
  return fires;
}

/**
 * The shortest time between two consecutive fires in the
 * SCHEDULE_LOOKAHEAD_DAYS after `from`, in whole minutes, measured on the
 * zone's wall clock as the schedule is; null when it fires fewer than twice
 * in that window. A daylight-saving change can bring two runs closer in
 * real time once: `30 * * * *` runs at 00:30 and, since 01:30 is skipped,
 * at the end of the gap, 30 minutes later; on the wall clock they are an
 * hour apart, as on every other day.
 */
export function minimumGapMinutes(
  trigger: StoredTrigger,
  from: Date,
): number | null {
  const parsed = parseCron(trigger.cron);
  if (!parsed.ok) return null;
  let previous: number | undefined;
  let shortest: number | undefined;
  const start = from.getTime();
  for (const { wall } of cronFires(
    parsed.fields,
    trigger.timeZone,
    start,
    start + LOOKAHEAD_MS,
  )) {
    if (previous !== undefined) {
      const gap = wall - previous;
      if (shortest === undefined || gap < shortest) shortest = gap;
      // Wall times are whole minutes apart at least: nothing is shorter.
      if (shortest <= 60_000) break;
    }
    previous = wall;
  }
  return shortest === undefined ? null : Math.floor(shortest / 60_000);
}

/**
 * Why a trigger cannot be saved, in one sentence, or undefined when it can:
 * an expression that does not parse, a zone this runtime does not know, no
 * fire in the next SCHEDULE_LOOKAHEAD_DAYS, or two consecutive fires closer
 * than `minIntervalMinutes`. The editor previews with it; the server
 * refuses a save with it (VALIDATION_FAILED).
 */
export function triggerProblem(
  trigger: StoredTrigger,
  from: Date,
  minIntervalMinutes: number,
): string | undefined {
  const parsed = parseCron(trigger.cron);
  if (!parsed.ok) return parsed.problem;
  if (canonicalTimeZone(trigger.timeZone) === undefined)
    return `"${trigger.timeZone}" is not a time zone this server knows; use an IANA name such as Europe/London.`;
  if (nextFires(trigger, from, 1).length === 0)
    return `This schedule never runs in the next ${SCHEDULE_LOOKAHEAD_DAYS} days.`;
  const gap = minimumGapMinutes(trigger, from);
  if (gap !== null && gap < minIntervalMinutes)
    return `This schedule runs ${gap} minute${gap === 1 ? "" : "s"} apart at times, under this server's minimum of ${minIntervalMinutes} minutes between runs.`;
  return undefined;
}

/**
 * A fire's time on the schedule's wall clock, for the brief and the UI:
 * `2026-11-04 09:00 Europe/London`.
 */
export function formatFireTime(instant: Date, timeZone: string): string {
  const parts: Record<string, string> = {};
  for (const part of new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(instant))
    parts[part.type] = part.value;
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${timeZone}`;
}

/**
 * - `started`: a task was started for the due time (`taskId`).
 * - `skipped`: the schedule's previous task had not finished (queued,
 *   running, waiting or stopping); `taskId` names it.
 * - `missed`: the scheduler did not run within the grace of the due time
 *   (`missedCount` due times share the row).
 * - `refused`: the start was refused (`code`, `details`): a spend cap, or a
 *   template that cannot start, which also pauses the schedule.
 */
export const SCHEDULE_FIRE_OUTCOMES = [
  "started",
  "skipped",
  "missed",
  "refused",
] as const;
export const scheduleFireOutcomeSchema = z.enum(SCHEDULE_FIRE_OUTCOMES);

/** What the scheduler did about one due time of a schedule. */
export const scheduleFireSchema = z.object({
  id: idSchema,
  scheduleId: idSchema,
  /** The due time; for a `missed` row covering several, the first of them. */
  scheduledFor: timestampSchema,
  recordedAt: timestampSchema,
  outcome: scheduleFireOutcomeSchema,
  /** One line saying why, for `skipped`, `missed` and `refused`; null for `started`. */
  reason: z.string().nullable(),
  /** Due times a `missed` row covers; 0 for the other outcomes. */
  missedCount: z.number().int().nonnegative(),
  /** The task `started` started, or the unfinished one `skipped` waited on. */
  taskId: idSchema.nullable(),
  /** A refusal's error code, such as SPEND_CAP_REACHED; null otherwise. */
  code: apiErrorCodeSchema.nullable().default(null),
  /** A refusal's error details, as the API answers them (`SpendCapReachedDetails` for a cap). */
  details: z.unknown().optional(),
});

/** Why the server paused a schedule: its template could not start at a due time. */
export const schedulePausedReasonSchema = z.enum(["template_unusable"]);

/**
 * Which task updates a scheduled task's coordinator tells its direct chat:
 * `attention` only when the task needs the user (a question, an approval, a
 * spend cap) or fails; `all` also when it completes, like any task.
 */
export const chatUpdatesSchema = z.enum(["attention", "all"]);

const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(SCHEDULE_NAME_LIMIT)
  .superRefine(refineOneLine("A schedule name"));
const instructionsSchema = z.string().trim().max(TEMPLATE_INSTRUCTIONS_LIMIT);
const keepWorkspacesSchema = z.number().int().min(0).max(MAX_KEEP_WORKSPACES);

export const scheduleSchema = z.object({
  id: idSchema,
  /** One line of plain text: it appears in the scheduled task's brief. */
  name: nameSchema,
  templateId: idSchema,
  trigger: storedTriggerSchema,
  /** Added to the template's goal for every run (`templateRunGoal`); empty for none. */
  instructions: z.string().max(TEMPLATE_INSTRUCTIONS_LIMIT).default(""),
  enabled: z.boolean(),
  /** A due time while the previous task has not finished is skipped. The only policy. */
  overlap: z.literal("skip").default("skip"),
  /**
   * The schedule's finished tasks that keep their `task` workspace, newest
   * first; when a fire starts, older ones are removed through the sandbox
   * driver (their artifacts, transcripts and task log stay).
   */
  keepWorkspaces: keepWorkspacesSchema.default(DEFAULT_KEEP_WORKSPACES),
  chatUpdates: chatUpdatesSchema.default("attention"),
  /** The next due time; null while disabled or with no fire in the lookahead. */
  nextFireAt: timestampSchema.nullable(),
  /** Set when the server disabled the schedule; cleared by enabling it again. */
  pausedReason: schedulePausedReasonSchema.nullable().default(null),
  /** The latest fire, by due time. */
  lastFire: scheduleFireSchema.nullable().default(null),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

/**
 * `POST /api/schedules`. A save answers VALIDATION_FAILED for a bad cron or
 * zone, a cron that never fires in the lookahead, a gap under the server's
 * minimum interval, or a template that is unknown or whose task cap resolves
 * to none; CONFLICT past MAX_SCHEDULES, or past MAX_ENABLED_SCHEDULES
 * enabled.
 */
export const createScheduleCommandSchema = z.object({
  name: nameSchema,
  templateId: idSchema,
  trigger: scheduleTriggerSchema,
  instructions: instructionsSchema.optional(),
  /** Default true. */
  enabled: z.boolean().optional(),
  overlap: z.literal("skip").optional(),
  keepWorkspaces: keepWorkspacesSchema.optional(),
  chatUpdates: chatUpdatesSchema.optional(),
});

/** The update command without its at-least-one-field refinement. */
export const updateScheduleCommandObjectSchema =
  createScheduleCommandSchema.partial();

/**
 * `PATCH /api/schedules/:id`: the patch merged onto the stored schedule and
 * checked as a save. Every edit (enabling included) computes the next fire
 * from now: nothing missed is started afterwards.
 */
export const updateScheduleCommandSchema =
  updateScheduleCommandObjectSchema.refine(hasSomeField, SOME_FIELD_REQUIRED);

/** The scheduler's state, for the stale-scheduler warning and the editor's checks. */
export const schedulerStatusSchema = z.object({
  /** When a worker last ran a scheduler pass; null before the first. */
  lastPassAt: timestampSchema.nullable(),
  /** The least time allowed between two runs of a schedule (`JJ_SCHEDULE_MIN_INTERVAL_MINUTES`). */
  minIntervalMinutes: z.number().int().positive(),
  /** How late a due time may still start a task (`JJ_SCHEDULE_GRACE_MINUTES`). */
  graceMinutes: z.number().int().positive(),
});

/** `GET /api/schedules`, oldest first. */
export const scheduleListSchema = z.object({
  schedules: z.array(scheduleSchema),
  scheduler: schedulerStatusSchema,
});
/** `POST` and `PATCH` of one schedule. */
export const scheduleResultSchema = z.object({ schedule: scheduleSchema });
/** `GET /api/schedules/:id`: the schedule and its latest SCHEDULE_FIRES_SHOWN fires, newest first. */
export const scheduleDetailSchema = z.object({
  schedule: scheduleSchema,
  fires: z.array(scheduleFireSchema).max(SCHEDULE_FIRES_SHOWN),
});

/** `TEMPLATE_IN_USE`'s `details`: the schedules that start the template. */
export const templateInUseDetailsSchema = z.object({
  schedules: z.array(z.object({ id: idSchema, name: z.string() })).min(1),
});

export type ScheduleTrigger = z.output<typeof scheduleTriggerSchema>;
export type StoredTrigger = z.infer<typeof storedTriggerSchema>;
export type ScheduleFireOutcome = z.infer<typeof scheduleFireOutcomeSchema>;
export type ScheduleFire = z.infer<typeof scheduleFireSchema>;
export type SchedulePausedReason = z.infer<typeof schedulePausedReasonSchema>;
export type ChatUpdates = z.infer<typeof chatUpdatesSchema>;
export type Schedule = z.infer<typeof scheduleSchema>;
export type CreateScheduleCommand = z.input<typeof createScheduleCommandSchema>;
export type UpdateScheduleCommand = z.input<typeof updateScheduleCommandSchema>;
export type SchedulerStatus = z.infer<typeof schedulerStatusSchema>;
export type ScheduleList = z.infer<typeof scheduleListSchema>;
export type ScheduleDetail = z.infer<typeof scheduleDetailSchema>;
export type TemplateInUseDetails = z.infer<typeof templateInUseDetailsSchema>;
