/**
 * The cron grammar of schedules, pure and shared by the schedule editor and
 * the server. It is part of the `@jj/contracts/schedule-rules` entry
 * (`schedule-rules.ts`, which also evaluates an expression in a time zone),
 * not of the index, so clients load it only where they write or preview a
 * schedule.
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
