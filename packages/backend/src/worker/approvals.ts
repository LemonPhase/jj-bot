// Approvals in a session's runs: the review that holds a call, the claim
// that starts an approved one at most once, the decision a run applies, and
// parking a session that holds a call, at the end of its run or at launch.
import { matchingApprovalRule } from "@jj/contracts";
import {
  enqueue,
  type RunRow,
  type SessionRow,
  sessions,
  type Tx,
  tasks,
} from "@jj/db";
import { and, eq, inArray } from "drizzle-orm";
import type { EngineContext } from "../context";
import { type Attribution, wakeWorkers } from "../events";
import type {
  HeldCallDecision,
  PendingToolCall,
  ToolCallVerdict,
} from "../ports";
import {
  claimApproval,
  decisionInput,
  notRunText,
  pendingApprovals,
  requestApproval,
  unresolvedDecision,
} from "../services/approvals";
import { lockTask, updateSession, updateTask } from "../services/sessions";
import { holdingApproval } from "../services/spend-approvals";
import { COMPLETION_SET_ASIDE } from "./prompts";
import { attributionOf, type RunContext, writeRun } from "./run-context";
import { closeRun, closeStaleRun } from "./runs";

/** The error a second held call of the same session gets: one waits at a time. */
export const ONE_APPROVAL_AT_A_TIME =
  "Not run: another call of yours is already waiting for the user's approval. Make this call again once that one is answered.";

/**
 * Before a call runs: held for the user's approval when a rule of the bot's
 * own profile matches it, recorded with the call's redacted arguments.
 */
export async function reviewCall(
  rc: RunContext,
  call: PendingToolCall,
): Promise<ToolCallVerdict> {
  const rule = matchingApprovalRule(
    rc.approvalRules ?? [],
    call.tool,
    call.args,
  );
  if (!rule) return "run";
  if (rc.heldApprovalId) return { refuse: ONE_APPROVAL_AT_A_TIME };
  return writeRun(rc, async (tx) => {
    const task = (await lockTask(tx, rc.task.id)) ?? rc.task;
    const row = await requestApproval(tx, rc.deps.ctx, {
      task,
      session: rc.session,
      goalVersion: rc.goalVersionSeen ?? rc.task.goalVersion,
      runId: rc.run.id,
      botName: rc.bot.name,
      call,
      rule,
      redact: rc.redact,
    });
    // Made for a goal that changed meanwhile: answered now, never held.
    if (row.status === "expired") return { refuse: notRunText(row) };
    rc.heldApprovalId = row.id;
    return "hold" as const;
  });
}

/** Starts the approved call for this run, once: false when a run started it before. */
export function claimCall(rc: RunContext, toolCallId: string) {
  return writeRun(rc, (tx) =>
    claimApproval(tx, rc.deps.ctx, rc.session.id, toolCallId, rc.run.id),
  );
}

/**
 * The decision this executor call applies, if the session has one whose
 * result is not in its transcript yet. A completion the coordinator recorded
 * in the held batch is set aside, as new input sets it aside: the model
 * sees the answer first, and is told to call `complete_task` again.
 */
export async function runDecision(
  rc: RunContext,
): Promise<{ decision?: HeldCallDecision; inputs: string[] }> {
  const row = await unresolvedDecision(rc.deps.ctx.db, rc.session.id);
  rc.decisionCallId = row?.toolCallId;
  if (!row) return { inputs: [] };
  if (!rc.session.completionRequested)
    return { decision: decisionInput(row), inputs: [] };
  await writeRun(rc, async (tx) => {
    await tx
      .update(sessions)
      .set({ completionRequested: null })
      .where(eq(sessions.id, rc.session.id));
  });
  rc.session = { ...rc.session, completionRequested: null };
  return { decision: decisionInput(row), inputs: [COMPLETION_SET_ASIDE] };
}

/**
 * The run ended `held`: the session waits for the user's answer, without a
 * run. Call it with the task locked. An answer (or expiry) that landed after
 * the hold and before this write found the session still running, so it
 * woke nobody: checked again here, a session nothing holds any more is
 * woken at once, and its next run goes on.
 */
export async function parkHeld(
  tx: Tx,
  rc: RunContext,
  session: SessionRow,
): Promise<void> {
  const { ctx } = rc.deps;
  const attribution = attributionOf(rc);
  await closeRun(tx, ctx, rc.run, "waiting", attribution);
  await updateSession(
    tx,
    ctx,
    session,
    { status: "waiting", waitingFor: "approval" },
    attribution,
  );
  if (await holdingApproval(tx, session)) return;
  await enqueue(tx, {
    kind: "session.run",
    taskId: session.taskId,
    sessionId: session.id,
  });
  await wakeWorkers(tx, session.taskId);
}

/**
 * At a run's launch: a session that a pending approval holds (its own held
 * call, or a spend approval that covers it) does not run. It waits for the
 * answer (again, after a crash that left its run open), and its inbox waits
 * with it. True when it was parked.
 */
export async function parkIfHeld(
  tx: Tx,
  ctx: EngineContext,
  session: SessionRow,
  stale: RunRow | undefined,
): Promise<boolean> {
  const holding = await holdingApproval(tx, session);
  if (!holding) return false;
  if (stale)
    await closeStaleRun(
      tx,
      ctx,
      session,
      stale,
      "failed",
      holding.kind === "spend"
        ? "Interrupted by a worker restart; the session waits for the user's approval to spend past the threshold."
        : "Interrupted by a worker restart; the session waits for the user's approval of its held call.",
    );
  if (session.status !== "waiting" || session.waitingFor !== "approval")
    await updateSession(tx, ctx, session, {
      status: "waiting",
      waitingFor: "approval",
    });
  await settleApprovalWait(tx, ctx, session.taskId);
  return true;
}

/** True when the session has a decided approval its next run applies. */
export async function hasDecision(tx: Tx, sessionId: string) {
  return (await unresolvedDecision(tx, sessionId)) !== undefined;
}

/**
 * A running task with nothing queued or running, and a call waiting for the
 * user's approval, waits for the user. Call it with the task locked.
 */
export async function settleApprovalWait(
  tx: Tx,
  ctx: EngineContext,
  taskId: string,
  attribution: Attribution = {},
): Promise<void> {
  const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task || task.status !== "running" || task.cancelRequestedAt) return;
  const [active] = await tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.taskId, taskId),
        inArray(sessions.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  if (active) return;
  if ((await pendingApprovals(tx, [taskId])).length === 0) return;
  await updateTask(tx, ctx, task, { status: "waiting" }, attribution);
}
