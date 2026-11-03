// Task messages, inbox delivery and user steering. Visibility is not
// activation: every message is visible to the task, and only a delivery with
// `wake` enqueues work, always in the same transaction as the inbox item.
import {
  isFinishedStatus,
  type PostTaskMessageCommand,
  postTaskMessageCommandSchema,
  samePlan,
  type TaskMessage,
  type VerificationPlan,
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
  type Tx,
  taskGoalVersions,
  taskMessages,
} from "@jj/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { EngineContext } from "../context";
import { DomainError, notFound, parseCommand } from "../errors";
import { type Attribution, emit, wakeWorkers } from "../events";
import { planOf, toMessage } from "../records";
import { expireApprovals, pendingApproval } from "./approvals";
import { lockTask, updateSession, updateTask } from "./sessions";
import { assertWithinCaps } from "./spend";
import { describePlan } from "./verification";

export interface PostMessageInput {
  taskId: string;
  authorKind: AuthorKind;
  authorBotId?: string | null;
  sessionId?: string | null;
  intent: MessageIntent;
  text: string;
  recipientBotIds?: string[];
  /** The conversation message a bot relayed (one relay per message and task). */
  relayedFromMessageId?: string | null;
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
      relayedFromMessageId: input.relayedFromMessageId ?? null,
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

/** Undelivered notifications a session keeps; older ones collapse into one line. */
export const MAX_PENDING_MESSAGES = 20;

const OMITTED = /^\[(\d+) earlier messages? omitted\]$/;
const omittedLine = (count: number) =>
  `[${count} earlier message${count === 1 ? "" : "s"} omitted]`;

/**
 * Keeps a session's undelivered `message` items to the newest
 * MAX_PENDING_MESSAGES, so broadcasts cannot pile up without bound in a
 * waiting session. The older ones become a single "N earlier messages
 * omitted" item in their place, ahead of the kept ones.
 */
async function capPendingMessages(tx: Tx, sessionId: string) {
  const pending = await tx
    .select({
      id: sessionInbox.id,
      text: sessionInbox.text,
      sourceMessageId: sessionInbox.sourceMessageId,
    })
    .from(sessionInbox)
    .where(
      and(
        eq(sessionInbox.sessionId, sessionId),
        isNull(sessionInbox.deliveredAt),
        eq(sessionInbox.kind, "message"),
      ),
    )
    .orderBy(desc(sessionInbox.createdAt), desc(sessionInbox.id));
  const isSummary = (item: (typeof pending)[number]) =>
    item.sourceMessageId === null && OMITTED.test(item.text);
  const summary = pending.find(isSummary);
  const messages = pending.filter((item) => !isSummary(item));
  const dropped = messages.slice(MAX_PENDING_MESSAGES);
  const [newest, ...older] = dropped;
  if (!newest) return;
  const earlier = Number(summary ? OMITTED.exec(summary.text)?.[1] : 0);
  // The newest dropped item becomes the summary, so it keeps its place.
  await tx
    .update(sessionInbox)
    .set({
      text: omittedLine(earlier + dropped.length),
      sourceMessageId: null,
    })
    .where(eq(sessionInbox.id, newest.id));
  const gone = [...older, ...(summary ? [summary] : [])].map((item) => item.id);
  if (gone.length > 0)
    await tx.delete(sessionInbox).where(inArray(sessionInbox.id, gone));
}

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
  if (item.kind === "message") await capPendingMessages(tx, session.id);
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
 * TASK_TERMINAL once the task is cancelled or being stopped, and with
 * SPEND_CAP_REACHED while the coordinator could not make a model call (the
 * task's, its bot's or the instance's cap is reached). A coordinator that
 * holds a call for the user's approval is left waiting: the message reaches
 * it with the answer.
 */
export async function continueTask(
  tx: Tx,
  ctx: EngineContext,
  task: TaskRow,
  attribution: Attribution = {},
): Promise<{ task: TaskRow; root: SessionRow }> {
  assertOpen(task);
  await assertWithinCaps(tx, ctx, {
    taskId: task.id,
    botId: task.coordinatorBotId,
  });
  let root = await rootSession(tx, task.id);
  if (!root) throw new Error(`Task ${task.id} has no coordinator session.`);
  // A coordinator holding a call for approval reads the message with the
  // user's answer: nothing reopens, and the message waits in its inbox.
  if (await pendingApproval(tx, root.id)) return { task, root };
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

/** What the coordinator is told about a new goal version. */
function changeText(change: {
  version: number;
  goal?: string;
  plan?: VerificationPlan | null;
}): string {
  const parts: string[] = [];
  if (change.goal !== undefined)
    parts.push(
      `The user changed the task goal (now version ${change.version}):\n${change.goal}`,
    );
  if (change.plan !== undefined)
    parts.push(
      change.plan
        ? `${
            change.goal !== undefined
              ? "The user also set a new verification plan."
              : `The user set a new verification plan (goal version ${change.version}).`
          } The task completes only when every check passes; evidence from earlier versions no longer counts:\n${describePlan(change.plan)}`
        : `The user removed the verification plan (goal version ${change.version}): the task completes without checks.`,
    );
  return parts.join("\n\n");
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
  const message = await ctx.db.transaction(async (tx) => {
    let task = await lockTask(tx, taskId);
    if (!task) throw notFound("Task", taskId);
    assertOpen(task);

    // The goal version changes if and only if the goal or its plan changes.
    const currentPlan = planOf(task.verificationPlan);
    const goal =
      command.goal !== undefined && command.goal !== task.goal
        ? command.goal
        : undefined;
    const plan =
      command.verificationPlan !== undefined &&
      !samePlan(command.verificationPlan, currentPlan)
        ? { next: command.verificationPlan }
        : undefined;
    let goalChange:
      | { version: number; goal?: string; plan?: VerificationPlan | null }
      | undefined;
    if (goal !== undefined || plan) {
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
      const nextGoal = goal ?? task.goal;
      const nextPlan = plan ? plan.next : currentPlan;
      await tx.insert(taskGoalVersions).values({
        taskId,
        version,
        goal: nextGoal,
        verificationPlan: nextPlan,
        author: "user",
        createdAt: ctx.clock(),
      });
      task = await updateTask(tx, ctx, task, {
        goal: nextGoal,
        goalVersion: version,
        verificationPlan: nextPlan,
      });
      await emit(tx, taskId, {
        type: "task.goal_changed",
        payload: {
          goal: nextGoal,
          goalVersion: version,
          verificationPlan: nextPlan,
        },
      });
      // Calls made for an older goal version never run now.
      await expireApprovals(tx, ctx, taskId, version);
      goalChange = {
        version,
        ...(goal !== undefined ? { goal } : {}),
        ...(plan ? { plan: plan.next } : {}),
      };
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
      ? `${changeText(goalChange)}\n\nTheir message:\n${command.text}`
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
