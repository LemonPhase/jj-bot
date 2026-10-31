import type { BotPresence, TaskStatus, WaitingFor } from "@jj/contracts";

/**
 * Status presentation shared by every screen: one vocabulary (a mono word next
 * to a 6px square) and one status → sprite-mood mapping. Implements decisions 1
 * and 2 of the frontend brief. Session statuses use the same values as task
 * statuses, so everything here accepts both.
 */

/** Sprite moods, in the order the design's System sheet shows them. */
export const MOODS = [
  "idle",
  "thinking",
  "working",
  "verifying",
  "done",
  "stuck",
] as const;
export type Mood = (typeof MOODS)[number];

/** The status-colour token a square uses: `var(--status-${tone})`. */
export type StatusTone =
  | "idle"
  | "running"
  | "verifying"
  | "completed"
  | "failed";

/** Every word the status vocabulary can show. */
export type StatusWord =
  | "queued"
  | "working"
  | "waiting"
  | "done"
  | "failed"
  | "stopped"
  | "stopping"
  | "idle";

/** A task, a session or a bot presence. */
export type StatusValue = TaskStatus | BotPresence;

/**
 * A record with a status, such as a `Task`, `TaskSummary` or `ExecutionSession`.
 * `cancelRequestedAt` (tasks) turns any status into "stopping"; `waitingFor`
 * (sessions) picks the "waiting" tooltip.
 */
export interface StatusSubject {
  status: StatusValue;
  cancelRequestedAt?: string | null;
  waitingFor?: WaitingFor | null;
}

/** A bare status value, or a record that has one. */
export type StatusInput = StatusValue | StatusSubject;

const subjectOf = (input: StatusInput): StatusSubject =>
  typeof input === "string" ? { status: input } : input;

const isStopping = (subject: StatusSubject): boolean =>
  Boolean(subject.cancelRequestedAt) && subject.status !== "cancelled";

const MOOD_BY_STATUS: Record<StatusValue, Mood> = {
  // Bot presence (contract: `working` while it has a queued or running session).
  idle: "idle",
  working: "working",
  // Task and session statuses (brief decision 1).
  queued: "thinking",
  running: "working",
  waiting: "idle",
  completed: "done",
  failed: "stuck",
  cancelled: "idle",
};

/**
 * The sprite mood for a status (brief decision 1). A stopping task keeps the
 * mood of its underlying status: its sessions really are still running until
 * the cancellation lands. No status maps to `verifying` in Contracts 1.0.
 */
export function moodForStatus(input: StatusInput): Mood {
  return MOOD_BY_STATUS[subjectOf(input).status];
}

const WORD_BY_STATUS: Record<StatusValue, StatusWord> = {
  idle: "idle",
  working: "working",
  queued: "queued",
  running: "working",
  waiting: "waiting",
  completed: "done",
  failed: "failed",
  cancelled: "stopped",
};

/** The status word (brief decision 2): "working", "done", "stopping" and so on. */
export function statusWord(input: StatusInput): StatusWord {
  const subject = subjectOf(input);
  return isStopping(subject) ? "stopping" : WORD_BY_STATUS[subject.status];
}

const TONE_BY_WORD: Record<StatusWord, StatusTone> = {
  queued: "idle",
  working: "running",
  waiting: "idle",
  done: "completed",
  failed: "failed",
  stopped: "idle",
  stopping: "idle",
  idle: "idle",
};

/** The status-colour token for the square next to the word. */
export function statusTone(input: StatusInput): StatusTone {
  return TONE_BY_WORD[statusWord(input)];
}

/**
 * Extra context for words that need it, for a tooltip or `title`. Only
 * "waiting" has one: a session waiting on its delegations, or (sessions waiting
 * for the user, and waiting tasks) the user.
 */
export function statusTitle(input: StatusInput): string | undefined {
  const subject = subjectOf(input);
  if (statusWord(subject) !== "waiting") return undefined;
  return subject.waitingFor === "delegations"
    ? "waiting on delegated work"
    : "waiting for you";
}

export interface StatusDisplay {
  word: StatusWord;
  tone: StatusTone;
  mood: Mood;
  title?: string;
}

/** Everything a status indicator needs, in one call. */
export function describeStatus(input: StatusInput): StatusDisplay {
  const title = statusTitle(input);
  return {
    word: statusWord(input),
    tone: statusTone(input),
    mood: moodForStatus(input),
    ...(title ? { title } : {}),
  };
}

/** Only the working mood animates (the design's `bob`); every other mood is static. */
export function moodAnimates(mood: Mood): boolean {
  return mood === "working";
}
