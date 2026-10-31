// One `chat.reply` job: the bot answers its direct chat with the user. It can
// create a task (rate-limited per bot, counted under the bot row lock) or
// forward a follow-up to one of its active tasks.
import { isFinishedStatus } from "@jj/contracts";
import {
  bots,
  type ClaimedJob,
  complete,
  conversationMessages,
  enqueue,
  fail,
  nextConversationSequence,
  type Tx,
  tasks,
  taskParticipants,
  usage,
} from "@jj/db";
import { and, count, eq, gt, inArray, isNull } from "drizzle-orm";
import type { EngineContext } from "../context";
import { DomainError, errorMessage } from "../errors";
import { hint, wakeWorkers } from "../events";
import { activeBotRows, memoryText, presenceOf } from "../services/bots";
import { conversationHistory } from "../services/chat";
import { continueTask, deliver, postMessage } from "../services/messages";
import { lockTask } from "../services/sessions";
import { createTaskTx } from "../services/tasks";
import type { ChatResponder, CollabTool, CollabToolResult } from "../ports";
import { chatPrompt } from "./prompts";
import {
  fencedWrite,
  type JobControl,
  LeaseLostError,
  type WorkerDeps,
} from "./run-context";

const HOUR_MS = 60 * 60_000;
const refuse = (text: string): CollabToolResult => ({ text, isError: true });

interface ChatState {
  /** The task the reply created or forwarded to. */
  linkedTaskId: string | null;
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
  try {
    const [bot] = await ctx.db
      .select()
      .from(bots)
      .where(and(eq(bots.id, botId), isNull(bots.archivedAt)));
    const history = bot
      ? await conversationHistory(ctx.db, botId, ctx.config.chatHistoryLimit)
      : [];
    if (!bot || history.at(-1)?.role !== "user") {
      // Archived, or a coalesced wake whose message was already answered.
      await write((tx) => complete(tx, job.lease));
      return;
    }
    const everyone = await activeBotRows(ctx.db);
    const presence = await presenceOf(ctx.db, [botId]);
    const activeIds = presence.get(botId)?.activeTaskIds ?? [];
    const active =
      activeIds.length > 0
        ? await ctx.db.select().from(tasks).where(inArray(tasks.id, activeIds))
        : [];
    const memory = await memoryText(ctx.db, botId);
    const state: ChatState = { linkedTaskId: null };
    const tools: CollabTool[] = [
      createTaskTool(ctx, write, bot, everyone, state),
    ];
    if (active.length > 0)
      tools.push(sendToTaskTool(ctx, write, bot, active, state));

    const reply = await responder.reply({
      systemPrompt: chatPrompt({
        bot,
        memory: memory?.text ?? "",
        team: everyone
          .filter((other) => other.id !== botId)
          .map((other) => ({ name: other.name, role: other.role })),
        activeTasks: active.map((task) => ({
          id: task.id,
          title: task.title,
          status: task.status,
          coordinator: task.coordinatorBotId === botId,
        })),
      }),
      history: history.map((message) => ({
        role: message.role,
        text: message.text,
      })),
      model: bot.model,
      tools,
      budgets: {
        maxTurns: ctx.config.chatMaxTurns,
        deadline: new Date(Date.now() + ctx.config.chatTimeoutMs),
      },
      signal: control.controller.signal,
    });
    if (control.reason) throw control.controller.signal.reason;
    await write(async (tx) => {
      const sequence = await nextConversationSequence(tx, botId);
      await tx.insert(conversationMessages).values({
        id: ctx.ids("conversationMessage"),
        botId,
        sequence,
        role: "assistant",
        text: reply.text.trim() ? reply.text : "(no text)",
        taskId: state.linkedTaskId,
        createdAt: ctx.clock(),
      });
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
      await complete(tx, job.lease);
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
    await write(async (tx) => {
      await fail(tx, job.lease, reason);
      await hint(tx, { type: "conversation.changed", botId });
    }).catch((failure: unknown) => {
      if (!(failure instanceof LeaseLostError)) throw failure;
    });
  }
}

type Write = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

function createTaskTool(
  ctx: EngineContext,
  write: Write,
  bot: { id: string; name: string },
  everyone: readonly { id: string; name: string; model: string | null }[],
  state: ChatState,
): CollabTool {
  const names = everyone.map((member) => member.name);
  return {
    name: "create_task",
    description:
      "Start a task that you coordinate, for work that needs commands or files. Call it once per request.",
    parameters: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description:
            "What the task must achieve, with any acceptance criteria.",
        },
        title: { type: "string", description: "A short title (optional)." },
        participants: {
          type: "array",
          items: { type: "string", enum: names },
          description:
            "Teammates who should help, by name. You are always included.",
        },
      },
      required: ["goal", "participants"],
      additionalProperties: false,
    },
    summarize: (args) =>
      String(args.title ?? args.goal ?? "a task").slice(0, 120),
    async execute(args) {
      const goal = typeof args.goal === "string" ? args.goal.trim() : "";
      if (!goal) return refuse("Give the task a goal.");
      const wanted = Array.isArray(args.participants)
        ? args.participants.map(String)
        : [];
      const chosen = wanted.map((name) =>
        everyone.find(
          (member) => member.name.toLowerCase() === name.trim().toLowerCase(),
        ),
      );
      const unknown = wanted.filter((_, index) => !chosen[index]);
      if (unknown.length > 0)
        return refuse(
          `No bot named ${unknown.join(", ")}. Choose from: ${names.join(", ")}.`,
        );
      for (const member of chosen) {
        if (!member) continue;
        try {
          ctx.models.resolve(member.model);
        } catch (error) {
          return refuse(`${member.name} cannot run: ${errorMessage(error)}`);
        }
      }
      return write(async (tx) => {
        // Lock the bot row, then count, so concurrent creations cannot both pass.
        await tx
          .select({ id: bots.id })
          .from(bots)
          .where(eq(bots.id, bot.id))
          .for("update");
        const since = new Date(ctx.clock().getTime() - HOUR_MS);
        const [recent] = await tx
          .select({ value: count() })
          .from(tasks)
          .where(
            and(eq(tasks.createdByBotId, bot.id), gt(tasks.createdAt, since)),
          );
        if ((recent?.value ?? 0) >= ctx.config.tasksPerBotPerHour)
          return refuse(
            `You have created ${recent?.value} tasks in the last hour, the limit. Tell the user to wait or start the task themselves.`,
          );
        const { task } = await createTaskTx(tx, ctx, {
          goal,
          title:
            typeof args.title === "string"
              ? args.title.slice(0, 120)
              : undefined,
          coordinatorBotId: bot.id,
          participantBotIds: chosen.flatMap((member) =>
            member ? [member.id] : [],
          ),
          createdByBotId: bot.id,
        });
        state.linkedTaskId = task.id;
        return {
          text: `Created task "${task.title}" (${task.id}). You coordinate it; it has started.`,
        };
      });
    },
  };
}

function sendToTaskTool(
  ctx: EngineContext,
  write: Write,
  bot: { id: string; name: string },
  active: readonly { id: string; title: string }[],
  state: ChatState,
): CollabTool {
  return {
    name: "send_to_task",
    description: `Forward the user's message to one of your active tasks; its coordinator picks it up. Active tasks:\n${active.map((task) => `- ${task.id}: ${task.title}`).join("\n")}`,
    parameters: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          enum: active.map((task) => task.id),
          description: "The task to send it to.",
        },
        text: { type: "string", description: "What to tell the task." },
      },
      required: ["taskId", "text"],
      additionalProperties: false,
    },
    summarize: (args) => String(args.taskId ?? ""),
    async execute(args) {
      const taskId = typeof args.taskId === "string" ? args.taskId : "";
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (!text) return refuse("The message is empty.");
      return write(async (tx) => {
        const task = await lockTask(tx, taskId);
        if (!task) return refuse(`There is no task ${taskId}.`);
        const [member] = await tx
          .select({ botId: taskParticipants.botId })
          .from(taskParticipants)
          .where(
            and(
              eq(taskParticipants.taskId, taskId),
              eq(taskParticipants.botId, bot.id),
            ),
          );
        if (!member) return refuse("You do not take part in that task.");
        if (isFinishedStatus(task.status) && task.status !== "cancelled")
          return refuse("That task has finished; create a new one instead.");
        let root: Awaited<ReturnType<typeof continueTask>>["root"];
        try {
          root = (await continueTask(tx, ctx, task)).root;
        } catch (error) {
          if (error instanceof DomainError) return refuse(error.message);
          throw error;
        }
        const message = await postMessage(tx, ctx, {
          taskId,
          authorKind: "bot",
          authorBotId: bot.id,
          intent: "discussion",
          text,
          recipientBotIds: [task.coordinatorBotId],
        });
        await deliver(
          tx,
          root,
          {
            kind: "steering",
            text: `Message from ${bot.name}, relayed from the user's direct chat:\n${text}`,
            sourceMessageId: message.id,
          },
          { wake: true, ctx },
        );
        state.linkedTaskId = taskId;
        return { text: `Sent to the task "${task.title}".` };
      });
    },
  };
}
