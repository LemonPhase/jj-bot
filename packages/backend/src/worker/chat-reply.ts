// One `chat.reply` job: the bot answers its direct chat. A job answers one
// input: the user's unanswered message (with every chat task tool), else the
// oldest unanswered task update (with the read tools only). Jobs of one bot
// run one at a time, so an update that arrives during a reply is answered
// after it, by a reply that sees both. While more inputs wait, each job
// enqueues the next. An update whose reply fails is still told: the engine
// posts it as a plain message instead.

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
  jobs,
  nextConversationSequence,
  type Tx,
  taskParticipants,
  tasks,
  usage,
} from "@jj/db";
import { and, count, eq, isNull, notInArray, sql } from "drizzle-orm";
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
  | { kind: "user"; message: ConversationMessageRow }
  /** `gaveUp`: an earlier job died answering it too often; post the fallback. */
  | { kind: "update"; update: PendingUpdate; gaveUp: boolean };

/**
 * Whether a failed reply job of the bot was answering this input (its id is
 * in the job's payload). A failed user message is not answered again until
 * the user writes more; an update is then posted as the fallback.
 */
async function gaveUpOn(exec: Executor, botId: string, inputId: string) {
  const [row] = await exec
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.botId, botId),
        eq(jobs.kind, "chat.reply"),
        eq(jobs.status, "failed"),
        sql`${jobs.payload}->>'answering' = ${inputId}`,
      ),
    )
    .limit(1);
  return row !== undefined;
}

async function nextInput(
  exec: Executor,
  botId: string,
  history: ConversationMessageRow[],
): Promise<ChatInput | undefined> {
  const last = history.at(-1);
  if (last?.role === "user" && !(await gaveUpOn(exec, botId, last.id)))
    return { kind: "user", message: last };
  const [update] = await pendingTaskUpdates(exec, botId);
  if (update)
    return {
      kind: "update",
      update,
      gaveUp: await gaveUpOn(exec, botId, update.id),
    };
  return undefined;
}

/** Enqueues the bot's next reply while task updates wait (coalesced with a queued one). */
async function continueWithUpdates(tx: Tx, botId: string) {
  if ((await pendingTaskUpdates(tx, botId)).length === 0) return;
  await enqueue(tx, { kind: "chat.reply", botId });
  await wakeWorkers(tx);
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
    input = bot ? await nextInput(ctx.db, botId, history) : undefined;
    if (!bot || !input) {
      // Archived, or a coalesced wake whose input was already answered.
      await write((tx) => complete(tx, job.lease));
      return;
    }
    const redactor = await ctx.redactor();
    redact = (text) => redactor(text);
    if (input.kind === "update" && input.gaveUp) {
      const update = input.update;
      await write(async (tx) => {
        await postFallback(tx, ctx, botId, update, redact);
        await complete(tx, job.lease);
        await continueWithUpdates(tx, botId);
        await hint(tx, { type: "conversation.changed", botId });
      });
      return;
    }
    // Recorded before the model call, so a failed or abandoned job says what it answered.
    const answering =
      input.kind === "user" ? input.message.id : input.update.id;
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
    const past = history.map((message) => ({
      role: message.role,
      text: message.text,
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
      await complete(tx, job.lease);
      await continueWithUpdates(tx, botId);
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
      await fail(tx, job.lease, reason);
      await continueWithUpdates(tx, botId);
      await hint(tx, { type: "conversation.changed", botId });
    }).catch((failure: unknown) => {
      if (!(failure instanceof LeaseLostError)) throw failure;
    });
  }
}
