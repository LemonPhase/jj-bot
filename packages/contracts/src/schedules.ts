import { z } from "zod";
import { apiErrorCodeSchema } from "./api";
import { refineOneLine } from "./bots";
import { idSchema, timestampSchema } from "./common";
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
/**
 * How far ahead `nextFires` looks, in days: 8 years and 6 days, so a
 * schedule on 29 February always finds its next fire, across a century
 * year that skips the leap day too. A trigger with no fire in it is refused.
 */
export const SCHEDULE_HORIZON_DAYS = 2928;
/** The window `minimumGapMinutes` measures consecutive fires over, in days. */
export const SCHEDULE_GAP_DAYS = 366;
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

/**
 * Why the server turned a schedule off at a due time, which the user's
 * next enabling clears:
 * - `template_unusable`: its template could not start (a problem, or a task
 *   cap that resolves to none);
 * - `interval_too_short`: its times are closer than the server's minimum
 *   interval, which was raised since the save;
 * - `no_next_fire`: no next time could be found (none in
 *   SCHEDULE_HORIZON_DAYS, or a zone this runtime no longer knows).
 */
export const SCHEDULE_PAUSED_REASONS = [
  "template_unusable",
  "interval_too_short",
  "no_next_fire",
] as const;
export const schedulePausedReasonSchema = z.enum(SCHEDULE_PAUSED_REASONS);

/**
 * Which task updates a scheduled task's coordinator tells its direct chat:
 * `attention` only when the task needs the user (a question, an approval, a
 * spend cap) or fails; `all` also when it completes, like any task.
 */
export const chatUpdatesSchema = z.enum(["attention", "all"]);

export const scheduleNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(SCHEDULE_NAME_LIMIT)
  .superRefine(refineOneLine("A schedule name"));
export const scheduleInstructionsSchema = z
  .string()
  .trim()
  .max(TEMPLATE_INSTRUCTIONS_LIMIT);
export const keepWorkspacesSchema = z
  .number()
  .int()
  .min(0)
  .max(MAX_KEEP_WORKSPACES);

export const scheduleSchema = z.object({
  id: idSchema,
  /** One line of plain text: it appears in the scheduled task's brief. */
  name: scheduleNameSchema,
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
  /** The next due time; null exactly while disabled. */
  nextFireAt: timestampSchema.nullable(),
  /** Set when the server disabled the schedule; cleared by enabling it again. */
  pausedReason: schedulePausedReasonSchema.nullable().default(null),
  /** The latest fire, by due time. */
  lastFire: scheduleFireSchema.nullable().default(null),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

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

export type StoredTrigger = z.infer<typeof storedTriggerSchema>;
export type ScheduleFireOutcome = z.infer<typeof scheduleFireOutcomeSchema>;
export type ScheduleFire = z.infer<typeof scheduleFireSchema>;
export type SchedulePausedReason = z.infer<typeof schedulePausedReasonSchema>;
export type ChatUpdates = z.infer<typeof chatUpdatesSchema>;
export type Schedule = z.infer<typeof scheduleSchema>;
export type SchedulerStatus = z.infer<typeof schedulerStatusSchema>;
export type ScheduleList = z.infer<typeof scheduleListSchema>;
export type ScheduleDetail = z.infer<typeof scheduleDetailSchema>;
export type TemplateInUseDetails = z.infer<typeof templateInUseDetailsSchema>;
