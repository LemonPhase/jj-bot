// Direct chat with one bot. A message is stored and a `chat.reply` job is
// enqueued in the same transaction; the reply arrives asynchronously.
import {
  type ConversationView,
  type SendBotMessageCommand,
  type SendBotMessageResult,
  sendBotMessageCommandSchema,
} from "@jj/contracts";
import {
  conversationMessages,
  enqueue,
  type Executor,
  jobs,
  nextConversationSequence,
} from "@jj/db";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { EngineContext } from "../context";
import { parseCommand } from "../errors";
import { hint, wakeWorkers } from "../events";
import { toConversationMessage } from "../records";
import { activeBot } from "./bots";
import { assertModel } from "./tasks";

/** Messages a conversation view returns (the latest ones). */
export const CONVERSATION_VIEW_LIMIT = 200;

export async function sendBotMessage(
  ctx: EngineContext,
  botId: string,
  input: SendBotMessageCommand,
): Promise<SendBotMessageResult> {
  const command = parseCommand(sendBotMessageCommandSchema, input);
  const bot = await activeBot(ctx.db, botId);
  assertModel(ctx, bot);
  const row = await ctx.db.transaction(async (tx) => {
    const sequence = await nextConversationSequence(tx, botId);
    const [inserted] = await tx
      .insert(conversationMessages)
      .values({
        id: ctx.ids("conversationMessage"),
        botId,
        sequence,
        role: "user",
        text: command.text,
        createdAt: ctx.clock(),
      })
      .returning();
    await enqueue(tx, { kind: "chat.reply", botId });
    await wakeWorkers(tx);
    await hint(tx, { type: "conversation.changed", botId });
    return inserted;
  });
  if (!row) throw new Error("The message insert returned no row.");
  return { message: toConversationMessage(row) };
}

/** The latest chat.reply job of a bot: whether it is replying and why the last reply failed. */
async function replyState(exec: Executor, botId: string) {
  const [pending] = await exec
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.botId, botId),
        eq(jobs.kind, "chat.reply"),
        inArray(jobs.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  const [last] = await exec
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.botId, botId),
        eq(jobs.kind, "chat.reply"),
        inArray(jobs.status, ["done", "failed"]),
      ),
    )
    .orderBy(desc(jobs.updatedAt), desc(jobs.id))
    .limit(1);
  return {
    replying: pending !== undefined,
    lastReplyError:
      last?.status === "failed"
        ? {
            message: last.lastError ?? "The reply failed.",
            at: last.updatedAt.toISOString(),
          }
        : null,
  };
}

export async function conversationView(
  ctx: EngineContext,
  botId: string,
): Promise<ConversationView> {
  await activeBot(ctx.db, botId);
  const rows = await ctx.db
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.botId, botId))
    .orderBy(desc(conversationMessages.sequence))
    .limit(CONVERSATION_VIEW_LIMIT);
  return {
    botId,
    messages: rows.reverse().map(toConversationMessage),
    ...(await replyState(ctx.db, botId)),
  };
}

/** The last `limit` messages, oldest first, for a reply. */
export async function conversationHistory(
  exec: Executor,
  botId: string,
  limit: number,
) {
  const rows = await exec
    .select()
    .from(conversationMessages)
    .where(eq(conversationMessages.botId, botId))
    .orderBy(desc(conversationMessages.sequence))
    .limit(limit);
  return rows.reverse();
}
