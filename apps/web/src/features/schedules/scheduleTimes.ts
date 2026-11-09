import type { StoredTrigger } from "@jj/contracts";
import {
  canonicalTimeZone,
  nextFires,
  triggerProblem,
} from "@jj/contracts/schedule-rules";

// The editor's evaluation of a trigger, loaded with the schedule dialog
// only: the cron walk and the zone math stay out of the initial bundle.

export { sameTrigger } from "@jj/contracts/schedule-rules";

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
