import {
  type Bot,
  canonicalTimeZone,
  nextFires,
  type RuntimeProfile,
  SCHEDULER_STALE_MS,
  type Schedule,
  type ScheduleFire,
  type SchedulerStatus,
  type StoredTrigger,
  type TaskTemplate,
  triggerProblem,
} from "@jj/contracts";
import { profileCapOf } from "../templates/templateModel";

/** The editor's presets: each fills the cron field, which stays editable. */
export const PRESETS = [
  { value: "hourly", label: "Hourly", cron: "0 * * * *" },
  { value: "daily", label: "Daily", cron: "0 9 * * *" },
  { value: "weekdays", label: "Weekdays", cron: "0 9 * * 1-5" },
  { value: "weekly", label: "Weekly", cron: "0 9 * * 1" },
] as const;

export type PresetValue = (typeof PRESETS)[number]["value"] | "custom";

/** The preset an expression is, or `custom`. */
export const presetOf = (cron: string): PresetValue =>
  PRESETS.find((preset) => preset.cron === cron.trim().split(/\s+/).join(" "))
    ?.value ?? "custom";

/** The browser's time zone, the editor's default. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

/** Every zone this browser knows, for the zone field's suggestions. */
export function knownTimeZones(): string[] {
  const supported = (Intl as { supportedValuesOf?: (key: string) => string[] })
    .supportedValuesOf;
  try {
    return supported ? supported("timeZone") : ["UTC"];
  } catch {
    return ["UTC"];
  }
}

/** A run's time on the schedule's wall clock, in the reader's language: "Mon 9 Nov, 09:00". */
export function formatRun(instant: Date | string, timeZone: string): string {
  const date = typeof instant === "string" ? new Date(instant) : instant;
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

export interface TriggerPreview {
  /** Why the server would refuse it, in one sentence. */
  problem?: string;
  /** The field the problem is about. */
  field?: "cron" | "timeZone";
  /** The next runs, when it has none. */
  runs: Date[];
}

/**
 * The editor's preview, from the same functions the server saves with: the
 * problem `triggerProblem` finds (against the server's minimum interval), or
 * the next `count` runs.
 */
export function previewTrigger(
  trigger: StoredTrigger,
  now: Date,
  minIntervalMinutes: number,
  count = 3,
): TriggerPreview {
  if (canonicalTimeZone(trigger.timeZone) === undefined)
    return {
      problem: `This browser does not know the time zone "${trigger.timeZone}"; use an IANA name such as Europe/London.`,
      field: "timeZone",
      runs: [],
    };
  const problem = triggerProblem(trigger, now, minIntervalMinutes);
  if (problem) return { problem, field: "cron", runs: [] };
  return { runs: nextFires(trigger, now, count) };
}

/** Whether the scheduler looks stopped: no pass for SCHEDULER_STALE_MS, or none yet. */
export function schedulerStale(
  scheduler: SchedulerStatus,
  now: number,
): boolean {
  if (scheduler.lastPassAt === null) return true;
  return now - Date.parse(scheduler.lastPassAt) > SCHEDULER_STALE_MS;
}

export interface OutcomeLine {
  /** The lead word: Started, Skipped, Missed, Refused. */
  word: string;
  text: string;
  tone: "ok" | "warn" | "fail";
  /** The task to link to (the one started, or the one a skip waited on). */
  taskId?: string;
}

/** What a schedule's last fire says, for the list. */
export function outcomeLine(fire: ScheduleFire): OutcomeLine {
  switch (fire.outcome) {
    case "started":
      return {
        word: "Started",
        text: "opened a task",
        tone: "ok",
        ...(fire.taskId ? { taskId: fire.taskId } : {}),
      };
    case "skipped":
      return {
        word: "Skipped",
        text:
          fire.reason === "The previous run is waiting for your approval."
            ? "waiting for your approval"
            : fire.reason === "The previous run is waiting for you."
              ? "the previous run is waiting for you"
              : "the previous run had not finished",
        tone: "warn",
        ...(fire.taskId ? { taskId: fire.taskId } : {}),
      };
    case "missed":
      return {
        word: "Missed",
        text:
          fire.missedCount > 1
            ? `${fire.missedCount} runs: the server was down`
            : "the server was down",
        tone: "warn",
      };
    case "refused":
      return {
        word: "Refused",
        text: fire.reason ?? "the start was refused",
        tone: "fail",
      };
  }
}

/** Why a template cannot be scheduled as it is: its task cap resolves to none. */
export function uncappedTemplate(
  template: Pick<TaskTemplate, "spendCapUsd" | "coordinatorBotId">,
  bots: readonly Bot[],
  profiles: readonly RuntimeProfile[],
): boolean {
  if (template.spendCapUsd === null) return true;
  if (template.spendCapUsd !== undefined) return false;
  return profileCapOf(template.coordinatorBotId, bots, profiles) === null;
}

/**
 * What a task's header says about the schedule that started it; undefined
 * for a task started otherwise. "Deleted" only when the loaded list lacks it.
 */
export function scheduleOrigin(
  scheduleId: string | null,
  schedules: readonly Pick<Schedule, "id" | "name">[] | null,
): string | undefined {
  if (scheduleId === null) return undefined;
  if (schedules === null) return "Scheduled";
  const schedule = schedules.find((entry) => entry.id === scheduleId);
  return schedule ? `Scheduled · ${schedule.name}` : "Scheduled · deleted";
}
