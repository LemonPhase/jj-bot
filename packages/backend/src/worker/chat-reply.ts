// One `chat.reply` job: the bot answers its direct chat. A job answers one
// input: the user's waiting messages (with every chat task tool), else the
// oldest unanswered task update (with the read tools only). Jobs of one bot
// run one at a time, so an update that arrives during a reply is answered
// after it, by a reply that sees both, and so is a user message. While more
// inputs wait, each job enqueues the next. An update whose reply fails is
// still told: the engine posts it as a plain message instead.

import { FINISHED_TASK_STATUSES, type Usage } from "@jj/contracts";
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
import { ActivityTrace, SPANS } from "../observability/tracing";
import type { ChatResponder } from "../ports";
import { activeBotRows, memoryText } from "../services/bots";
import { conversationHistory } from "../services/chat";
import { spendStop } from "../services/spend";
import {
  answerTaskUpdate,
  fallbackText,
  isOvertaken,
  type PendingUpdate,
  pendingTaskUpdate,
  pendingTaskUpdates,
  updateInput,
} from "../services/task-updates";
import { appendEntry, modelHistory, stripCardNotes } from "./chat-history";
import { type ChatState, chatReadTools, chatTools } from "./chat-tools";
import { chatPrompt } from "./prompts";
import {
  fencedWrite,
  type JobControl,
  LeaseLostError,
  outcomeLabel,
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

/** The one task a reply looked up, if it looked up exactly one: its card goes under the answer. */
const onlyTaskLookedAt = (state: ChatState) =>
  state.lookedAt.size === 1 ? ([...state.lookedAt][0] ?? null) : null;

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
    // The engine attaches the card; a note the model imitated is not stored.
    text: stripCardNotes(values.text) || "(no text)",
    taskId: values.taskId,
    createdAt: ctx.clock(),
  });
}

/** One model call of a reply, recorded as it finishes (task-less: direct chat). */
async function storeUsage(
  tx: Tx,
  ctx: EngineContext,
  botId: string,
  used: Usage,
  model: string,
) {
  await tx.insert(usage).values({
    id: ctx.ids("usage"),
    taskId: null,
    botId,
    model,
    inputTokens: used.inputTokens,
    outputTokens: used.outputTokens,
    cacheReadTokens: used.cacheReadTokens,
    cacheWriteTokens: used.cacheWriteTokens,
    costUsd: used.costUsd,
    priced: used.unpricedCalls === 0,
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
  /** The reply's span; none when there was nothing to answer. */
  let activity: ActivityTrace | undefined;
  let result = "error";
  let errorCode: string | undefined;
  const startedAt = performance.now();
  try {
    const [bot] = await ctx.db
      .select()
      .from(bots)
      .where(and(eq(bots.id, botId), isNull(bots.archivedAt)));
    const history = bot
      ? await conversationHistory(ctx.db, botId, ctx.config.chatHistoryLimit)
      : [];
    input = bot ? await nextInput(ctx.db, botId) : undefined;
    // A waiting update whose question was answered meanwhile is not told.
    while (input?.kind === "update" && isOvertaken(input.update)) {
      const overtaken = input.update.id;
      await write((tx) => answerTaskUpdate(tx, ctx, overtaken, null));
      input = await nextInput(ctx.db, botId);
    }
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
    const state: ChatState = {
      triggerId: answering,
      linkedTaskId: null,
      lookedAt: new Set(),
    };
    const tools =
      input.kind === "user"
        ? chatTools({ ctx, write, bot, redact, everyone, state })
        : chatReadTools({ ctx, bot, redact, state });
    const trace = new ActivityTrace(ctx.tracer, ctx.metrics, SPANS.chatReply, {
      "jj.bot.id": botId,
      "jj.job.id": job.id,
      ...(input.kind === "update" ? { "jj.task.id": input.update.taskId } : {}),
    });
    trace.declareTools(tools.map((tool) => tool.name));
    activity = trace;
    ctx.logger.info("Chat reply started", {
      answering: input.kind === "user" ? "messages" : "task update",
    });
    // The waiting messages go last, after any reply stored while they waited.
    const waitingIds = new Set(
      input.kind === "user" ? input.waiting.map((message) => message.id) : [],
    );
    const past = modelHistory(
      [
        ...history.filter((message) => !waitingIds.has(message.id)),
        ...(input.kind === "user" ? input.waiting : []),
      ],
      await taskCards(ctx.db, history),
      redact,
    );
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
          : appendEntry(past, {
              role: "user",
              text: updateInput(input.update, redact),
            }),
      model: bot.model,
      tools,
      budgets: {
        maxTurns: ctx.config.chatMaxTurns,
        deadline: new Date(Date.now() + ctx.config.chatTimeoutMs),
      },
      signal: control.controller.signal,
      // User replies and update replies alike: the bot's and the instance's
      // daily caps (a reply has no task). A refused call is never made.
      admitModelCall: async () => {
        const stop = await spendStop(ctx.db, ctx, { botId });
        return stop ? `${stop.message} ${stop.advice}` : undefined;
      },
      // Each call is recorded as it finishes, and only here: a reply that
      // fails, or whose update is overtaken, still counts every call it made.
      onUsage: (used, model) => {
        ctx.metrics.modelCall(model, used);
        return write((tx) => storeUsage(tx, ctx, botId, used, model));
      },
      onActivity: (event) => trace.observe(event),
    });
    if (control.reason) throw control.controller.signal.reason;
    const answered = input;
    await write(async (tx) => {
      const id = ctx.ids("conversationMessage");
      const told =
        answered.kind === "user" ||
        (await answerTaskUpdate(tx, ctx, answered.update.id, id));
      // An update overtaken during the reply is not told; its model calls
      // were recorded as they finished (onUsage).
      if (told)
        await storeMessage(tx, ctx, botId, {
          id,
          text: reply.text,
          taskId:
            answered.kind === "user"
              ? (state.linkedTaskId ?? onlyTaskLookedAt(state))
              : answered.update.taskId,
        });
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
    result = "ok";
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
    if (typeof code === "string") errorCode = code;
    const reason =
      code === "spend_cap"
        ? `Not answered: ${errorMessage(error)}`
        : typeof code === "string"
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
  } finally {
    if (activity) {
      const outcome = outcomeLabel(control.reason, result);
      const seconds = (performance.now() - startedAt) / 1000;
      activity.end(outcome, outcome === "error", {
        ...(errorCode ? { "jj.error.code": errorCode } : {}),
      });
      const used = activity.usage;
      ctx.logger.info("Chat reply finished", {
        outcome,
        ...(errorCode ? { errorCode } : {}),
        durationMs: Math.round(seconds * 1000),
        modelCalls: used.modelCalls,
        toolCalls: used.toolCalls,
        inputTokens: used.input,
        outputTokens: used.output,
        costUsd: used.cost,
      });
    }
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
