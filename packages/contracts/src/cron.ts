/**
 * Cron schedules over IANA time zones, pure and shared by the schedule
 * editor's preview and the server's scheduler, so both name the same times.
 *
 * Grammar: five fields (minute, hour, day of month, month, day of week),
 * each a comma-separated list of `*`, a number, a range `a-b`, or a step
 * `*\/n` or `a-b/n`. Months take JAN–DEC and days of week SUN–SAT, in any
 * case; day of week is 0–7, where 0 and 7 are Sunday. When both day of month
 * and day of week are restricted (neither starts with `*`), a day matching
 * either one matches, as in Vixie cron. Refused: a seconds (or year) field,
 * macros such as `@daily`, and `L`, `W`, `#` and `?`.
 *
 * Times follow the zone's wall clock, and instants are UTC. A wall time a
 * daylight-saving change skips fires once, at the end of the gap; one it
 * repeats fires once, at its first occurrence. Zone rules come from the
 * runtime's `Intl` (ICU) at each computation. The zone is read twice per
 * matching day of the window (and about 20 more times on a day it changes
 * offset), never per minute, so every computation over a year is bounded
 * whatever the expression.
 */

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** No zone is ahead of UTC by more than this, nor behind by more than 12 h. */
const MAX_OFFSET_MS = 14 * HOUR_MS;

const MONTH_NAMES = [
  "JAN",
  "FEB",
  "MAR",
  "APR",
  "MAY",
  "JUN",
  "JUL",
  "AUG",
  "SEP",
  "OCT",
  "NOV",
  "DEC",
] as const;
const WEEKDAY_NAMES = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

interface FieldSpec {
  label: string;
  min: number;
  max: number;
  /** Names for min, min + 1, …, upper case. */
  names?: readonly string[];
}

const FIELDS: readonly FieldSpec[] = [
  { label: "minute", min: 0, max: 59 },
  { label: "hour", min: 0, max: 23 },
  { label: "day of month", min: 1, max: 31 },
  { label: "month", min: 1, max: 12, names: MONTH_NAMES },
  { label: "day of week", min: 0, max: 7, names: WEEKDAY_NAMES },
];

/** A parsed expression: each field's matching values, ascending. */
export interface CronFields {
  minutes: readonly number[];
  hours: readonly number[];
  /** Index 1–31. */
  days: readonly boolean[];
  /** Index 1–12. */
  months: readonly boolean[];
  /** Index 0–6, Sunday first (7 is folded into 0). */
  weekdays: readonly boolean[];
  /** The day-of-month field does not start with `*`. */
  daysRestricted: boolean;
  /** The day-of-week field does not start with `*`. */
  weekdaysRestricted: boolean;
}

export type CronParse =
  | { ok: true; fields: CronFields }
  | { ok: false; problem: string };

class CronError extends Error {}

function value(token: string, spec: FieldSpec): number {
  if (/^\d+$/.test(token)) {
    const number = Number(token);
    if (number < spec.min || number > spec.max)
      throw new CronError(
        `${spec.label}: ${token} is out of range ${spec.min}–${spec.max}.`,
      );
    return number;
  }
  const index = spec.names?.indexOf(token.toUpperCase()) ?? -1;
  if (index >= 0) return spec.min + index;
  if (spec.names)
    throw new CronError(
      `${spec.label}: "${token}" is not a number or a name (${spec.names[0]}–${spec.names.at(-1)}).`,
    );
  throw new CronError(`${spec.label}: "${token}" is not a number.`);
}

/** Tokens other cron dialects accept that this one does not. */
const unsupported = (item: string) =>
  /[?#]/.test(item) || /^(\d*L|L\w*|\d+W|LW)$/i.test(item);

function parseField(text: string, spec: FieldSpec): Set<number> {
  const values = new Set<number>();
  for (const item of text.split(",")) {
    if (item === "")
      throw new CronError(`${spec.label}: a list has an empty item.`);
    if (unsupported(item))
      throw new CronError(
        `${spec.label}: L, W, # and ? are not supported; list the values instead.`,
      );
    const [range = "", stepText, extra] = item.split("/");
    if (extra !== undefined)
      throw new CronError(`${spec.label}: "${item}" has more than one step.`);
    let low: number;
    let high: number;
    if (range === "*") {
      low = spec.min;
      high = spec.names === WEEKDAY_NAMES ? 6 : spec.max;
    } else if (range.includes("-")) {
      const [from = "", to = "", more] = range.split("-");
      if (more !== undefined || from === "" || to === "")
        throw new CronError(`${spec.label}: "${range}" is not a range.`);
      low = value(from, spec);
      high = value(to, spec);
      if (low > high)
        throw new CronError(
          `${spec.label}: the range ${range} must go from low to high.`,
        );
    } else {
      if (stepText !== undefined)
        throw new CronError(
          `${spec.label}: a step follows * or a range (*/15, 0-30/5), not "${range}".`,
        );
      low = value(range, spec);
      high = low;
    }
    let step = 1;
    if (stepText !== undefined) {
      if (!/^\d+$/.test(stepText) || Number(stepText) < 1)
        throw new CronError(
          `${spec.label}: the step in "${item}" must be a whole number of at least 1.`,
        );
      step = Number(stepText);
      if (step > spec.max - spec.min + 1)
        throw new CronError(
          `${spec.label}: the step in "${item}" is larger than the field.`,
        );
    }
    for (let at = low; at <= high; at += step) values.add(at);
  }
  return values;
}

const flags = (values: Set<number>, size: number) =>
  Array.from({ length: size }, (_, index) => values.has(index));

/** Parses an expression, or says in one sentence what is wrong with it. */
export function parseCron(cron: string): CronParse {
  const text = cron.trim();
  if (text === "")
    return {
      ok: false,
      problem:
        "Enter a schedule: 5 fields, minute hour day-of-month month day-of-week.",
    };
  if (text.startsWith("@"))
    return {
      ok: false,
      problem:
        "Macros such as @daily are not supported: write the 5 fields (for every day at midnight, 0 0 * * *).",
    };
  const parts = text.split(/\s+/);
  if (parts.length !== 5)
    return {
      ok: false,
      problem:
        parts.length === 6 || parts.length === 7
          ? `This has ${parts.length} fields: a seconds or year field is not supported. Use 5: minute hour day-of-month month day-of-week.`
          : `Use 5 fields (minute hour day-of-month month day-of-week); this has ${parts.length}.`,
    };
  try {
    const [minute, hour, day, month, weekday] = parts.map((part, index) =>
      parseField(part, FIELDS[index] as FieldSpec),
    ) as [Set<number>, Set<number>, Set<number>, Set<number>, Set<number>];
    if (weekday.delete(7)) weekday.add(0);
    return {
      ok: true,
      fields: {
        minutes: [...minute].sort((a, b) => a - b),
        hours: [...hour].sort((a, b) => a - b),
        days: flags(day, 32),
        months: flags(month, 13),
        weekdays: flags(weekday, 7),
        daysRestricted: !(parts[2] as string).startsWith("*"),
        weekdaysRestricted: !(parts[4] as string).startsWith("*"),
      },
    };
  } catch (error) {
    if (error instanceof CronError)
      return { ok: false, problem: error.message };
    throw error;
  }
}

/** What is wrong with a cron expression, in one sentence, or undefined when it parses. */
export function cronProblem(cron: string): string | undefined {
  const parsed = parseCron(cron);
  return parsed.ok ? undefined : parsed.problem;
}

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

/**
 * The zone's canonical IANA name, or undefined when this runtime does not
 * know it. Offsets such as `+05:00` are not zone names and are refused.
 */
export function canonicalTimeZone(name: string): string | undefined {
  const trimmed = name.trim();
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+)*$/.test(trimmed))
    return undefined;
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: trimmed,
    }).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
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
