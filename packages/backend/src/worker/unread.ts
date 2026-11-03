// Messages a session finishes without reading. A message never gives a model
// that has ended its turn another one (run-context.ts), so one can reach a
// session during its last model call and find it finished. It is not dropped:
// the session's parent gets it with the session's result or failure, so every
// message the engine accepted is read by its recipient or handed on. A
// broadcast is not handed on: the parent received it too, or sent it.
import { type SessionRow, sessionInbox, type Tx, taskMessages } from "@jj/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { EngineContext } from "../context";
import { omittedCount } from "../services/messages";
import { isBroadcast } from "../services/task-log";
import { quoteClipped, quotedSize } from "./quote";

/** Characters of each unread message, quoted, that the parent is shown. */
export const UNREAD_QUOTE_CHARS = 1_000;

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

/**
 * Marks `session`'s unread messages delivered and returns the note that
 * hands them to its parent ("" when there are none): each message as the
 * session would have read it, quoted and clipped, oldest first. A clipped
 * one names its task log entry for `read_entry`; the messages the inbox cap
 * left out are counted, and pointed at with `task_log`.
 */
export async function handOnUnread(
  tx: Tx,
  ctx: EngineContext,
  session: SessionRow,
  name: string,
): Promise<string> {
  const unread = await tx
    .select({
      id: sessionInbox.id,
      text: sessionInbox.text,
      sourceMessageId: sessionInbox.sourceMessageId,
      intent: taskMessages.intent,
      authorKind: taskMessages.authorKind,
    })
    .from(sessionInbox)
    .leftJoin(taskMessages, eq(taskMessages.id, sessionInbox.sourceMessageId))
    .where(
      and(
        eq(sessionInbox.sessionId, session.id),
        isNull(sessionInbox.deliveredAt),
        eq(sessionInbox.kind, "message"),
      ),
    )
    .orderBy(asc(sessionInbox.createdAt), asc(sessionInbox.id));
  if (unread.length === 0) return "";
  await tx
    .update(sessionInbox)
    .set({ deliveredAt: ctx.clock() })
    .where(
      inArray(
        sessionInbox.id,
        unread.map((item) => item.id),
      ),
    );
  let omitted = 0;
  const handed: { text: string; entryId: string | null }[] = [];
  for (const item of unread) {
    const left = omittedCount(item);
    if (left !== undefined) omitted += left;
    else if (
      !(
        item.intent !== null &&
        item.authorKind !== null &&
        isBroadcast({ intent: item.intent, authorKind: item.authorKind })
      )
    )
      handed.push({ text: item.text, entryId: item.sourceMessageId });
  }
  const count = handed.length + omitted;
  if (count === 0) return "";
  // The cap keeps the newest messages: the ones it left out came before
  // every message still in the inbox.
  const oldestKept = unread.find((item) => item.sourceMessageId !== null);
  return [
    `${name} finished before reading ${count === 1 ? "a message" : `${count} messages`} sent to it, so ${count === 1 ? "it is" : "they are"} handed to you (each is in the task log):`,
    ...(omitted > 0
      ? [
          `(${plural(omitted, "earlier message", "earlier messages")}, left out of its inbox — use \`task_log\` with kind "message"${oldestKept ? ` and before "${oldestKept.sourceMessageId}"` : ""} to list ${omitted === 1 ? "it" : "them"}.)`,
        ]
      : []),
    ...handed.map((item) =>
      item.entryId && quotedSize(item.text) > UNREAD_QUOTE_CHARS
        ? `${item.entryId} (clipped; \`read_entry\` shows it in full):\n${quoteClipped(item.text, UNREAD_QUOTE_CHARS)}`
        : quoteClipped(item.text, UNREAD_QUOTE_CHARS),
    ),
  ].join("\n\n");
}
