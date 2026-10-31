import { and, asc, eq, gt, sql } from "drizzle-orm";
import { notify } from "./bus";
import type { Executor, Tx } from "./database";
import { newId } from "./ids";
import {
  bots,
  type JsonObject,
  type TaskEventRow,
  taskEvents,
  tasks,
} from "./schema";

/** A sequence was requested for a task or bot row that does not exist. */
export class RecordNotFoundError extends Error {
  constructor(
    readonly table: string,
    readonly id: string,
  ) {
    super(`No ${table} row with id ${id}.`);
    this.name = "RecordNotFoundError";
  }
}

export interface AppendEventInput {
  taskId: string;
  type: string;
  payload?: JsonObject;
  botId?: string | null;
  sessionId?: string | null;
  runId?: string | null;
  causedBy?: string | null;
  /** Defaults to a new `evt_…` id. */
  id?: string;
}

/**
 * Append a task event inside the caller's transaction. The per-task sequence
 * comes from `UPDATE tasks SET event_seq = event_seq + 1 … RETURNING`, which
 * row-locks that task until commit: appends to one task serialize and stay
 * gap-free (a rollback releases its number), while other tasks never wait.
 * The `jj_task_event` notification is sent in the same transaction, so it is
 * delivered only once the event is durable. The event takes the task's owner.
 */
export async function appendEvent(
  tx: Tx,
  input: AppendEventInput,
): Promise<TaskEventRow> {
  const [allocated] = await tx
    .update(tasks)
    .set({ eventSeq: sql`${tasks.eventSeq} + 1` })
    .where(eq(tasks.id, input.taskId))
    .returning({ sequence: tasks.eventSeq, ownerId: tasks.ownerId });
  if (!allocated) throw new RecordNotFoundError("tasks", input.taskId);
  const [event] = await tx
    .insert(taskEvents)
    .values({
      id: input.id ?? newId("taskEvent"),
      ownerId: allocated.ownerId,
      taskId: input.taskId,
      sequence: allocated.sequence,
      type: input.type,
      botId: input.botId ?? null,
      sessionId: input.sessionId ?? null,
      runId: input.runId ?? null,
      causedBy: input.causedBy ?? null,
      payload: input.payload ?? {},
    })
    .returning();
  if (!event) throw new Error("The event insert returned no row.");
  await notify(tx, "jj_task_event", {
    taskId: input.taskId,
    sequence: allocated.sequence,
  });
  return event;
}

/**
 * Allocate the next `task_messages.sequence` for a task, row-locking the task
 * until commit. Insert the message in the same transaction.
 */
export async function nextMessageSequence(
  tx: Tx,
  taskId: string,
): Promise<number> {
  const [allocated] = await tx
    .update(tasks)
    .set({ messageSeq: sql`${tasks.messageSeq} + 1` })
    .where(eq(tasks.id, taskId))
    .returning({ sequence: tasks.messageSeq });
  if (!allocated) throw new RecordNotFoundError("tasks", taskId);
  return allocated.sequence;
}

/**
 * Allocate the next `conversation_messages.sequence` for a bot, row-locking the
 * bot until commit. Insert the message in the same transaction.
 */
export async function nextConversationSequence(
  tx: Tx,
  botId: string,
): Promise<number> {
  const [allocated] = await tx
    .update(bots)
    .set({ conversationSeq: sql`${bots.conversationSeq} + 1` })
    .where(eq(bots.id, botId))
    .returning({ sequence: bots.conversationSeq });
  if (!allocated) throw new RecordNotFoundError("bots", botId);
  return allocated.sequence;
}

/** Events of a task strictly after `after`, in sequence order. */
export async function listEvents(
  exec: Executor,
  taskId: string,
  options: { after?: number; limit?: number } = {},
): Promise<TaskEventRow[]> {
  const after = options.after ?? 0;
  if (!Number.isSafeInteger(after) || after < 0)
    throw new RangeError("Event cursor must be a nonnegative safe integer.");
  const query = exec
    .select()
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), gt(taskEvents.sequence, after)))
    .orderBy(asc(taskEvents.sequence));
  if (options.limit === undefined) return query;
  if (!Number.isSafeInteger(options.limit) || options.limit < 1)
    throw new RangeError("Event limit must be a positive integer.");
  return query.limit(options.limit);
}
