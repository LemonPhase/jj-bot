/**
 * The rules of schedules: the cron grammar (`cron.ts`), the commands that
 * save a schedule, and the instants an expression names on a time zone's
 * wall clock with the checks a save makes with them. Pure and shared by the
 * schedule editor, the demo and the server, so all of them name the same
 * times and refuse the same saves. Imported as `@jj/contracts/schedule-rules`,
 * not from the contracts index, so a client loads it only where it writes
 * or previews a schedule; the index keeps the records and these types.
 *
 * Times follow the zone's wall clock, and instants are UTC. A wall time a
 * daylight-saving change skips fires once, at the end of the gap; one it
 * repeats fires once, at its first occurrence. Zone rules come from the
 * runtime's `Intl` (ICU) at each computation. The zone is read twice per
 * matching day of the window (and about 20 more times on a day it changes
 * offset), never per minute, so every computation is bounded whatever the
 * expression.
 */
import { z } from "zod";
import { hasSomeField, idSchema, SOME_FIELD_REQUIRED } from "./common";
import { type CronFields, canonicalTimeZone, parseCron } from "./cron";
import {
  chatUpdatesSchema,
  keepWorkspacesSchema,
  SCHEDULE_GAP_DAYS,
  SCHEDULE_HORIZON_DAYS,
  type StoredTrigger,
  scheduleInstructionsSchema,
  scheduleNameSchema,
} from "./schedules";

export * from "./cron";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** No zone is ahead of UTC by more than this, nor behind by more than 12 h. */
const MAX_OFFSET_MS = 14 * HOUR_MS;
const HORIZON_MS = SCHEDULE_HORIZON_DAYS * DAY_MS;
const GAP_WINDOW_MS = SCHEDULE_GAP_DAYS * DAY_MS;

// --- Time zones -------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      era: "short",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    formatters.set(timeZone, format);
  }
  return format;
}

/** The zone's wall clock at an instant, as a UTC-based millisecond count. */
function wallClock(instantMs: number, timeZone: string): number {
  const parts: Record<string, string> = {};
  for (const part of formatter(timeZone).formatToParts(instantMs))
    parts[part.type] = part.value;
  const year =
    parts.era === "BC" || parts.era === "B"
      ? 1 - Number(parts.year)
      : Number(parts.year);
  const wall = Date.UTC(
    year,
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second),
  );
  // Date.UTC maps years 0–99 to 1900–1999.
  return year >= 0 && year < 100 ? new Date(wall).setUTCFullYear(year) : wall;
}

/** The zone's offset from UTC at an instant, in milliseconds (whole seconds). */
export function zoneOffsetMs(instantMs: number, timeZone: string): number {
  const second = Math.floor(instantMs / 1000) * 1000;
  return wallClock(second, timeZone) - second;
}

/**
 * Converts the wall times of one day (`dayMs`, a UTC-based midnight) to
 * instants. The zone is read twice, 14 hours either side of the day (no
 * zone is further from UTC); when the two offsets differ, the change between
 * them is found to the second once, and each wall time then maps without
 * another reading: to its first occurrence where the zone repeats it, and
 * to the change itself (the end of the gap) where the zone skips it.
 */
function dayConverter(
  dayMs: number,
  timeZone: string,
): (wallMs: number) => number {
  const lowMs = dayMs - MAX_OFFSET_MS;
  const highMs = dayMs + DAY_MS + MAX_OFFSET_MS;
  const early = zoneOffsetMs(lowMs, timeZone);
  const late = zoneOffsetMs(highMs, timeZone);
  if (early === late) return (wallMs) => wallMs - early;
  let low = lowMs / 1000;
  let high = highMs / 1000;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (zoneOffsetMs(middle * 1000, timeZone) === early) low = middle;
    else high = middle;
  }
  const change = high * 1000;
  return (wallMs) => {
    const before = wallMs - early;
    const after = wallMs - late;
    const beforeValid = before < change;
    const afterValid = after >= change;
    if (beforeValid && afterValid) return Math.min(before, after);
    if (beforeValid) return before;
    if (afterValid) return after;
    return change;
  };
}

/**
 * The instant a wall time (a UTC-based millisecond count) names in the
 * zone: its first occurrence when the zone repeats it, and the end of the
 * gap when the zone skips it.
 */
export function wallTimeToInstant(wallMs: number, timeZone: string): number {
  return dayConverter(Math.floor(wallMs / DAY_MS) * DAY_MS, timeZone)(wallMs);
}

// --- Evaluation -------------------------------------------------------------

function dayMatches(fields: CronFields, dayMs: number): boolean {
  const date = new Date(dayMs);
  if (!fields.months[date.getUTCMonth() + 1]) return false;
  const day = fields.days[date.getUTCDate()] ?? false;
  const weekday = fields.weekdays[date.getUTCDay()] ?? false;
  return fields.daysRestricted && fields.weekdaysRestricted
    ? day || weekday
    : day && weekday;
}

/** One fire: its instant, and the wall time (UTC-based) that named it first. */
export interface CronFire {
  instant: number;
  wall: number;
}

/**
 * The fires the expression names in the zone, strictly after `afterMs` and
 * at most `untilMs`, ascending and each instant once. A fire several skipped
 * wall times share (they all run at the end of the gap) carries the first.
 */
export function* cronFires(
  fields: CronFields,
  timeZone: string,
  afterMs: number,
  untilMs: number,
): Generator<CronFire> {
  const startWall = wallClock(Math.floor(afterMs / 1000) * 1000, timeZone);
  let dayMs = Math.floor(startWall / DAY_MS) * DAY_MS - DAY_MS;
  let last = Number.NEGATIVE_INFINITY;
  while (dayMs - MAX_OFFSET_MS <= untilMs) {
    if (dayMatches(fields, dayMs)) {
      const toInstant = dayConverter(dayMs, timeZone);
      for (const hour of fields.hours)
        for (const minute of fields.minutes) {
          const wall = dayMs + hour * HOUR_MS + minute * MINUTE_MS;
          const instant = toInstant(wall);
          if (instant <= afterMs || instant <= last) continue;
          if (instant > untilMs) return;
          last = instant;
          yield { instant, wall };
        }
    }
    dayMs += DAY_MS;
  }
}

/** The instants of `cronFires`. */
export function* cronInstants(
  fields: CronFields,
  timeZone: string,
  afterMs: number,
  untilMs: number,
): Generator<number> {
  for (const fire of cronFires(fields, timeZone, afterMs, untilMs))
    yield fire.instant;
}

// --- Triggers ----------------------------------------------------------------

/**
 * The instants a trigger fires at strictly after `after`, ascending, at most
 * `n` of them, looking SCHEDULE_HORIZON_DAYS ahead. Empty for an expression
 * that does not parse or never fires in that window. Throws a RangeError for
 * a zone this runtime does not know.
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
    from + HORIZON_MS,
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
 * The shortest time between two consecutive fires in the SCHEDULE_GAP_DAYS
 * after `from`, in whole minutes, measured on the zone's wall clock, as the
 * schedule is; null when it fires fewer than twice in that window. With
 * `stopBelow`, the walk ends at the first gap shorter than that many
 * minutes and returns it, so checking a frequent expression costs no more
 * than its first fires.
 *
 * In real time, a change of offset can bring two consecutive runs closer,
 * down to a minute: `59 * * * *` in Europe/London runs at 00:59 and, since
 * 01:59 does not exist on the night clocks go forward, at the end of the
 * gap, 02:00; in Pacific/Chatham, whose change is 45 minutes past the hour,
 * the same expression runs 14 minutes apart. So in the hour of a change a
 * schedule can start once more than the minimum allows; a run that has not
 * finished still makes the next due time skip.
 */
export function minimumGapMinutes(
  trigger: StoredTrigger,
  from: Date,
  stopBelow?: number,
): number | null {
  const parsed = parseCron(trigger.cron);
  if (!parsed.ok) return null;
  let previous: number | undefined;
  let shortest: number | undefined;
  const start = from.getTime();
  // Wall times are whole minutes apart at least: nothing is under a minute.
  const enough = Math.max(1, stopBelow ?? 1) * MINUTE_MS;
  for (const { wall } of cronFires(
    parsed.fields,
    trigger.timeZone,
    start,
    start + GAP_WINDOW_MS,
  )) {
    if (previous !== undefined) {
      const gap = wall - previous;
      if (shortest === undefined || gap < shortest) shortest = gap;
      if (shortest < enough || shortest <= MINUTE_MS) break;
    }
    previous = wall;
  }
  return shortest === undefined ? null : Math.floor(shortest / MINUTE_MS);
}

/**
 * Why a trigger cannot be saved, in one sentence, or undefined when it can:
 * an expression that does not parse, a zone this runtime does not know, no
 * fire in the next SCHEDULE_HORIZON_DAYS, or two consecutive fires closer on
 * the wall clock than `minIntervalMinutes`. The editor previews with it; the
 * server refuses a save with it (VALIDATION_FAILED), and pauses a schedule
 * whose trigger no longer passes it at a fire.
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
    return "This schedule never runs: no time in the next 8 years matches it.";
  const gap = minimumGapMinutes(trigger, from, minIntervalMinutes);
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

// --- Commands ---------------------------------------------------------------

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
 * `POST /api/schedules`. A save answers VALIDATION_FAILED for a bad cron or
 * zone, a cron that never fires in SCHEDULE_HORIZON_DAYS, a gap under the
 * server's minimum interval, or a template that is unknown or whose task cap
 * resolves to none; CONFLICT past MAX_SCHEDULES, or past
 * MAX_ENABLED_SCHEDULES enabled.
 */
export const createScheduleCommandSchema = z.object({
  name: scheduleNameSchema,
  templateId: idSchema,
  trigger: scheduleTriggerSchema,
  instructions: scheduleInstructionsSchema.optional(),
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
 * `PATCH /api/schedules/:id`: the patch merged onto the stored schedule.
 * The trigger and template checks of a save run when the patch changes the
 * trigger or the template, or enables the schedule; a patch that disables it
 * or changes only its name, instructions, kept workspaces or chat updates
 * always applies. Every edit computes the next fire from now: nothing missed
 * is started afterwards.
 */
export const updateScheduleCommandSchema =
  updateScheduleCommandObjectSchema.refine(hasSomeField, SOME_FIELD_REQUIRED);

export type ScheduleTrigger = z.output<typeof scheduleTriggerSchema>;
export type CreateScheduleCommand = z.input<typeof createScheduleCommandSchema>;
export type UpdateScheduleCommand = z.input<typeof updateScheduleCommandSchema>;
