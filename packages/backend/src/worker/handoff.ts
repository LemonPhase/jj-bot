// The handoff note. When a session delegates to a bot that has already
// reported to it, the new child session's first input starts with a note
// that points at the latest of those earlier sessions: its id, its brief and
// its report (or error), quoted and clipped, and the `read_report` call that
// shows them in full. It is a pointer, not a summary. The note is built once,
// when the delegation is made, from stored rows, and goes only into the
// delivered inbox item: the child's stored brief and the assignment message
// stay what the delegating bot wrote.
import type { Executor } from "@jj/db";
import {
  type Redact,
  readLatestReport,
  type SessionReport,
} from "../services/task-log";

/** Characters a note's quote of the earlier brief takes at most. */
export const HANDOFF_BRIEF_CHARS = 1500;
/** Characters a note's quote of the earlier report, or error, takes at most. */
export const HANDOFF_REPORT_CHARS = 2000;
/** The share of a clipped quote's room kept from its start; its end gets the rest. */
const HEAD_SHARE = 0.6;
/** Starts every quoted line, so quoted text cannot pass for the note's own lines. */
const QUOTE = "> ";

const quoteLines = (text: string) =>
  text
    .split("\n")
    .map((line) => `${QUOTE}${line}`)
    .join("\n");

/** What `text` takes once quoted. */
const quotedSize = (text: string) =>
  text.length + QUOTE.length * text.split("\n").length;

/** Stands for the middle a clipped quote leaves out. */
const elision = (count: number) => `[… ${count} characters left out …]`;

/**
 * The longest start (or end) of `text` whose quote fits in `budget`
 * characters, never splitting a surrogate pair.
 */
function fit(text: string, budget: number, end: "start" | "end"): string {
  let cost = QUOTE.length;
  let taken = 0;
  while (taken < text.length) {
    const char = end === "start" ? text[taken] : text[text.length - 1 - taken];
    const next = cost + 1 + (char === "\n" ? QUOTE.length : 0);
    if (next > budget) break;
    cost = next;
    taken += 1;
  }
  return end === "start"
    ? text
        .slice(0, taken)
        .replace(/[\uD800-\uDBFF]$/, "")
        .trimEnd()
    : text
        .slice(text.length - taken)
        .replace(/^[\uDC00-\uDFFF]/, "")
        .trimStart();
}

/**
 * `text`, trimmed, as a quote of at most `max` characters with its "> "
 * prefixes. A longer text keeps its start and its end (where a report says
 * what is left open) around a line that says how many characters are left
 * out.
 */
export function quoteClipped(text: string, max: number): string {
  const whole = text.trim();
  if (quotedSize(whole) <= max) return quoteLines(whole);
  // Room for the start and the end: what the marker line, at its longest
  // count, and the two line breaks around it leave.
  const room = max - quotedSize(elision(whole.length)) - 2;
  const headRoom = Math.ceil(room * HEAD_SHARE);
  const head = fit(whole, headRoom, "start");
  const tail = fit(whole, room - headRoom, "end");
  const left = whole.length - head.length - tail.length;
  return [head, elision(left), tail].map(quoteLines).join("\n");
}

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
