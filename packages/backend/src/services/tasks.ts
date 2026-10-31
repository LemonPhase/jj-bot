// Task creation and stop. A stop is two-phase: the request is durable at once
// (no new launches, no new messages, queued work cancelled, running runs told
// to abort), and the task is cancelled when nothing of it runs any more.
import {
  type CreateTaskCommand,
  createTaskCommandSchema,
  type StopTaskCommand,
  stopTaskCommandSchema,
  type Task,
  type TaskEventOf,
} from "@jj/contracts";
import {
  bots,
  cancelWhere,
  notify,
  runs,
  type SessionRow,
  type TaskRow,
  type Tx,
  taskEvents,
  taskGoalVersions,
  taskParticipants,
  tasks,
} from "@jj/db";
import { and, asc, count, desc, eq, gt, inArray, isNull } from "drizzle-orm";
import type { EngineContext } from "../context";
import { DomainError, errorMessage, notFound, parseCommand } from "../errors";
import { emit } from "../events";
import { toTask } from "../records";
import { deliver } from "./messages";
import {
  insertSession,
  lockTask,
  participantIds,
  taskSessions,
  updateSession,
  updateTask,
} from "./sessions";

/** A title from the goal's first line when the creator gives none. */
export function deriveTitle(goal: string): string {
  const line = goal.trim().split("\n", 1)[0]?.trim() ?? "";
  const words = line.replace(/\s+/g, " ");
  if (words.length <= 80) return words || "Untitled task";
  return `${words.slice(0, 79).trimEnd()}…`;
}

export interface NewTaskInput {
  goal: string;
  title?: string;
  coordinatorBotId: string;
  participantBotIds: string[];
  /** Set when a bot creates the task from direct chat (rate-limited). */
  createdByBotId?: string | null;
}

/** Creates the task, its coordinator session and the first wake, in the caller's transaction. */
export async function createTaskTx(
  tx: Tx,
  ctx: EngineContext,
  input: NewTaskInput,
): Promise<{ task: TaskRow; root: SessionRow }> {
  const now = ctx.clock();
  const [task] = await tx
    .insert(tasks)
    .values({
      id: ctx.ids("task"),
      title: input.title?.trim() || deriveTitle(input.goal),
      goal: input.goal,
      coordinatorBotId: input.coordinatorBotId,
      createdByBotId: input.createdByBotId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!task) throw new Error("The task insert returned no row.");
  const participants = [
    ...new Set([input.coordinatorBotId, ...input.participantBotIds]),
  ];
  await tx
    .insert(taskParticipants)
    .values(
      participants.map((botId) => ({ taskId: task.id, botId, joinedAt: now })),
    );
  await tx.insert(taskGoalVersions).values({
    taskId: task.id,
    version: 1,
    goal: input.goal,
    author: input.createdByBotId ?? "user",
    createdAt: now,
  });
  await emit(tx, task.id, {
    type: "task.created",
    payload: { task: toTask(task, participants) },
    botId: input.createdByBotId ?? null,
  });
  const root = await insertSession(tx, ctx, {
    taskId: task.id,
    botId: input.coordinatorBotId,
    parentSessionId: null,
    role: "coordinator",
    brief: input.goal,
    goalVersion: 1,
    depth: 0,
    status: "queued",
  });
  await deliver(
    tx,
    root,
    { kind: "brief", text: `New task. Goal (version 1):\n${input.goal}` },
    { wake: true, ctx },
  );
  return { task, root };
}

/** MODEL_NOT_CONFIGURED unless the bot's model (or the default) can run. */
export function assertModel(
  ctx: EngineContext,
  bot: { name: string; model: string | null },
) {
  try {
    ctx.models.resolve(bot.model);
  } catch (error) {
    throw new DomainError(
      "MODEL_NOT_CONFIGURED",
      `${bot.name} cannot run: ${errorMessage(error)}`,
    );
  }
}

/** `POST /api/tasks`. */
export async function createTask(
  ctx: EngineContext,
  input: CreateTaskCommand,
): Promise<{ task: Task }> {
  const command = parseCommand(createTaskCommandSchema, input);
  if (command.verificationPlan)
    throw new DomainError(
      "VERIFICATION_UNAVAILABLE",
      "Verification plans are not enforced by this server yet; create the task without one.",
    );
  const found = await ctx.db
    .select()
    .from(bots)
    .where(
      and(inArray(bots.id, command.participantBotIds), isNull(bots.archivedAt)),
    );
  const missing = command.participantBotIds.filter(
    (id) => !found.some((bot) => bot.id === id),
  );
  if (missing.length > 0)
    throw new DomainError(
      "VALIDATION_FAILED",
      `Unknown bot: ${missing.join(", ")}.`,
      { botIds: missing },
    );
  for (const bot of found) assertModel(ctx, bot);
  const { task } = await ctx.db.transaction((tx) =>
    createTaskTx(tx, ctx, command),
  );
  return { task: toTask(task, command.participantBotIds) };
}

/** `POST /api/tasks/:id/stop`. Idempotent while stopping or cancelled. */
export async function stopTask(
  ctx: EngineContext,
  taskId: string,
  input: StopTaskCommand,
): Promise<{ task: Task }> {
  const command = parseCommand(stopTaskCommandSchema, input);
  const row = await ctx.db.transaction(async (tx) => {
    let task = await lockTask(tx, taskId);
    if (!task) throw notFound("Task", taskId);
    if (task.status === "cancelled" || task.cancelRequestedAt) return task;
    if (task.status === "completed" || task.status === "failed")
      throw new DomainError(
        "CONFLICT",
        `The task already ${task.status}; there is nothing to stop.`,
      );
    task = await updateTask(tx, ctx, task, {
      cancelRequestedAt: ctx.clock(),
      cancelReason: command.reason ?? null,
    });
    await emit(tx, taskId, {
      type: "cancellation.requested",
      payload: { reason: command.reason ?? null },
    });
    await cancelWhere(tx, { taskId });
    await notify(tx, "jj_control", { kind: "cancel", taskId });
    return (await settleCancellation(tx, ctx, task)) ?? task;
  });
  return { task: toTask(row, await participantIds(ctx.db, taskId)) };
}

type Stopped = TaskEventOf<"cancellation.completed">["payload"]["stopped"];

/**
 * Finishes a requested stop once no run of the task is active: cancels every
 * open session, records what stopped (from the runs' events) and what never
 * started, and cancels the task. Returns the cancelled task, or undefined
 * while runs are still stopping. Call it with the task row locked.
 */
export async function settleCancellation(
  tx: Tx,
  ctx: EngineContext,
  task: TaskRow,
): Promise<TaskRow | undefined> {
  if (!task.cancelRequestedAt || task.status === "cancelled") return undefined;
  const [active] = await tx
    .select({ value: count() })
    .from(runs)
    .where(and(eq(runs.taskId, task.id), eq(runs.status, "running")));
  if ((active?.value ?? 0) > 0) return undefined;

  const [requested] = await tx
    .select({ sequence: taskEvents.sequence })
    .from(taskEvents)
    .where(
      and(
        eq(taskEvents.taskId, task.id),
        eq(taskEvents.type, "cancellation.requested"),
      ),
    )
    .orderBy(desc(taskEvents.sequence))
    .limit(1);
  const later = await tx
    .select()
    .from(taskEvents)
    .where(
      and(
        eq(taskEvents.taskId, task.id),
        gt(taskEvents.sequence, requested?.sequence ?? 0),
        inArray(taskEvents.type, ["run.finished", "tool.finished"]),
      ),
    )
    .orderBy(asc(taskEvents.sequence));
  const stopped: Stopped = [];
  for (const event of later) {
    if (event.type !== "run.finished" || event.payload.outcome !== "cancelled")
      continue;
    if (!event.sessionId || !event.botId) continue;
    const cut = [...later]
      .reverse()
      .find(
        (tool) =>
          tool.type === "tool.finished" &&
          tool.runId === event.runId &&
          (tool.payload.interrupted === "yes" ||
            tool.payload.interrupted === "unknown"),
      );
    stopped.push({
      sessionId: event.sessionId,
      botId: event.botId,
      interrupted: cut ? (cut.payload.interrupted as "yes" | "unknown") : "no",
      ...(cut ? { command: String(cut.payload.summary ?? "") } : {}),
    });
  }

  const neverStarted: string[] = [];
  for (const session of await taskSessions(tx, task.id)) {
    if (
      session.status === "completed" ||
      session.status === "failed" ||
      session.status === "cancelled"
    )
      continue;
    if (session.runCount === 0) neverStarted.push(session.id);
    await updateSession(tx, ctx, session, { status: "cancelled" });
  }
  await cancelWhere(tx, { taskId: task.id });
  const cancelled = await updateTask(tx, ctx, task, { status: "cancelled" });
  await emit(tx, task.id, {
    type: "cancellation.completed",
    payload: { stopped, neverStarted },
  });
  await emit(tx, task.id, {
    type: "task.finished",
    payload: { status: "cancelled", result: null, error: null },
  });
  await notify(tx, "jj_control", { kind: "cancel", taskId: task.id });
  return cancelled;
}
