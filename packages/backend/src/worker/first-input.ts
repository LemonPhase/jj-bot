// A child session's first input: the inbox item that starts a delegated
// session. Its brief is in its system prompt; this item tells it what the
// task already holds, so it needs no relay from the session that delegated
// it. In order, wide to narrow:
//
// 1. the task log so far, as an index: the newest FIRST_INPUT_ENTRIES
//    entries, one index line each, older ones collapsed into one line that
//    points at `task_log`;
// 2. the user's messages in the task, quoted whole: the newest that fit
//    FIRST_INPUT_USER_MESSAGES and FIRST_INPUT_USER_CHARS, older ones
//    collapsed into one line that points at `task_log` (the newest alone,
//    when too long, keeps its start and end and points at `read_entry`).
//    The heading says which of these it shows, and that the user wrote to
//    the coordinator while the brief says what is this worker's;
// 3. the handoff note (handoff.ts), when the bot has reported to the
//    delegating session before;
// 4. the pointer to the brief, which ends with "Start now."
//
// Sections with nothing to show are left out: the first child of a task
// with an empty log starts on the pointer alone. The input is built once, in
// the `delegate` transaction before the assignment is posted, so the log
// holds what came before this brief. It goes only into the delivered inbox
// item: the child's stored brief and the assignment message stay what the
// delegating bot wrote. Everything quoted is redacted before it is clipped.
import type { Executor } from "@jj/db";
import {
  entryHeader,
  indexLine,
  listTaskLog,
  type Redact,
  type TaskLogEntry,
  type TaskLogPage,
} from "../services/task-log";
import { handoffNote } from "./handoff";
import { briefPointer } from "./prompts";
import { quoteClipped, quotedSize } from "./quote";

// The bounds. The first input is resent, cached, with every model call of
// the child session, and every delegation adds one, so it stays small next
// to the fixed prefix (system prompt and tools, about 2,000 tokens a call)
// however long the task runs; most delegations come nowhere near them.

/**
 * Task log entries the index shows, newest kept. A line takes about 170
 * characters (id, kind, author and recipients, preview), so the index stays
 * under about 3,500 characters, roughly 1,000 tokens.
 */
export const FIRST_INPUT_ENTRIES = 20;
/** Characters of an entry's text in the index (`task_log` shows 160). */
export const FIRST_INPUT_PREVIEW_CHARS = 100;
/** The user's messages shown in full, newest kept. */
export const FIRST_INPUT_USER_MESSAGES = 10;
/**
 * Characters the user's messages take at most, headers and quote prefixes
 * included: roughly 1,000 tokens, room for a long request or several rules.
 */
export const FIRST_INPUT_USER_CHARS = 4000;

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/** The index of the log so far, or undefined when it is empty. */
function indexSection(log: TaskLogPage, redact: Redact): string | undefined {
  const first = log.entries[0];
  if (!first) return undefined;
  return [
    "The task log so far, oldest first (`read_entry` with an entry's id shows it in full):",
    ...(log.earlier > 0
      ? [
          `(${plural(log.earlier, "earlier entry", "earlier entries")} — use \`task_log\` with before "${first.id}" to list them.)`,
        ]
      : []),
    ...log.entries.map((entry) =>
      indexLine(entry, redact, FIRST_INPUT_PREVIEW_CHARS),
    ),
  ].join("\n");
}

/**
 * The user's messages in full, oldest first: the newest that fit the
 * budget, or undefined when there are none.
 */
function userSection(
  messages: TaskLogPage,
  redact: Redact,
): string | undefined {
  if (messages.entries.length === 0) return undefined;
  const blocks: string[] = [];
  let clipped = false;
  // Each block, its header included, and the line break after it, comes out
  // of the budget.
  let room = FIRST_INPUT_USER_CHARS;
  let index = messages.entries.length - 1;
  for (; index >= 0; index -= 1) {
    const entry = messages.entries[index] as TaskLogEntry;
    // Redacted before it is measured and clipped.
    const text = redact(entry.text);
    const header = `${entryHeader(entry, redact)}:`;
    const whole = quotedSize(text);
    const size = header.length + 1 + whole;
    if (size <= room) {
      // It fits, so it is quoted whole.
      blocks.unshift(`${header}\n${quoteClipped(text, whole)}`);
      room -= size + 1;
      continue;
    }
    if (blocks.length === 0) {
      // The newest alone is too long: keep its start and its end.
      const header = `${entryHeader(entry, redact)} (clipped; \`read_entry\` shows it in full):`;
      blocks.unshift(
        `${header}\n${quoteClipped(text, room - header.length - 1)}`,
      );
      clipped = true;
      index -= 1;
    }
    break;
  }
  const left = messages.earlier + index + 1;
  const oldest = messages.entries[index + 1] as TaskLogEntry;
  // Says what is shown: all of them whole, only the newest, or the newest
  // one clipped.
  const extent = clipped
    ? "The user's newest message in this task, clipped"
    : left === 0
      ? "The user's messages in this task, in full, oldest first"
      : blocks.length === 1
        ? "The user's newest message in this task, in full"
        : `The user's newest ${blocks.length} messages in this task, in full, oldest first`;
  return [
    `${extent} (the user wrote to the coordinator; your brief says which part of the work is yours):`,
    ...(left > 0
      ? [
          `(${plural(left, "earlier user message", "earlier user messages")} — use \`task_log\` with kind "user" and before "${oldest.id}" to list them.)`,
        ]
      : []),
    ...blocks,
  ].join("\n");
}

export interface FirstInputParts {
  /** The newest entries of the task log before the brief. */
  log: TaskLogPage;
  /** The newest of the user's messages in the task. */
  userMessages: TaskLogPage;
  /** The handoff note, when there is one. */
  note?: string;
  /** The bot that delegated the work. */
  requester: string;
}

/** The first input from its parts: the sections in order, then the pointer. */
export function formatFirstInput(
  parts: FirstInputParts,
  redact: Redact,
): string {
  return redact(
    [
      indexSection(parts.log, redact),
      userSection(parts.userMessages, redact),
      parts.note,
      briefPointer(parts.requester),
    ]
      .filter((section): section is string => section !== undefined)
      .join("\n\n"),
  );
}

const EMPTY: TaskLogPage = { entries: [], earlier: 0, later: 0 };

/**
 * The first input of a child session that `delegation.requester`'s session
 * is about to start for `delegation.botId`, read from the task's stored
 * records. Call it before the assignment is posted.
 */
export async function childFirstInput(
  exec: Executor,
  task: { id: string; goalVersion: number },
  delegation: { parentSessionId: string; botId: string; requester: string },
  redact: Redact,
): Promise<string> {
  const log =
    (await listTaskLog(exec, task.id, {
      newest: true,
      limit: FIRST_INPUT_ENTRIES,
    })) ?? EMPTY;
  const userMessages =
    (await listTaskLog(exec, task.id, {
      kind: "user",
      newest: true,
      limit: FIRST_INPUT_USER_MESSAGES,
    })) ?? EMPTY;
  const note = await handoffNote(exec, task, delegation, redact);
  return formatFirstInput(
    { log, userMessages, note, requester: delegation.requester },
    redact,
  );
}
