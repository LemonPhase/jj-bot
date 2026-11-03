// Messages a session finishes without reading. A message never gives a model
// that has ended its turn another one (run-context.ts), so one can reach a
// session during its last model call and find it finished. It is not dropped:
// the session's parent gets it with the session's result or failure, so every
// message the engine accepted is read by its recipient or handed on.
import { type SessionRow, sessionInbox, type Tx } from "@jj/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { EngineContext } from "../context";
import { quoteClipped } from "./quote";

/** Characters of each unread message, quoted, that the parent is shown. */
export const UNREAD_QUOTE_CHARS = 1_000;

/**
 * Marks `session`'s unread messages delivered and returns the note that
 * hands them to its parent ("" when there are none): each message as the
 * session would have read it, quoted and clipped, oldest first.
 */
export async function handOnUnread(
  tx: Tx,
  ctx: EngineContext,
  session: SessionRow,
  name: string,
): Promise<string> {
  const unread = await tx
    .select({ id: sessionInbox.id, text: sessionInbox.text })
    .from(sessionInbox)
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
  const count = unread.length === 1 ? "a message" : `${unread.length} messages`;
  return [
    `${name} finished before reading ${count} sent to it, so ${unread.length === 1 ? "it is" : "they are"} handed to you (each is in the task log):`,
    ...unread.map((item) => quoteClipped(item.text, UNREAD_QUOTE_CHARS)),
  ].join("\n\n");
}
