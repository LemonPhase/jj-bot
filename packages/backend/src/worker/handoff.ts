// The handoff note. When a session delegates to a bot that has already
// reported to it, the new child session's first input carries a note that
// points at the latest of those earlier sessions: its id, its brief and
// its report (or error), quoted and clipped, and the `read_report` call that
// shows them in full. It is a pointer, not a summary. The note is built once,
// when the delegation is made, from stored rows, and goes only into the
// child's first input (first-input.ts): the child's stored brief and the
// assignment message stay what the delegating bot wrote.
import type { Executor } from "@jj/db";
import {
  type Redact,
  readLatestReport,
  type SessionReport,
} from "../services/task-log";
import { quoteClipped, quoteLines } from "./quote";

/** Characters a note's quote of the earlier brief takes at most. */
export const HANDOFF_BRIEF_CHARS = 1500;
/** Characters a note's quote of the earlier report, or error, takes at most. */
export const HANDOFF_REPORT_CHARS = 2000;

/**
 * The note for an earlier session that completed or failed, for a task now
 * at `goalVersion`.
 */
export function formatHandoffNote(
  previous: SessionReport,
  goalVersion: number,
  redact: Redact,
): string {
  // Redacted before it is clipped, so a cut never leaves part of a secret.
  const quote = (text: string | null, max: number, none: string) =>
    text?.trim() ? quoteClipped(redact(text), max) : quoteLines(none);
  const failed = previous.status === "failed";
  const older =
    previous.goalVersion < goalVersion
      ? ` It worked to goal version ${previous.goalVersion}; the goal is now version ${goalVersion}.`
      : "";
  return redact(
    [
      `Handoff note: you have worked on this task before${previous.requester ? ` for ${previous.requester}` : ""}, in session ${previous.id}, which ${failed ? "failed" : "completed"}.${older} This note points to that work; its files are in the shared workspace.`,
      "Your brief then:",
      quote(previous.brief, HANDOFF_BRIEF_CHARS, "(no brief)"),
      failed ? "It failed with:" : "Your report then:",
      quote(
        failed ? previous.error : previous.report,
        HANDOFF_REPORT_CHARS,
        "(none)",
      ),
      `\`read_report\` with session "${previous.id}" shows that brief and ${failed ? "the error" : "report"} in full.`,
    ].join("\n"),
  );
}

/**
 * The handoff note for a delegation from `parentSessionId` to `botId`: about
 * that bot's latest session under the same parent that completed or failed.
 * Undefined when it has none.
 */
export async function handoffNote(
  exec: Executor,
  task: { id: string; goalVersion: number },
  under: { parentSessionId: string; botId: string },
  redact: Redact,
): Promise<string | undefined> {
  const previous = await readLatestReport(exec, task.id, under);
  return previous
    ? formatHandoffNote(previous, task.goalVersion, redact)
    : undefined;
}
