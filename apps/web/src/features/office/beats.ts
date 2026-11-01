import type {
  Bot,
  ExecutionSession,
  MessageIntent,
  Task,
  TaskMessage,
  TaskView,
} from "@jj/contracts";
import { formatMessageTime } from "../../lib/format";
import { statusTitle, statusWord } from "../../lib/status";
import { orderedSessions } from "../../lib/tasks";

/**
 * How the office acts out one task event (SPEC §9.4).
 *
 * - `user`      the user's message appears on the terminal; recipients are pinged.
 * - `announce`  a system notification or goal change: toast, board flash, everyone pinged.
 * - `huddle`    speaker and recipients meet at the table (assignments, group talk).
 * - `visit`     speaker walks over to a single recipient's desk (one-to-one talk, delegation).
 * - `board`     speaker posts a result at the whiteboard.
 * - `terminal`  the coordinator reports a result back to the user.
 * - `broadcast` speaker talks from where they are, with no recipient.
 */
export type BeatMode =
  | "user"
  | "announce"
  | "huddle"
  | "visit"
  | "board"
  | "terminal"
  | "broadcast";

/** The task event a beat comes from. */
export type BeatKind = "message" | "delegation" | "goal";

export interface Beat {
  /** Stable per source record: the message id, `delegation:<sessionId>` or `goal:<eventId>`. */
  id: string;
  kind: BeatKind;
  /** Bot id, or the literal "user" / "system". */
  from: string;
  /** Bot ids being addressed (never includes the speaker). */
  to: string[];
  intent: MessageIntent | "delegation";
  text: string;
  mode: BeatMode;
  /** When the source event happened (the event's `occurredAt`); step labels show it. */
  occurredAt: string;
}

type Named = Pick<Bot, "id" | "name">;
type TaskRef = Pick<Task, "coordinatorBotId" | "participantBotIds">;

/** Resolve `@Name` mentions against the task's participating bots. */
export function mentionedBotIds(text: string, participants: Named[]): string[] {
  const ids: string[] = [];
  for (const match of text.matchAll(/@([\w-]+)/g)) {
    const name = match[1]?.toLowerCase();
    const bot = participants.find((b) => b.name.toLowerCase() === name);
    if (bot && !ids.includes(bot.id)) ids.push(bot.id);
  }
  return ids;
}

/**
 * Pure mapping from a persisted task message to an office beat. It only
 * decides choreography; it never invents statuses, results or replies.
 */
export function messageToBeat(
  message: TaskMessage,
  task: TaskRef,
  participants: Named[],
  occurredAt: string = message.createdAt,
): Beat {
  const base = {
    id: message.id,
    kind: "message" as const,
    intent: message.intent,
    text: message.text,
    occurredAt,
  };
  const inTask = participants.filter((b) =>
    task.participantBotIds.includes(b.id),
  );
  // Addressed bots: the message's recipients, else its @mentions.
  const recipients = message.recipientBotIds.filter((id) =>
    inTask.some((b) => b.id === id),
  );
  const mentions = recipients.length
    ? recipients
    : mentionedBotIds(message.text, inTask);

  if (message.authorKind === "system") {
    return { ...base, from: "system", to: [], mode: "announce" };
  }

  if (message.authorKind === "user") {
    const to = mentions.length
      ? mentions
      : inTask.some((b) => b.id === task.coordinatorBotId)
        ? [task.coordinatorBotId]
        : [];
    return { ...base, from: "user", to, mode: "user" };
  }

  const from = message.authorBotId ?? "system";
  let to = mentions.filter((id) => id !== from);
  const isCoordinator = from === task.coordinatorBotId;

  if (message.intent === "assignment") {
    if (!to.length && isCoordinator) {
      to = inTask.map((b) => b.id).filter((id) => id !== from);
    }
    return { ...base, from, to, mode: "huddle" };
  }

  if (message.intent === "result") {
    if (isCoordinator && !to.length) {
      return { ...base, from, to: [], mode: "terminal" };
    }
    return { ...base, from, to, mode: "board" };
  }

  if (to.length === 1) return { ...base, from, to, mode: "visit" };
  if (to.length > 1) return { ...base, from, to, mode: "huddle" };
  return { ...base, from, to, mode: "broadcast" };
}

/**
 * A delegation: the parent session's bot hands the child session's brief to
 * the child's bot at its desk. Only real child sessions produce one.
 */
export function delegationBeat(
  session: Pick<ExecutionSession, "id" | "botId" | "brief">,
  parentBotId: string,
  occurredAt: string,
): Beat {
  return {
    id: `delegation:${session.id}`,
    kind: "delegation",
    from: parentBotId,
    to: session.botId === parentBotId ? [] : [session.botId],
    intent: "delegation",
    text: session.brief,
    mode: session.botId === parentBotId ? "broadcast" : "visit",
    occurredAt,
  };
}

/** A goal change (`task.goal_changed`): the board flashes and everyone is pinged. */
export function goalBeat(
  eventId: string,
  goalVersion: number,
  occurredAt: string,
): Beat {
  return {
    id: `goal:${eventId}`,
    kind: "goal",
    from: "system",
    to: [],
    intent: "notification",
    text: `Goal updated to v${goalVersion}`,
    mode: "announce",
    occurredAt,
  };
}

/**
 * How close an assignment message must follow (or precede) a delegation to be
 * the same hand-off. The engine and the demo post the assignment in the same
 * step as the child session, so a few seconds is plenty.
 */
const SAME_HANDOFF_MS = 10_000;

const msBetween = (a: string, b: string) =>
  Math.abs(Date.parse(a) - Date.parse(b));

/** A delegation that also posted an assignment message plays once, as the message. */
function dropDuplicateDelegations(beats: Beat[]): Beat[] {
  return beats.filter(
    (beat) =>
      beat.kind !== "delegation" ||
      !beats.some(
        (other) =>
          other.kind === "message" &&
          other.intent === "assignment" &&
          other.from === beat.from &&
          beat.to.every((id) => other.to.includes(id)) &&
          msBetween(other.occurredAt, beat.occurredAt) <= SAME_HANDOFF_MS,
      ),
  );
}

/**
 * Every beat of a task, in the order its events happened. Beats come from the
 * view's `TaskEvent`s: `message.posted` (with the event's `occurredAt`),
 * `session.created` for a child session (a delegation) and `task.goal_changed`.
 * Records older than the view's event window (`hasEarlier`) still play, from
 * the message or session record itself.
 */
export function taskBeats(view: TaskView, participants: Named[]): Beat[] {
  const { task } = view;
  const sessions = new Map(view.sessions.map((s) => [s.id, s]));
  const fromEvents: Beat[] = [];
  const seenMessages = new Set<string>();
  const seenSessions = new Set<string>();

  const events = [...view.events].sort((a, b) => a.sequence - b.sequence);
  for (const event of events) {
    if (event.type === "message.posted") {
      const { message } = event.payload;
      seenMessages.add(message.id);
      fromEvents.push(
        messageToBeat(message, task, participants, event.occurredAt),
      );
    } else if (event.type === "session.created") {
      const { session } = event.payload;
      seenSessions.add(session.id);
      const parent = session.parentSessionId
        ? sessions.get(session.parentSessionId)
        : undefined;
      if (parent)
        fromEvents.push(
          delegationBeat(session, parent.botId, event.occurredAt),
        );
    } else if (event.type === "task.goal_changed") {
      fromEvents.push(
        goalBeat(event.id, event.payload.goalVersion, event.occurredAt),
      );
    }
  }

  const earlier: Beat[] = [];
  for (const message of view.messages) {
    if (!seenMessages.has(message.id))
      earlier.push(messageToBeat(message, task, participants));
  }
  for (const session of orderedSessions(view)) {
    const parent = session.parentSessionId
      ? sessions.get(session.parentSessionId)
      : undefined;
    if (parent && !seenSessions.has(session.id))
      earlier.push(delegationBeat(session, parent.botId, session.createdAt));
  }
  earlier.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));

  return dropDuplicateDelegations([...earlier, ...fromEvents]);
}

/** The session that best represents a bot right now: the latest active one, else the latest. */
export function sessionFor(
  view: TaskView,
  botId: string,
): ExecutionSession | undefined {
  const mine = orderedSessions(view).filter((s) => s.botId === botId);
  const active = mine.filter(
    (s) =>
      s.status === "queued" || s.status === "running" || s.status === "waiting",
  );
  return active.at(-1) ?? mine.at(-1);
}

/** Bots with a running session: the only ones the office shows as working. */
export function workingBotIds(view: TaskView): string[] {
  const ids: string[] = [];
  for (const session of orderedSessions(view))
    if (session.status === "running" && !ids.includes(session.botId))
      ids.push(session.botId);
  return ids;
}

/** Desk order: the coordinator first, then the other participants as listed. */
export function deskOrder<B extends Pick<Bot, "id">>(
  task: Pick<Task, "coordinatorBotId">,
  participants: B[],
): B[] {
  const coordinator = participants.filter(
    (b) => b.id === task.coordinatorBotId,
  );
  return [
    ...coordinator,
    ...participants.filter((b) => b.id !== task.coordinatorBotId),
  ];
}

/** How long a beat's speech stays up at 1×, in ms (longer text holds longer). */
export function beatHoldMs(beat: Pick<Beat, "mode" | "text">): number {
  if (beat.mode === "announce") return 3200;
  return Math.min(6500, Math.max(2200, 1600 + beat.text.length * 42));
}

export type NameOf = (id: string) => string;

const speakerName = (id: string, nameOf: NameOf) =>
  id === "user" ? "You" : id === "system" ? "System" : nameOf(id);

const listNames = (names: string[]) =>
  names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/** What the speaker does, in neutral, non-gendered words (SPEC §9.4). */
export function beatPhrase(beat: Beat, nameOf: NameOf): string {
  switch (beat.mode) {
    case "user":
      return beat.intent === "steering"
        ? "steering on the terminal"
        : "lands on the terminal";
    case "announce":
      return "board flashes, everyone is pinged";
    case "huddle":
      return "huddle at the table";
    case "board":
      return "posts the result at the board";
    case "terminal":
      return "reports back at the terminal";
    case "broadcast":
      return "speaks where they stand";
    case "visit": {
      const desk = `${speakerName(beat.to[0] ?? "", nameOf)}'s desk`;
      return beat.kind === "delegation"
        ? `delegates at ${desk}`
        : `walks to ${desk}`;
    }
  }
}

/** "17:20 · Juno → Moss, Vesper · huddle at the table" (SPEC §9.4). */
export function beatLabel(beat: Beat, nameOf: NameOf, now?: Date): string {
  const time = formatMessageTime(beat.occurredAt, now);
  const from = speakerName(beat.from, nameOf);
  const to =
    beat.mode === "announce" || !beat.to.length
      ? ""
      : ` → ${beat.to.map(nameOf).join(", ")}`;
  return [time, `${from}${to}`, beatPhrase(beat, nameOf)]
    .filter(Boolean)
    .join(" · ");
}

/** The speech bubble's "who" line: "Juno · assignment", "You · steering", "Moss". */
export function bubbleWho(beat: Beat, nameOf: NameOf): string {
  const name = speakerName(beat.from, nameOf);
  return beat.intent === "discussion" ? name : `${name} · ${beat.intent}`;
}

/**
 * The label after the last beat: who is working right now, from real session
 * statuses only, else what the task is doing.
 */
export function nowLabel(
  task: Pick<Task, "status" | "cancelRequestedAt">,
  workingNames: string[],
): string {
  if (workingNames.length)
    return `Now · ${listNames(workingNames)} ${
      workingNames.length === 1 ? "is" : "are"
    } working…`;
  const word = statusWord(task);
  if (word === "waiting") return `Now · ${statusTitle(task) ?? "waiting"}`;
  return `Now · task ${word}`;
}

/**
 * Decides which beats a view acts out: on the first update the last
 * `introCount` beats replay; afterwards only beats it has not seen are queued.
 */
export class BeatFeed {
  private seen: Set<string> | null = null;

  constructor(private readonly introCount = 4) {}

  next(beats: Beat[]): { kind: "replay" | "enqueue"; beats: Beat[] } {
    if (!this.seen) {
      this.seen = new Set(beats.map((b) => b.id));
      return { kind: "replay", beats: beats.slice(-this.introCount) };
    }
    const seen = this.seen;
    const fresh = beats.filter((b) => !seen.has(b.id));
    for (const beat of fresh) seen.add(beat.id);
    return { kind: "enqueue", beats: fresh };
  }
}
