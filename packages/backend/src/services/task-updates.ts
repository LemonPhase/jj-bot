// Task updates for direct chat. When a task completes, fails or waits for the
// user, its coordinator tells the user in its direct chat, in its own words.
// The update is recorded in the transaction that changes the task (one row
// per event, keyed by the task and its event sequence) and enqueues a chat
// reply for that bot. It is the input of that one reply, never a stored chat
// message; the reply, or the engine's fallback when the reply fails, marks it
// answered in the transaction that stores the message, so it is told once.
import {
  type ApprovalStatus,
  approvals,
  type ChatTaskUpdateRow,
  chatTaskUpdates,
  type Executor,
  enqueue,
  type TaskRow,
  type TaskStatus,
  type TaskUpdateEvent,
  type Tx,
  tasks,
} from "@jj/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { EngineContext } from "../context";
import { hint, wakeWorkers } from "../events";
import type { Redact } from "./task-log";

/** Characters of the result, error or question an update carries. */
export const UPDATE_TEXT_CHARS = 2_000;

/** The first line of an update reply's input; the scripted test model reads it. */
export const UPDATE_MARKER = "[Task update]";

/**
 * `text` cut near `max` characters, line breaks kept (never inside a
 * surrogate pair), with a note when it was cut.
 */
export function clipVerbatim(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed
    .slice(0, max)
    .replace(/[\uD800-\uDBFF]$/, "")
    .trimEnd();
  return `${cut}… (clipped)`;
}

/**
 * Records an update for the task's coordinator and wakes its chat. Call it in
 * the transaction that changes the task's status, after the task's events,
 * or that records an approval request (`approvalId`).
 */
export async function recordTaskUpdate(
  tx: Tx,
  ctx: EngineContext,
  task: Pick<TaskRow, "id" | "coordinatorBotId">,
  event: TaskUpdateEvent,
  text: string,
  options: { approvalId?: string } = {},
): Promise<void> {
  const [row] = await tx
    .select({ eventSeq: tasks.eventSeq })
    .from(tasks)
    .where(eq(tasks.id, task.id));
  // A later event overtakes the task's updates that were not told yet.
  await tx
    .update(chatTaskUpdates)
    .set({ answeredAt: ctx.clock() })
    .where(
      and(
        eq(chatTaskUpdates.taskId, task.id),
        isNull(chatTaskUpdates.answeredAt),
      ),
    );
  await tx.insert(chatTaskUpdates).values({
    id: ctx.ids("taskUpdate"),
    botId: task.coordinatorBotId,
    taskId: task.id,
    event,
    taskEventSeq: row?.eventSeq ?? 0,
    text: clipVerbatim(text, UPDATE_TEXT_CHARS) || "(no text)",
    createdAt: ctx.clock(),
    approvalId: options.approvalId ?? null,
  });
  await enqueue(tx, { kind: "chat.reply", botId: task.coordinatorBotId });
  await wakeWorkers(tx);
  await hint(tx, {
    type: "conversation.changed",
    botId: task.coordinatorBotId,
  });
}

export type PendingUpdate = ChatTaskUpdateRow & {
  title: string;
  /** The task's status now, which may have moved on since the event. */
  status: TaskStatus;
  cancelRequestedAt: Date | null;
  /** An `approval` update's approval status now. */
  approvalStatus: ApprovalStatus | null;
};

const pendingColumns = {
  update: chatTaskUpdates,
  title: tasks.title,
  status: tasks.status,
  cancelRequestedAt: tasks.cancelRequestedAt,
  approvalStatus: approvals.status,
};

const toPending = (row: {
  update: ChatTaskUpdateRow;
  title: string;
  status: TaskStatus;
  cancelRequestedAt: Date | null;
  approvalStatus: ApprovalStatus | null;
}): PendingUpdate => ({
  ...row.update,
  title: row.title,
  status: row.status,
  cancelRequestedAt: row.cancelRequestedAt,
  approvalStatus: row.approvalStatus,
});

/**
 * A waiting update whose task no longer waits for the user: its question was
 * answered (in the task or from chat), so telling it would be stale. Or an
 * approval update whose approval was answered, expired or cancelled.
 */
export const isOvertaken = (update: PendingUpdate) =>
  (update.event === "waiting" &&
    (update.status !== "waiting" || update.cancelRequestedAt !== null)) ||
  (update.event === "approval" &&
    (update.approvalStatus !== "pending" || update.cancelRequestedAt !== null));

/** A bot's unanswered updates, oldest first. */
export async function pendingTaskUpdates(
  exec: Executor,
  botId: string,
  limit = 1,
): Promise<PendingUpdate[]> {
  const rows = await exec
    .select(pendingColumns)
    .from(chatTaskUpdates)
    .innerJoin(tasks, eq(tasks.id, chatTaskUpdates.taskId))
    .leftJoin(approvals, eq(approvals.id, chatTaskUpdates.approvalId))
    .where(
      and(eq(chatTaskUpdates.botId, botId), isNull(chatTaskUpdates.answeredAt)),
    )
    .orderBy(asc(chatTaskUpdates.createdAt), asc(chatTaskUpdates.id))
    .limit(limit);
  return rows.map(toPending);
}

/** One update while it is unanswered; undefined once answered or when there is none. */
export async function pendingTaskUpdate(
  exec: Executor,
  updateId: string,
): Promise<PendingUpdate | undefined> {
  const [row] = await exec
    .select(pendingColumns)
    .from(chatTaskUpdates)
    .innerJoin(tasks, eq(tasks.id, chatTaskUpdates.taskId))
    .leftJoin(approvals, eq(approvals.id, chatTaskUpdates.approvalId))
    .where(
      and(eq(chatTaskUpdates.id, updateId), isNull(chatTaskUpdates.answeredAt)),
    );
  return row ? toPending(row) : undefined;
}

/**
 * Marks the update told by `messageId`, or closed without a message (null)
 * when it was overtaken. False when it already was: the caller then stores
 * no message.
 */
export async function answerTaskUpdate(
  tx: Tx,
  ctx: EngineContext,
  updateId: string,
  messageId: string | null,
): Promise<boolean> {
  const rows = await tx
    .update(chatTaskUpdates)
    .set({ messageId, answeredAt: ctx.clock() })
    .where(
      and(eq(chatTaskUpdates.id, updateId), isNull(chatTaskUpdates.answeredAt)),
    )
    .returning({ id: chatTaskUpdates.id });
  return rows.length > 0;
}

/** The task's status now, as an update input names it. */
function statusNow(update: PendingUpdate): string {
  if (update.cancelRequestedAt && update.status !== "cancelled")
    return "stopping";
  return update.status === "waiting" ? "waiting for the user" : update.status;
}

/**
 * What an update tells: its event, or `capped` for a task that waits because
 * a spend cap stopped it (its text carries the engine's `Stopped: …` line).
 */
type UpdateKind = TaskUpdateEvent | "capped";

const CAP_STOP = /^Stopped: .*spend cap/m;

const kindOf = (update: PendingUpdate): UpdateKind =>
  update.event === "waiting" && CAP_STOP.test(update.text)
    ? "capped"
    : update.event;

const HAPPENED: Record<UpdateKind, string> = {
  completed: "completed",
  failed: "failed",
  waiting: "is waiting for the user: you asked them something in the task",
  capped: "is waiting for the user: a spend cap stopped it",
  approval:
    "has a call waiting for the user's approval: it has not run, and its session waits for the answer",
};

const BODY: Record<UpdateKind, string> = {
  completed: "Result",
  failed: "Error",
  waiting: "Your question",
  capped: "Why it stopped",
  approval: "The call",
};

const NEXT: Record<UpdateKind, string> = {
  completed:
    "Tell the user how it went, in your own words and briefly; the task's card is shown under your message.",
  failed:
    "Tell the user what went wrong, in your own words and briefly; the task's card is shown under your message.",
  waiting:
    "Ask the user, in your own words and briefly; the task's card is shown under your message. When they answer, you can pass it on with `send_to_task`.",
  capped:
    "Tell the user which cap stopped it and what lets it go on, in your own words and briefly; the task's card is shown under your message.",
  approval:
    "Tell the user, in your own words and briefly, what waits for their approval; the task's card under your message has Approve and Deny buttons. Only the user can answer it: you cannot approve or deny it, and `send_to_task` does not answer it.",
};

/** The input of the reply that tells the user about an update. */
export function updateInput(update: PendingUpdate, redact: Redact): string {
  const kind = kindOf(update);
  return redact(
    [
      `${UPDATE_MARKER} This comes from JJ Bot, not from the user: a task you coordinate ${HAPPENED[kind]}.`,
      `Task: ${update.taskId} ${JSON.stringify(update.title)}`,
      (update.event === "approval"
        ? update.approvalStatus === "pending"
        : update.status === update.event) && !update.cancelRequestedAt
        ? `Status now: ${statusNow(update)}.`
        : `Status now: ${statusNow(update)}; it has moved on since this update.`,
      `${BODY[kind]}, as the task recorded it:`,
      update.text,
      "",
      `${NEXT[kind]} In this reply you can only look things up (\`list_tasks\`, \`get_task\`, \`read_task_log\`); if something should happen next, suggest it and let the user decide.`,
    ].join("\n"),
  );
}

const PLAIN: Record<UpdateKind, string> = {
  completed: "completed",
  failed: "failed",
  waiting: "is waiting for your answer",
  capped: "stopped at a spend cap and is waiting for you",
  approval: "has a call waiting for your approval",
};

const PLAIN_BODY: Record<UpdateKind, string> = {
  completed: "Result",
  failed: "Error",
  waiting: "Question",
  capped: "Why it stopped",
  approval: "The call (approve or deny it on the task's card)",
};

/** The message the engine posts when the bot's reply to an update fails. */
export function fallbackText(update: PendingUpdate, redact: Redact): string {
  const kind = kindOf(update);
  return redact(
    [
      `Task ${JSON.stringify(update.title)} ${PLAIN[kind]}.`,
      "",
      `${PLAIN_BODY[kind]}:`,
      update.text,
      "",
      "(Posted automatically: the reply to this update failed.)",
    ].join("\n"),
  );
}
