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
  type Executor,
  enqueue,
  jobs,
  nextConversationSequence,
} from "@jj/db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
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

/**
 * A bot's chat.reply jobs: whether it is replying, and why a reply failed:
 * the reply to the user's latest message while that failure stands (it is
 * not answered again until the user writes more), else the latest reply.
 */
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
  const finished = and(
    eq(jobs.botId, botId),
    eq(jobs.kind, "chat.reply"),
    inArray(jobs.status, ["done", "failed"]),
  );
  const [latestUser] = await exec
    .select({ id: conversationMessages.id })
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.botId, botId),
        eq(conversationMessages.role, "user"),
      ),
    )
    .orderBy(desc(conversationMessages.sequence))
    .limit(1);
  const [forUser] = latestUser
    ? await exec
        .select()
        .from(jobs)
        .where(
          and(finished, sql`${jobs.payload}->>'answering' = ${latestUser.id}`),
        )
        .orderBy(desc(jobs.updatedAt), desc(jobs.id))
        .limit(1)
    : [];
  const [last] = await exec
    .select()
    .from(jobs)
    .where(finished)
    .orderBy(desc(jobs.updatedAt), desc(jobs.id))
    .limit(1);
  const failed = forUser?.status === "failed" ? forUser : last;
  return {
    replying: pending !== undefined,
    lastReplyError:
      failed?.status === "failed"
        ? {
            message: failed.lastError ?? "The reply failed.",
            at: failed.updatedAt.toISOString(),
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
