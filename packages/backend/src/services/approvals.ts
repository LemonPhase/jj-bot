// Approvals. A call that a rule of its bot's runtime profile marks as needing
// the user's approval does not run: the run records a pending approval and
// ends `held`, and its session waits (`waitingFor: "approval"`) without a
// run until the user decides. Approving runs the call once when the session
// resumes; denying, expiry (a newer goal version) and cancellation never run
// it. The record is the single source for what the user sees: every change
// emits `approval.updated` with the whole record.
import {
  type Approval,
  type ApprovalOutcome,
  type ApprovalRule,
  approvalRuleSchema,
  type DecideApprovalCommand,
  decideApprovalCommandSchema,
  describeApprovalRule,
} from "@jj/contracts";
import {
  type ApprovalRow,
  type ApprovalStatus,
  approvals,
  type Executor,
  enqueue,
  type JsonObject,
  type SessionRow,
  type TaskRow,
  type Tx,
  tasks,
} from "@jj/db";
import { and, asc, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import type { EngineContext } from "../context";
import { DomainError, notFound, parseCommand } from "../errors";
import { type Attribution, emit, wakeWorkers } from "../events";
import type { HeldCallDecision, PendingToolCall } from "../ports";
import type { Redactor } from "../redact";
import { recordTaskUpdate } from "./task-updates";

const clip = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
const isoOrNull = (date: Date | null) => (date ? date.toISOString() : null);

export function toApproval(row: ApprovalRow): Approval {
  return {
    id: row.id,
    taskId: row.taskId,
    sessionId: row.sessionId,
    runId: row.runId,
    botId: row.botId,
    toolCallId: clip(row.toolCallId, 128),
    tool: row.tool,
    summary: row.summary,
    args: row.args,
    rule: approvalRuleSchema.parse(row.rule),
    text: row.text,
    goalVersion: row.goalVersion,
    status: row.status,
    reason: row.reason,
    outcome: (row.outcome as ApprovalOutcome | null) ?? null,
    createdAt: row.createdAt.toISOString(),
    decidedAt: isoOrNull(row.decidedAt),
    startedAt: isoOrNull(row.startedAt),
  };
}

const attributionOf = (row: ApprovalRow): Attribution => ({
  botId: row.botId,
  sessionId: row.sessionId,
});

type ApprovalPatch = Partial<
  Pick<
    ApprovalRow,
    | "status"
    | "reason"
    | "outcome"
    | "decidedAt"
    | "startedRunId"
    | "startedAt"
    | "resolvedAt"
  >
>;

/** Updates the approval and emits `approval.updated` with the whole record. */
async function updateApproval(
  tx: Tx,
  current: ApprovalRow,
  patch: ApprovalPatch,
  attribution: Attribution = attributionOf(current),
): Promise<ApprovalRow> {
  const [row] = await tx
    .update(approvals)
    .set(patch)
    .where(eq(approvals.id, current.id))
    .returning();
  if (!row)
    throw new Error(`Approval ${current.id} vanished during an update.`);
  await emit(tx, row.taskId, {
    type: "approval.updated",
    payload: { approval: toApproval(row), previousStatus: current.status },
    ...attributionOf(row),
    ...attribution,
  });
  return row;
}

/** What the coordinator's chat is told about a request. */
function updateText(row: ApprovalRow, botName: string): string {
  return [
    `${botName} wants to run ${row.tool}: ${row.summary}`,
    `It needs approval under the rule for ${describeApprovalRule(approvalRuleSchema.parse(row.rule))}.`,
    ...(row.text ? [`${botName} wrote with it: ${row.text}`] : []),
  ].join("\n");
}

/**
 * Records a pending approval for a call a run holds, and tells the task's
 * coordinator chat. Call it with the task locked; the session's partial
 * unique index refuses a second pending one. `goalVersion` is the task's
 * goal version as the run's model last read it, and the approval is bound
 * to it: a call made at an older version than the task's (the goal changed
 * while the run was making it) is recorded already expired, so it never
 * waits and never runs.
 */
export async function requestApproval(
  tx: Tx,
  ctx: EngineContext,
  input: {
    task: TaskRow;
    session: SessionRow;
    /** The task's goal version as the run's model last read it. */
    goalVersion: number;
    runId: string;
    botName: string;
    call: PendingToolCall;
    rule: ApprovalRule;
    redact: Redactor;
  },
): Promise<ApprovalRow> {
  const { task, session, call } = input;
  const stale = task.goalVersion > input.goalVersion;
  const now = ctx.clock();
  const [row] = await tx
    .insert(approvals)
    .values({
      id: ctx.ids("approval"),
      taskId: task.id,
      sessionId: session.id,
      runId: input.runId,
      botId: session.botId,
      toolCallId: call.toolCallId,
      tool: call.tool,
      summary: clip(input.redact(call.summary), 300),
      args: input.redact(call.args) as JsonObject,
      rule: input.rule as JsonObject,
      text: clip(input.redact(call.text), 2_000),
      goalVersion: input.goalVersion,
      createdAt: now,
      ...(stale
        ? {
            status: "expired" as const,
            reason: `the task's goal or plan changed (now goal version ${task.goalVersion}) before the call was made.`,
            decidedAt: now,
            resolvedAt: now,
          }
        : {}),
    })
    .returning();
  if (!row) throw new Error("The approval insert returned no row.");
  await emit(tx, task.id, {
    type: "approval.requested",
    payload: { approval: toApproval(row) },
    botId: row.botId,
    sessionId: row.sessionId,
    runId: row.runId,
  });
  // An expired one waits for nobody: the chat is not told.
  if (stale) return row;
  await recordTaskUpdate(
    tx,
    ctx,
    task,
    "approval",
    updateText(row, input.botName),
    {
      approvalId: row.id,
    },
  );
  return row;
}

/** The session's pending approval, if it holds one. */
export async function pendingApproval(
  exec: Executor,
  sessionId: string,
): Promise<ApprovalRow | undefined> {
  const [row] = await exec
    .select()
    .from(approvals)
    .where(
      and(eq(approvals.sessionId, sessionId), eq(approvals.status, "pending")),
    );
  return row;
}

/**
 * The session's decided approval whose result has not reached its
 * transcript yet: the decision its next run applies.
 */
export async function unresolvedDecision(
  exec: Executor,
  sessionId: string,
): Promise<ApprovalRow | undefined> {
  const [row] = await exec
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.sessionId, sessionId),
        inArray(approvals.status, ["approved", "denied", "expired"]),
        isNull(approvals.resolvedAt),
      ),
    )
    .orderBy(asc(approvals.createdAt))
    .limit(1);
  return row;
}

/** The text a call that will not run gets as its error result. */
export function notRunText(row: ApprovalRow): string {
  switch (row.status) {
    case "denied":
      return row.reason
        ? `Not run: the user denied this call. Their reason: ${row.reason}`
        : "Not run: the user denied this call. They gave no reason.";
    case "expired":
      return `Not run: ${row.reason ?? "it expired before the user answered."}`;
    default:
      return `Not run: ${row.reason ?? "it was cancelled."}`;
  }
}

/** The decision a run applies for this approval. */
export function decisionInput(row: ApprovalRow): HeldCallDecision {
  return row.status === "approved"
    ? { toolCallId: row.toolCallId, approved: true }
    : { toolCallId: row.toolCallId, approved: false, text: notRunText(row) };
}

/**
 * Claims the approved call for `runId` right before it runs. False when a
 * run claimed it before (it may have started), or it is no longer approved.
 */
export async function claimApproval(
  tx: Tx,
  ctx: EngineContext,
  sessionId: string,
  toolCallId: string,
  runId: string,
): Promise<boolean> {
  const [current] = await tx
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.sessionId, sessionId),
        eq(approvals.toolCallId, toolCallId),
      ),
    )
    .for("update");
  if (!current || current.status !== "approved" || current.startedAt)
    return false;
  await updateApproval(
    tx,
    current,
    { startedRunId: runId, startedAt: ctx.clock() },
    { ...attributionOf(current), runId },
  );
  return true;
}

interface StoredResult {
  role?: unknown;
  toolCallId?: unknown;
  isError?: unknown;
  content?: { type?: unknown; text?: unknown }[];
  details?: { exitCode?: unknown; interrupted?: unknown; refused?: unknown };
}

const resultText = (result: StoredResult) =>
  (result.content ?? [])
    .map((block) => (typeof block.text === "string" ? block.text : ""))
    .join("")
    .trim();

/**
 * Marks the decision resolved when the entries a run persists hold its
 * call's result, in the same transaction, and records an approved call's
 * outcome. Entries are opaque to the engine; only a tool result's id, error
 * flag and details are read.
 */
export async function noteResolved(
  tx: Tx,
  ctx: EngineContext,
  sessionId: string,
  toolCallId: string,
  entries: readonly object[],
  runId: string,
): Promise<void> {
  const result = (entries as StoredResult[]).find(
    (entry) => entry.role === "toolResult" && entry.toolCallId === toolCallId,
  );
  if (!result) return;
  const [current] = await tx
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.sessionId, sessionId),
        eq(approvals.toolCallId, toolCallId),
        isNull(approvals.resolvedAt),
      ),
    );
  if (!current || current.status === "pending") return;
  const details = result.details ?? {};
  const outcome: ApprovalOutcome | null =
    current.status === "approved"
      ? details.refused === true
        ? {
            ok: false,
            refused: clip(resultText(result) || "refused", 500),
          }
        : {
            ok: result.isError !== true,
            ...(typeof details.exitCode === "number" ||
            details.exitCode === null
              ? { exitCode: details.exitCode as number | null }
              : {}),
            ...(details.interrupted === "no" ||
            details.interrupted === "yes" ||
            details.interrupted === "unknown"
              ? { interrupted: details.interrupted }
              : {}),
          }
      : null;
  await updateApproval(
    tx,
    current,
    {
      resolvedAt: ctx.clock(),
      ...(outcome ? { outcome: outcome as unknown as JsonObject } : {}),
    },
    { ...attributionOf(current), runId },
  );
}

/** Wakes a session whose approval was answered, so its next run applies it. */
async function wake(tx: Tx, row: ApprovalRow) {
  await enqueue(tx, {
    kind: "session.run",
    taskId: row.taskId,
    sessionId: row.sessionId,
  });
  await wakeWorkers(tx, row.taskId);
}

/**
 * `POST /api/tasks/:taskId/approvals/:approvalId`: the user's answer.
 * Approving or denying wakes the session; an approval that is no longer
 * pending answers 409 APPROVAL_NOT_PENDING, and a stopping or stopped task
 * 409 TASK_TERMINAL.
 */
export async function decideApproval(
  ctx: EngineContext,
  taskId: string,
  approvalId: string,
  input: DecideApprovalCommand,
): Promise<{ approval: Approval }> {
  const command = parseCommand(decideApprovalCommandSchema, input);
  return ctx.db.transaction(async (tx) => {
    // The task lock first, as every task write takes it (sessions.ts imports this module).
    const [task] = await tx
      .select({
        id: tasks.id,
        status: tasks.status,
        cancelRequestedAt: tasks.cancelRequestedAt,
      })
      .from(tasks)
      .where(eq(tasks.id, taskId))
      .for("update");
    if (!task) throw notFound("Task", taskId);
    // As a message would be: a stopping or stopped task takes no answer.
    if (task.status === "cancelled" || task.cancelRequestedAt)
      throw new DomainError(
        "TASK_TERMINAL",
        task.status === "cancelled"
          ? "The task was cancelled; its calls will not run."
          : "The task is stopping; its calls will not run.",
      );
    const [current] = await tx
      .select()
      .from(approvals)
      .where(and(eq(approvals.id, approvalId), eq(approvals.taskId, taskId)))
      .for("update");
    if (!current) throw notFound("Approval", approvalId);
    if (current.status !== "pending")
      throw new DomainError(
        "APPROVAL_NOT_PENDING",
        `The approval is ${current.status}, not pending: it can no longer be answered.`,
        { status: current.status },
      );
    const row = await updateApproval(tx, current, {
      status: command.decision === "approve" ? "approved" : "denied",
      reason: command.decision === "deny" ? (command.reason ?? null) : null,
      decidedAt: ctx.clock(),
    });
    await wake(tx, row);
    return { approval: toApproval(row) };
  });
}

/**
 * A goal (or plan) change: every approval of the task made at an older
 * version that has not run, pending or approved and not started, expires,
 * and its session wakes to tell the model. A call approved for the old goal
 * never runs for the new one.
 */
export async function expireApprovals(
  tx: Tx,
  ctx: EngineContext,
  taskId: string,
  goalVersion: number,
): Promise<void> {
  const rows = await tx
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.taskId, taskId),
        inArray(approvals.status, ["pending", "approved"] as ApprovalStatus[]),
        isNull(approvals.startedAt),
        // Already answered in the transcript (refused before it started): left as it is.
        isNull(approvals.resolvedAt),
        lt(approvals.goalVersion, goalVersion),
      ),
    )
    .orderBy(asc(approvals.createdAt));
  for (const current of rows) {
    const row = await updateApproval(tx, current, {
      status: "expired",
      reason:
        current.status === "pending"
          ? `the task's goal or plan changed (now goal version ${goalVersion}) before the user answered.`
          : `the task's goal or plan changed (now goal version ${goalVersion}) before it ran.`,
      decidedAt: current.decidedAt ?? ctx.clock(),
    });
    await wake(tx, row);
  }
}

/**
 * A session finished (stopped, failed or completed): its pending approval,
 * or an approved call that has not started, is cancelled and never runs. An
 * approved call a run started and never reported (that run stopped before
 * its result was stored) gets an unknown outcome: it may have run, and no
 * run is left to say.
 */
export async function cancelApprovals(
  tx: Tx,
  ctx: EngineContext,
  session: Pick<SessionRow, "id" | "status">,
  attribution: Attribution = {},
): Promise<void> {
  const rows = await tx
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.sessionId, session.id),
        inArray(approvals.status, ["pending", "approved"] as ApprovalStatus[]),
        isNull(approvals.startedAt),
        // Already answered in the transcript (refused before it started): left as it is.
        isNull(approvals.resolvedAt),
      ),
    );
  const reason =
    session.status === "cancelled"
      ? "the task was stopped before it ran."
      : "its session ended before it ran.";
  for (const current of rows)
    await updateApproval(
      tx,
      current,
      {
        status: "cancelled",
        reason,
        decidedAt: current.decidedAt ?? ctx.clock(),
        resolvedAt: ctx.clock(),
      },
      { ...attributionOf(current), ...attribution },
    );
  const started = await tx
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.sessionId, session.id),
        eq(approvals.status, "approved"),
        isNotNull(approvals.startedAt),
        isNull(approvals.resolvedAt),
      ),
    );
  const unknown: ApprovalOutcome = { ok: false, interrupted: "unknown" };
  for (const current of started)
    await updateApproval(
      tx,
      current,
      {
        outcome: unknown as unknown as JsonObject,
        resolvedAt: ctx.clock(),
      },
      { ...attributionOf(current), ...attribution },
    );
}

/** Every approval of the task, oldest first. */
export async function taskApprovals(
  exec: Executor,
  taskId: string,
): Promise<ApprovalRow[]> {
  return exec
    .select()
    .from(approvals)
    .where(eq(approvals.taskId, taskId))
    .orderBy(asc(approvals.createdAt), asc(approvals.id));
}

/** The pending approvals of these tasks, oldest first. */
export async function pendingApprovals(
  exec: Executor,
  taskIds: readonly string[],
): Promise<ApprovalRow[]> {
  if (taskIds.length === 0) return [];
  return exec
    .select()
    .from(approvals)
    .where(
      and(
        inArray(approvals.taskId, [...taskIds]),
        eq(approvals.status, "pending"),
      ),
    )
    .orderBy(asc(approvals.createdAt), asc(approvals.id));
}
