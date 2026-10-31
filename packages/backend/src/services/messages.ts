// Task messages, inbox delivery and user steering. Visibility is not
// activation: every message is visible to the task, and only a delivery with
// `wake` enqueues work, always in the same transaction as the inbox item.
import {
  isFinishedStatus,
  type PostTaskMessageCommand,
  postTaskMessageCommandSchema,
  type TaskMessage,
} from "@jj/contracts";
import {
  type AuthorKind,
  enqueue,
  type InboxKind,
  type MessageIntent,
  nextMessageSequence,
  notify,
  type SessionRow,
  sessionInbox,
  sessions,
  type TaskMessageRow,
  type TaskRow,
  taskGoalVersions,
  taskMessages,
  type Tx,
} from "@jj/db";
import { and, eq, isNull } from "drizzle-orm";
import type { EngineContext } from "../context";
import { DomainError, notFound, parseCommand } from "../errors";
import { type Attribution, emit, wakeWorkers } from "../events";
import { toMessage } from "../records";
import { lockTask, updateSession, updateTask } from "./sessions";

export interface PostMessageInput {
  taskId: string;
  authorKind: AuthorKind;
  authorBotId?: string | null;
  sessionId?: string | null;
  intent: MessageIntent;
  text: string;
  recipientBotIds?: string[];
}

/** Inserts a task message (sequence allocated per task) and emits `message.posted`. */
export async function postMessage(
  tx: Tx,
  ctx: EngineContext,
  input: PostMessageInput,
  attribution: Attribution = {},
): Promise<TaskMessageRow> {
  const sequence = await nextMessageSequence(tx, input.taskId);
  const [row] = await tx
    .insert(taskMessages)
    .values({
      id: ctx.ids("taskMessage"),
      taskId: input.taskId,
      sequence,
      authorKind: input.authorKind,
      authorBotId: input.authorBotId ?? null,
      sessionId: input.sessionId ?? null,
      intent: input.intent,
      text: input.text.trim() ? input.text : "(no text)",
      recipientBotIds: [...new Set(input.recipientBotIds ?? [])],
    })
    .returning();
  if (!row) throw new Error("The message insert returned no row.");
  await emit(tx, input.taskId, {
    type: "message.posted",
    payload: { message: toMessage(row) },
    botId: input.authorBotId ?? null,
    sessionId: input.sessionId ?? null,
    runId: attribution.runId,
    causedBy: attribution.causedBy,
  });
  return row;
}

export type Delivery = "injected" | "queued" | "stored";

/**
 * Puts an item in a session's inbox. With `wake`, also enqueues a run in the
 * same transaction: a run already queued coalesces it, and a running session
 * drains it at its next turn boundary (the queued run then finds nothing and
 * completes as a no-op), so no wake is lost. Without `wake` the item waits
 * for the session's next activation (notification semantics).
 */
export async function deliver(
  tx: Tx,
  session: SessionRow,
  item: { kind: InboxKind; text: string; sourceMessageId?: string | null },
  options: { wake: boolean; ctx: EngineContext },
): Promise<Delivery> {
  await tx.insert(sessionInbox).values({
    id: options.ctx.ids("inboxItem"),
    sessionId: session.id,
    taskId: session.taskId,
    kind: item.kind,
    text: item.text,
    sourceMessageId: item.sourceMessageId ?? null,
    createdAt: options.ctx.clock(),
  });
  if (isFinishedStatus(session.status)) return "stored";
  if (options.wake) {
    await enqueue(tx, {
      kind: "session.run",
      taskId: session.taskId,
      sessionId: session.id,
    });
    await wakeWorkers(tx, session.taskId);
  }
  if (session.status === "running") {
    await notify(tx, "jj_control", {
      kind: "steer",
      taskId: session.taskId,
      sessionId: session.id,
    });
    return "injected";
  }
  return options.wake ? "queued" : "stored";
}

export async function rootSession(
  tx: Tx,
  taskId: string,
): Promise<SessionRow | undefined> {
  const [row] = await tx
    .select()
    .from(sessions)
    .where(and(eq(sessions.taskId, taskId), isNull(sessions.parentSessionId)));
  return row;
}

/**
 * A message that continues the task: reopens a waiting, completed or failed
 * task (and its coordinator session) and wakes the coordinator. Refused with
 * TASK_TERMINAL once the task is cancelled or being stopped.
 */
export async function continueTask(
  tx: Tx,
  ctx: EngineContext,
  task: TaskRow,
  attribution: Attribution = {},
): Promise<{ task: TaskRow; root: SessionRow }> {
  assertOpen(task);
  let root = await rootSession(tx, task.id);
  if (!root) throw new Error(`Task ${task.id} has no coordinator session.`);
  if (
    task.status === "waiting" ||
    task.status === "completed" ||
    task.status === "failed"
  ) {
    const previous = task.status;
    task = await updateTask(
      tx,
      ctx,
      task,
      { status: "running", result: null, error: null },
      attribution,
    );
    await emit(tx, task.id, {
      type: "task.reopened",
      payload: { previous },
      ...attribution,
    });
  }
  if (isFinishedStatus(root.status))
    root = await updateSession(
      tx,
      ctx,
      root,
      {
        status: "queued",
        result: null,
        error: null,
        completionRequested: null,
      },
      attribution,
    );
  return { task, root };
}

/** TASK_TERMINAL for a cancelled task or one being stopped. */
export function assertOpen(task: TaskRow) {
  if (task.status === "cancelled" || task.cancelRequestedAt)
    throw new DomainError(
      "TASK_TERMINAL",
      task.status === "cancelled"
        ? "The task was cancelled; start a new task to continue the work."
        : "The task is stopping and takes no new messages.",
    );
}

/** `POST /api/tasks/:id/messages`: user steering to the coordinator. */
export async function postTaskMessage(
  ctx: EngineContext,
  taskId: string,
  input: PostTaskMessageCommand,
): Promise<{ message: TaskMessage }> {
  const command = parseCommand(postTaskMessageCommandSchema, input);
  if (command.verificationPlan)
    throw new DomainError(
      "VERIFICATION_UNAVAILABLE",
      "Verification plans are not enforced by this server yet.",
    );
  const message = await ctx.db.transaction(async (tx) => {
    let task = await lockTask(tx, taskId);
    if (!task) throw notFound("Task", taskId);
    assertOpen(task);

    let goalChange: { goal: string; version: number } | undefined;
    if (command.goal !== undefined && command.goal !== task.goal) {
      if (command.observedGoalVersion !== task.goalVersion)
        throw new DomainError(
          "STALE_GOAL_VERSION",
          `The goal is at version ${task.goalVersion}; you edited version ${command.observedGoalVersion}.`,
          { goalVersion: task.goalVersion },
        );
      if (task.goalVersion >= ctx.config.maxGoalVersions)
        throw new DomainError(
          "GOAL_VERSION_BUDGET",
          `The goal can change at most ${ctx.config.maxGoalVersions - 1} times; start a new task instead.`,
        );
      const version = task.goalVersion + 1;
      await tx.insert(taskGoalVersions).values({
        taskId,
        version,
        goal: command.goal,
        author: "user",
        createdAt: ctx.clock(),
      });
      task = await updateTask(tx, ctx, task, {
        goal: command.goal,
        goalVersion: version,
      });
      await emit(tx, taskId, {
        type: "task.goal_changed",
        payload: { goal: command.goal, goalVersion: version },
      });
      goalChange = { goal: command.goal, version };
    }
    const continued = await continueTask(tx, ctx, task);
    task = continued.task;
    const row = await postMessage(tx, ctx, {
      taskId,
      authorKind: "user",
      intent: "steering",
      text: command.text,
      recipientBotIds: [task.coordinatorBotId],
    });
    const text = goalChange
      ? `The user changed the task goal (now version ${goalChange.version}):\n${goalChange.goal}\n\nTheir message:\n${command.text}`
      : `Message from the user:\n${command.text}`;
    const delivered = await deliver(
      tx,
      continued.root,
      { kind: "steering", text, sourceMessageId: row.id },
      { wake: true, ctx },
    );
    await emit(tx, taskId, {
      type: "steering.received",
      payload: {
        messageId: row.id,
        goalVersion: task.goalVersion,
        delivered: delivered === "injected" ? "injected" : "queued",
      },
      botId: task.coordinatorBotId,
      sessionId: continued.root.id,
      causedBy: null,
    });
    return row;
  });
  return { message: toMessage(message) };
}
