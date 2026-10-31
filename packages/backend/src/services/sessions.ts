// Task and session record transitions. Every change to a task or session row
// goes through updateTask/updateSession, which emit the full-record
// `task.updated` / `session.updated` event in the same transaction.
import { isFinishedStatus } from "@jj/contracts";
import {
  cancelWhere,
  type Executor,
  type NewSession,
  type NewTask,
  notify,
  type SessionRow,
  sessions,
  type TaskRow,
  taskParticipants,
  tasks,
  type Tx,
} from "@jj/db";
import { asc, eq } from "drizzle-orm";
import type { EngineContext } from "../context";
import { type Attribution, emit } from "../events";
import { toSession, toTask } from "../records";

/** Row-locks the task for the rest of the transaction. Every task write takes this first. */
export async function lockTask(
  tx: Tx,
  taskId: string,
): Promise<TaskRow | undefined> {
  const [row] = await tx
    .select()
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .for("update");
  return row;
}

export async function participantIds(
  exec: Executor,
  taskId: string,
): Promise<string[]> {
  const rows = await exec
    .select({ botId: taskParticipants.botId })
    .from(taskParticipants)
    .where(eq(taskParticipants.taskId, taskId));
  return rows.map((row) => row.botId);
}

type TaskPatch = Partial<
  Pick<
    NewTask,
    | "status"
    | "goal"
    | "goalVersion"
    | "result"
    | "error"
    | "cancelReason"
    | "cancelRequestedAt"
  >
>;

/** Updates the task row and emits `task.updated` with the whole record. */
export async function updateTask(
  tx: Tx,
  ctx: EngineContext,
  current: TaskRow,
  patch: TaskPatch,
  attribution: Attribution = {},
): Promise<TaskRow> {
  const status = patch.status ?? current.status;
  const finishing = isFinishedStatus(status);
  const [row] = await tx
    .update(tasks)
    .set({
      ...patch,
      updatedAt: ctx.clock(),
      finishedAt: finishing
        ? isFinishedStatus(current.status)
          ? current.finishedAt
          : ctx.clock()
        : null,
    })
    .where(eq(tasks.id, current.id))
    .returning();
  if (!row) throw new Error(`Task ${current.id} vanished during an update.`);
  await emit(tx, row.id, {
    type: "task.updated",
    payload: {
      task: toTask(row, await participantIds(tx, row.id)),
      previousStatus: current.status,
    },
    ...attribution,
  });
  return row;
}

export async function getSession(
  exec: Executor,
  sessionId: string,
): Promise<SessionRow | undefined> {
  const [row] = await exec
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId));
  return row;
}

export async function taskSessions(
  exec: Executor,
  taskId: string,
): Promise<SessionRow[]> {
  return exec
    .select()
    .from(sessions)
    .where(eq(sessions.taskId, taskId))
    .orderBy(asc(sessions.createdAt), asc(sessions.id));
}

export async function insertSession(
  tx: Tx,
  ctx: EngineContext,
  values: Omit<NewSession, "id" | "createdAt" | "updatedAt">,
  attribution: Attribution = {},
): Promise<SessionRow> {
  const now = ctx.clock();
  const [row] = await tx
    .insert(sessions)
    .values({
      ...values,
      id: ctx.ids("session"),
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error("The session insert returned no row.");
  await emit(tx, row.taskId, {
    type: "session.created",
    payload: { session: toSession(row) },
    botId: row.botId,
    sessionId: row.id,
    runId: attribution.runId,
    causedBy: attribution.causedBy,
  });
  return row;
}

type SessionPatch = Partial<
  Pick<
    NewSession,
    | "status"
    | "waitingFor"
    | "goalVersion"
    | "result"
    | "error"
    | "runCount"
    | "startedAt"
    | "completionRequested"
  >
>;

/**
 * Updates the session row and emits `session.updated`. `waitingFor` is cleared
 * whenever the status is not `waiting`, and `finishedAt` follows the status.
 */
export async function updateSession(
  tx: Tx,
  ctx: EngineContext,
  current: SessionRow,
  patch: SessionPatch,
  attribution: Attribution = {},
): Promise<SessionRow> {
  const status = patch.status ?? current.status;
  const finishing = isFinishedStatus(status);
  const [row] = await tx
    .update(sessions)
    .set({
      ...patch,
      waitingFor:
        status === "waiting"
          ? (patch.waitingFor ?? current.waitingFor ?? "delegations")
          : null,
      updatedAt: ctx.clock(),
      finishedAt: finishing
        ? isFinishedStatus(current.status)
          ? current.finishedAt
          : ctx.clock()
        : null,
    })
    .where(eq(sessions.id, current.id))
    .returning();
  if (!row) throw new Error(`Session ${current.id} vanished during an update.`);
  await emit(tx, row.taskId, {
    type: "session.updated",
    payload: { session: toSession(row), previousStatus: current.status },
    botId: row.botId,
    sessionId: row.id,
    runId: attribution.runId,
    causedBy: attribution.causedBy,
  });
  return row;
}

/** Non-finished sessions under `parent` (children, grandchildren, …). */
export function openDescendants(
  all: readonly SessionRow[],
  parentId: string,
): SessionRow[] {
  const found: SessionRow[] = [];
  const frontier = [parentId];
  while (frontier.length > 0) {
    const id = frontier.pop();
    for (const row of all)
      if (row.parentSessionId === id) {
        frontier.push(row.id);
        if (!isFinishedStatus(row.status)) found.push(row);
      }
  }
  return found;
}

export async function openChildren(
  exec: Executor,
  session: SessionRow,
): Promise<SessionRow[]> {
  const rows = await exec
    .select()
    .from(sessions)
    .where(eq(sessions.parentSessionId, session.id));
  return rows.filter((row) => !isFinishedStatus(row.status));
}

/**
 * Cancels open sessions of a task (all, or those under one session). Queued
 * and waiting ones are cancelled now with their queued jobs; running ones are
 * told to stop (`jj_control` cancel) and cancel themselves when their run
 * ends. A running session also stops on its own once its parent or task has
 * finished, so a lost notification cannot leave it running.
 */
export async function cancelOpenSessions(
  tx: Tx,
  ctx: EngineContext,
  taskId: string,
  options: { under?: string; except?: string } = {},
  attribution: Attribution = {},
): Promise<void> {
  const all = await taskSessions(tx, taskId);
  const open = options.under
    ? openDescendants(all, options.under)
    : all.filter((row) => !isFinishedStatus(row.status));
  for (const row of open) {
    if (row.id === options.except) continue;
    if (row.status === "running") {
      await notify(tx, "jj_control", {
        kind: "cancel",
        taskId,
        sessionId: row.id,
      });
      continue;
    }
    await cancelWhere(tx, { sessionId: row.id });
    await updateSession(tx, ctx, row, { status: "cancelled" }, attribution);
  }
}
