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
 * left out are counted, said to perhaps include broadcasts, and pointed at
 * with a `task_log` query that finds them among the task's messages.
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
  const handing = `so ${count === 1 ? "it is" : "they are"} handed to you (each is in the task log)`;
  if (omitted === 0)
    return [
      `${name} finished before reading ${count === 1 ? "a message" : `${count} messages`} sent to it, ${handing}:`,
      ...handed.map(quoted),
    ].join("\n\n");
  // The cap keeps the newest messages, whatever their kind: the ones it left
  // out came before every message still in the inbox, and broadcasts may be
  // among them.
  const oldestKept = unread.find((item) => item.sourceMessageId !== null);
  return [
    `${name} finished before reading ${plural(count, "message", "messages")}, ${handing}: ${handed.length > 0 ? `${handed.length} sent to it, quoted below, and ` : ""}${plural(omitted, "earlier one", "earlier ones")} its inbox left out, which may ${omitted === 1 ? "be a message" : "include messages"} to everyone.`,
    `(Use \`task_log\` with kind "message"${oldestKept ? ` and before "${oldestKept.sourceMessageId}"` : ""} to find the ${omitted} left out among the task's messages.)`,
    ...handed.map(quoted),
  ].join("\n\n");
}

/** A message as the session would have read it, quoted and clipped. */
function quoted(item: { text: string; entryId: string | null }) {
  return item.entryId && quotedSize(item.text) > UNREAD_QUOTE_CHARS
    ? `${item.entryId} (clipped; \`read_entry\` shows it in full):\n${quoteClipped(item.text, UNREAD_QUOTE_CHARS)}`
    : quoteClipped(item.text, UNREAD_QUOTE_CHARS);
}
