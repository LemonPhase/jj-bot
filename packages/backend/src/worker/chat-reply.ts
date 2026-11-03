// One `chat.reply` job: the bot answers its direct chat. A job answers one
// input: the user's waiting messages (with every chat task tool), else the
// oldest unanswered task update (with the read tools only). Jobs of one bot
// run one at a time, so an update that arrives during a reply is answered
// after it, by a reply that sees both, and so is a user message. While more
// inputs wait, each job enqueues the next. An update whose reply fails is
// still told: the engine posts it as a plain message instead.

import { FINISHED_TASK_STATUSES } from "@jj/contracts";
import {
  bots,
  type ClaimedJob,
  type ConversationMessageRow,
  complete,
  conversationMessages,
  type Executor,
  enqueue,
  fail,
  type JobRow,
  jobs,
  nextConversationSequence,
  type Tx,
  taskParticipants,
  tasks,
  usage,
} from "@jj/db";
import {
  and,
  asc,
  count,
  eq,
  inArray,
  isNull,
  lte,
  notInArray,
  sql,
} from "drizzle-orm";
import type { EngineContext } from "../context";
import { errorMessage } from "../errors";
import { hint, wakeWorkers } from "../events";
import type { ChatReply, ChatResponder } from "../ports";
import { activeBotRows, memoryText } from "../services/bots";
import { conversationHistory } from "../services/chat";
import {
  answerTaskUpdate,
  fallbackText,
  type PendingUpdate,
  pendingTaskUpdate,
  pendingTaskUpdates,
  updateInput,
} from "../services/task-updates";
import { type ChatState, chatReadTools, chatTools } from "./chat-tools";
import { chatPrompt } from "./prompts";
import {
  fencedWrite,
  type JobControl,
  LeaseLostError,
  type WorkerDeps,
} from "./run-context";

/** What one job answers. */
type ChatInput =
  /** The user's messages no reply has taken up yet, oldest first; the last is the trigger. */
  | { kind: "user"; waiting: ConversationMessageRow[] }
  | { kind: "update"; update: PendingUpdate };

/** The bot's user messages that no reply has taken up yet, oldest first. */
async function waitingMessages(exec: Executor, botId: string) {
  return exec
    .select()
    .from(conversationMessages)
    .where(
      and(
        eq(conversationMessages.botId, botId),
        eq(conversationMessages.role, "user"),
        isNull(conversationMessages.handledAt),
      ),
    )
    .orderBy(asc(conversationMessages.sequence));
}

async function nextInput(
  exec: Executor,
  botId: string,
): Promise<ChatInput | undefined> {
  const waiting = await waitingMessages(exec, botId);
  if (waiting.length > 0) return { kind: "user", waiting };
  const [update] = await pendingTaskUpdates(exec, botId);
  return update ? { kind: "update", update } : undefined;
}

/**
 * Marks the bot's waiting user messages up to `sequence` taken up: answered,
 * or failed (a failed message is not answered again until the user writes more).
 */
async function markHandled(
  tx: Tx,
  ctx: EngineContext,
  botId: string,
  sequence: number,
) {
  await tx
    .update(conversationMessages)
    .set({ handledAt: ctx.clock() })
    .where(
      and(
        eq(conversationMessages.botId, botId),
        eq(conversationMessages.role, "user"),
        isNull(conversationMessages.handledAt),
        lte(conversationMessages.sequence, sequence),
      ),
    );
}

/** Enqueues the bot's next reply while inputs wait (coalesced with a queued one). */
async function continueWithWaiting(tx: Tx, botId: string) {
  const waiting =
    (await pendingTaskUpdates(tx, botId)).length > 0 ||
    (await waitingMessages(tx, botId)).length > 0;
  if (!waiting) return;
  await enqueue(tx, { kind: "chat.reply", botId });
  await wakeWorkers(tx);
}

/** Titles of the tasks the history's messages link to, by id. */
async function taskCards(exec: Executor, history: ConversationMessageRow[]) {
  const ids = [...new Set(history.flatMap((message) => message.taskId ?? []))];
  if (ids.length === 0) return new Map<string, string>();
  const rows = await exec
    .select({ id: tasks.id, title: tasks.title })
    .from(tasks)
    .where(inArray(tasks.id, ids));
  return new Map(rows.map((row) => [row.id, row.title]));
}

/**
 * A past message as the model sees it: a reply with a task card says which
 * task, as the user sees the card under it, so a follow-up can name it.
 */
function withCard(
  message: ConversationMessageRow,
  cards: Map<string, string>,
  redact: (text: string) => string,
) {
  if (message.role !== "assistant" || !message.taskId) return message.text;
  const title = cards.get(message.taskId);
  return `${message.text}\n\n[Task card: ${message.taskId}${title === undefined ? "" : ` ${JSON.stringify(redact(title))}`}]`;
}

/** The bot's unfinished tasks, and how many of them it coordinates. */
async function unfinishedTasks(exec: Executor, botId: string) {
  const [row] = await exec
    .select({
      total: count(),
      coordinated: sql<number>`count(*) filter (where ${tasks.coordinatorBotId} = ${botId})`,
    })
    .from(taskParticipants)
    .innerJoin(tasks, eq(tasks.id, taskParticipants.taskId))
    .where(
      and(
        eq(taskParticipants.botId, botId),
        notInArray(tasks.status, [...FINISHED_TASK_STATUSES]),
      ),
    );
  return {
    total: Number(row?.total ?? 0),
    coordinated: Number(row?.coordinated ?? 0),
  };
}

async function storeMessage(
  tx: Tx,
  ctx: EngineContext,
  botId: string,
  values: { id: string; text: string; taskId: string | null },
) {
  const sequence = await nextConversationSequence(tx, botId);
  await tx.insert(conversationMessages).values({
    id: values.id,
    botId,
    sequence,
    role: "assistant",
    text: values.text.trim() ? values.text : "(no text)",
    taskId: values.taskId,
    createdAt: ctx.clock(),
  });
}

async function storeUsage(
  tx: Tx,
  ctx: EngineContext,
  botId: string,
  reply: ChatReply,
) {
  await tx.insert(usage).values({
    id: ctx.ids("usage"),
    taskId: null,
    botId,
    model: reply.model,
    inputTokens: reply.usage.inputTokens,
    outputTokens: reply.usage.outputTokens,
    cacheReadTokens: reply.usage.cacheReadTokens,
    cacheWriteTokens: reply.usage.cacheWriteTokens,
    costUsd: reply.usage.costUsd,
    createdAt: ctx.clock(),
  });
}

/** Posts the update as the engine's plain message; false when it was already told. */
async function postFallback(
  tx: Tx,
  ctx: EngineContext,
  botId: string,
  update: PendingUpdate,
  redact: (text: string) => string,
): Promise<boolean> {
  const id = ctx.ids("conversationMessage");
  if (!(await answerTaskUpdate(tx, ctx, update.id, id))) return false;
  await storeMessage(tx, ctx, botId, {
    id,
    text: fallbackText(update, redact),
    taskId: update.taskId,
  });
  return true;
}

export async function runChatJob(
  deps: WorkerDeps,
  responder: ChatResponder,
  job: ClaimedJob,
  control: JobControl,
): Promise<void> {
  const { ctx } = deps;
  const botId = job.botId as string;
  const write = <T>(fn: (tx: Tx) => Promise<T>) =>
    fencedWrite(ctx, job.lease, control, fn);
  let input: ChatInput | undefined;
  let redact: (text: string) => string = (text) => text;
  try {
    const [bot] = await ctx.db
      .select()
      .from(bots)
      .where(and(eq(bots.id, botId), isNull(bots.archivedAt)));
    const history = bot
      ? await conversationHistory(ctx.db, botId, ctx.config.chatHistoryLimit)
      : [];
    input = bot ? await nextInput(ctx.db, botId) : undefined;
    if (!bot || !input) {
      // Archived, or a coalesced wake whose input was already answered.
      await write((tx) => complete(tx, job.lease));
      return;
    }
    const redactor = await ctx.redactor();
    redact = (text) => redactor(text);
    // Recorded before the model call, so a job given up after crashes says what it answered.
    const answering =
      input.kind === "user"
        ? (input.waiting.at(-1) as ConversationMessageRow).id
        : input.update.id;
    await write((tx) =>
      tx
        .update(jobs)
        .set({ payload: { ...job.payload, answering } })
        .where(eq(jobs.id, job.id)),
    );

    const everyone = await activeBotRows(ctx.db);
    const memory = await memoryText(ctx.db, botId);
    const state: ChatState = { triggerId: answering, linkedTaskId: null };
    const tools =
      input.kind === "user"
        ? chatTools({ ctx, write, bot, redact, everyone, state })
        : chatReadTools({ ctx, bot, redact });
    // The waiting messages go last, after any reply stored while they waited.
    const waitingIds = new Set(
      input.kind === "user" ? input.waiting.map((message) => message.id) : [],
    );
    const cards = await taskCards(ctx.db, history);
    const past = [
      ...history.filter((message) => !waitingIds.has(message.id)),
      ...(input.kind === "user" ? input.waiting : []),
    ].map((message) => ({
      role: message.role,
      text: withCard(message, cards, redact),
    }));
    const reply = await responder.reply({
      systemPrompt: chatPrompt({
        bot,
        memory: memory?.text ?? "",
        team: everyone
          .filter((other) => other.id !== botId)
          .map((other) => ({ name: other.name, role: other.role })),
        unfinishedTasks: await unfinishedTasks(ctx.db, botId),
      }),
      history:
        input.kind === "user"
          ? past
          : [
              ...past,
              { role: "user", text: updateInput(input.update, redact) },
            ],
      model: bot.model,
      tools,
      budgets: {
        maxTurns: ctx.config.chatMaxTurns,
        deadline: new Date(Date.now() + ctx.config.chatTimeoutMs),
      },
      signal: control.controller.signal,
    });
    if (control.reason) throw control.controller.signal.reason;
    const answered = input;
    await write(async (tx) => {
      const id = ctx.ids("conversationMessage");
      const told =
        answered.kind === "user" ||
        (await answerTaskUpdate(tx, ctx, answered.update.id, id));
      if (told) {
        await storeMessage(tx, ctx, botId, {
          id,
          text: reply.text,
          taskId:
            answered.kind === "user"
              ? state.linkedTaskId
              : answered.update.taskId,
        });
        await storeUsage(tx, ctx, botId, reply);
      }
      if (answered.kind === "user")
        await markHandled(
          tx,
          ctx,
          botId,
          (answered.waiting.at(-1) as ConversationMessageRow).sequence,
        );
      await complete(tx, job.lease);
      await continueWithWaiting(tx, botId);
      await hint(tx, { type: "conversation.changed", botId });
    });
  } catch (error) {
    if (control.fenced || error instanceof LeaseLostError) return;
    if (control.reason === "shutdown") {
      // Hand the reply to the next worker.
      await write(async (tx) => {
        await complete(tx, job.lease);
        await enqueue(tx, { kind: "chat.reply", botId });
        await wakeWorkers(tx);
      }).catch(() => {});
      return;
    }
    const code = (error as { code?: unknown } | undefined)?.code;
    const reason =
      typeof code === "string"
        ? `Reply failed (${code}): ${errorMessage(error)}`
        : errorMessage(error);
    const failed = input;
    await write(async (tx) => {
      // The update is never lost: the engine tells it plainly instead.
      if (failed?.kind === "update")
        await postFallback(tx, ctx, botId, failed.update, redact);
      if (failed?.kind === "user")
        await markHandled(
          tx,
          ctx,
          botId,
          (failed.waiting.at(-1) as ConversationMessageRow).sequence,
        );
      await fail(tx, job.lease, reason);
      await continueWithWaiting(tx, botId);
      await hint(tx, { type: "conversation.changed", botId });
    }).catch((failure: unknown) => {
      if (!(failure instanceof LeaseLostError)) throw failure;
    });
  }
}

/**
 * A chat reply whose lease expired too often (claim failed it): what it was
 * answering is given up, so it cannot keep killing workers. Its update is
 * posted as the engine's fallback, without a model call; its user messages
 * count as taken up, like a failed reply's. Anything else waiting gets a new
 * reply job.
 */
export async function giveUpChatReply(
  ctx: EngineContext,
  job: JobRow,
): Promise<void> {
  const botId = job.botId;
  if (!botId) return;
  const answering =
    typeof job.payload.answering === "string" ? job.payload.answering : null;
  const redactor = await ctx.redactor();
  await ctx.db.transaction(async (tx) => {
    if (answering) {
      const update = await pendingTaskUpdate(tx, answering);
      if (update)
        await postFallback(tx, ctx, botId, update, (text) => redactor(text));
      const [message] = await tx
        .select({ sequence: conversationMessages.sequence })
        .from(conversationMessages)
        .where(
          and(
            eq(conversationMessages.botId, botId),
            eq(conversationMessages.id, answering),
          ),
        );
      if (message) await markHandled(tx, ctx, botId, message.sequence);
    }
    await continueWithWaiting(tx, botId);
    await hint(tx, { type: "conversation.changed", botId });
  });
}
