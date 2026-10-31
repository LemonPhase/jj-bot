import type { Bot, Task, TaskMessage } from "@jj/contracts";

/**
 * How the office acts out one task message.
 *
 * - `user`      the user's message appears on the front terminal; recipients turn to it.
 * - `announce`  a system notification: toast, whiteboard flash, participants ping.
 * - `huddle`    speaker and recipients meet at the table (assignments, group talk).
 * - `visit`     speaker walks over to a single recipient's desk.
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

export interface Beat {
  messageId: string;
  /** Bot id, or the literal "user" / "system". */
  from: string;
  /** Bot ids being addressed (never includes the speaker). */
  to: string[];
  intent: TaskMessage["intent"];
  text: string;
  mode: BeatMode;
}

/** Resolve `@Name` mentions against the task's participating bots. */
export function mentionedBotIds(
  text: string,
  participants: Pick<Bot, "id" | "name">[],
): string[] {
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
  task: Pick<Task, "coordinatorBotId" | "participantBotIds">,
  participants: Pick<Bot, "id" | "name">[],
): Beat {
  const base = {
    messageId: message.id,
    intent: message.intent,
    text: message.text,
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
