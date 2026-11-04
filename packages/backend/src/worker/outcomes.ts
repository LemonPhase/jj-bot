// What happens when a run ends: the session waits, completes, fails or is
// cancelled, results go to the parent's inbox (waking it), and the task
// completes, waits for the user, fails or finishes its stop. One lease-fenced
// transaction per outcome.
import { isFinishedStatus, type VerificationPlan } from "@jj/contracts";
import {
  bots,
  complete,
  enqueue,
  runs,
  type SessionRow,
  type TaskRow,
  type Tx,
  verificationChecks,
} from "@jj/db";
import { and, eq, max } from "drizzle-orm";
import type { EngineContext } from "../context";
import { type Attribution, emit, wakeWorkers } from "../events";
import type { RunOutcome } from "../ports";
import { planOf } from "../records";
import { deliver, postMessage } from "../services/messages";
import {
  cancelOpenSessions,
  getSession,
  lockTask,
  openChildren,
  updateSession,
  updateTask,
} from "../services/sessions";
import { recordTaskUpdate } from "../services/task-updates";
import { settleCancellation } from "../services/tasks";
import {
  attemptChecks,
  summaryLine,
  taskVerification,
} from "../services/verification";
import { parkHeld, settleApprovalWait } from "./approvals";
import { openDelegationsText } from "./collab-tools";
import { attributionOf, type RunContext, writeRun } from "./run-context";
import {
  closeOpenTools,
  closeRun,
  hasContinuingInput,
  lastAssistantText,
} from "./runs";
import { handOnUnread } from "./unread";

export interface CompletionRequest {
  result: string;
  goalVersion: number;
  /**
   * Set by the verification gate (gate.ts) when every check of the task's
   * plan passed: the attempt that passed and the run whose gate ran it. A
   * task with a plan completes only in that run; another run's verification
   * is stale and the gate runs again.
   */
  verification?: { attempt: number; runId: string };
}

/**
 * Whether this run's gate passed the request: every criterion of the task's
 * current plan passed at the attempt it records, and that attempt is its
 * goal version's latest. Read in the transaction that completes the task.
 */
export async function gatePassed(
  tx: Tx,
  task: TaskRow,
  plan: VerificationPlan,
  request: CompletionRequest,
  runId: string,
): Promise<boolean> {
  const attempt = request.verification?.attempt;
  if (attempt === undefined || request.verification?.runId !== runId)
    return false;
  const [latest] = await tx
    .select({ value: max(verificationChecks.attempt) })
    .from(verificationChecks)
    .where(
      and(
        eq(verificationChecks.taskId, task.id),
        eq(verificationChecks.goalVersion, task.goalVersion),
      ),
    );
  if (latest?.value !== attempt) return false;
  const checks = await attemptChecks(tx, task.id, task.goalVersion, attempt);
  return plan.every((criterion) =>
    checks.some(
      (check) =>
        check.criterionId === criterion.id && check.outcome === "passed",
    ),
  );
}

const BUDGET_NOTE = "\n\n(Stopped at the turn budget.)";

/** The messages a finishing session never read, handed to its parent (unread.ts), as a paragraph. */
async function unreadNote(
  tx: Tx,
  ctx: EngineContext,
  session: SessionRow,
  name: string,
) {
  const note = await handOnUnread(tx, ctx, session, name);
  return note ? `${note}\n\n` : "";
}

/** A turn a spend cap ended: what was reached, and what lets the work go on. */
interface CapStop {
  reason: string;
  advice: string;
}

async function botName(tx: Tx, botId: string) {
  const [row] = await tx
    .select({ name: bots.name })
    .from(bots)
    .where(eq(bots.id, botId));
  return row?.name ?? "A bot";
}

/**
 * Fails a session visibly. A worker's failure goes to its parent as a result
 * message and wakes it; a coordinator's failure fails the task and cancels the
 * rest of its work. The session's own open delegations are cancelled.
 */
export async function failSessionTx(
  tx: Tx,
  ctx: EngineContext,
  task: TaskRow,
  session: SessionRow,
  error: string,
  attribution: Attribution,
): Promise<{ taskFinished: boolean }> {
  const name = await botName(tx, session.botId);
  const failed = await updateSession(
    tx,
    ctx,
    session,
    { status: "failed", error },
    attribution,
  );
  await cancelOpenSessions(
    tx,
    ctx,
    task.id,
    { under: session.id },
    attribution,
  );
  const text = `${name} failed: ${error}`;
  if (failed.parentSessionId) {
    const parent = await getSession(tx, failed.parentSessionId);
    if (!parent) return { taskFinished: false };
    const message = await postMessage(
      tx,
      ctx,
      {
        taskId: task.id,
        authorKind: "system",
        sessionId: failed.id,
        intent: "result",
        text,
        recipientBotIds: [parent.botId],
      },
      attribution,
    );
    await deliver(
      tx,
      parent,
      {
        kind: "result",
        text: `Failure from ${name} (session ${failed.id}):\n${error}\n\n${await unreadNote(tx, ctx, failed, name)}${await openDelegationsText(tx, parent)}`,
        sourceMessageId: message.id,
      },
      { wake: true, ctx },
    );
    return { taskFinished: false };
  }
  await cancelOpenSessions(
    tx,
    ctx,
    task.id,
    { except: failed.id },
    attribution,
  );
  await postMessage(
    tx,
    ctx,
    {
      taskId: task.id,
      authorKind: "system",
      sessionId: failed.id,
      intent: "discussion",
      text,
    },
    attribution,
  );
  await updateTask(
    tx,
    ctx,
    task,
    { status: "failed", error: text },
    attribution,
  );
  await emit(tx, ctx, task.id, {
    type: "task.finished",
    payload: { status: "failed", result: null, error: text },
    ...attribution,
  });
  await recordTaskUpdate(tx, ctx, task, "failed", text);
  return { taskFinished: true };
}

/**
 * The session ended its turn: wait for delegations, report to the parent, or
 * finish/wait the task. `cap` is set when a spend cap ended it: a worker's
 * result says so, and a coordinator left waiting for the user posts a system
 * message with the cap and what lets the task go on.
 */
async function endTurn(
  tx: Tx,
  rc: RunContext,
  task: TaskRow,
  session: SessionRow,
  text: string,
  cap?: CapStop,
) {
  const { ctx } = rc.deps;
  const attribution = attributionOf(rc);
  if ((await openChildren(tx, session)).length > 0) {
    // A coordinator may answer the user (a status question) while it waits.
    if (session.parentSessionId === null && text.trim())
      await postMessage(
        tx,
        ctx,
        {
          taskId: task.id,
          authorKind: "bot",
          authorBotId: session.botId,
          sessionId: session.id,
          intent: "discussion",
          text,
        },
        attribution,
      );
    await updateSession(
      tx,
      ctx,
      session,
      {
        status: "waiting",
        waitingFor: "delegations",
        completionRequested: null,
      },
      attribution,
    );
    await closeRun(tx, ctx, rc.run, "waiting", attribution);
    return;
  }
  if (session.parentSessionId === null) {
    const request = session.completionRequested as CompletionRequest | null;
    const plan = planOf(task.verificationPlan);
    // The one place a task completes: with a plan, only on passing evidence
    // for the current goal version, read again here.
    const unverified =
      request !== null &&
      request.goalVersion === task.goalVersion &&
      plan !== null &&
      !(await gatePassed(tx, task, plan, request, rc.run.id));
    if (request && request.goalVersion === task.goalVersion && !unverified) {
      await postMessage(
        tx,
        ctx,
        {
          taskId: task.id,
          authorKind: "bot",
          authorBotId: session.botId,
          sessionId: session.id,
          intent: "result",
          text: request.result,
        },
        attribution,
      );
      await updateSession(
        tx,
        ctx,
        session,
        {
          status: "completed",
          result: request.result,
          completionRequested: null,
        },
        attribution,
      );
      await closeRun(tx, ctx, rc.run, "completed", attribution);
      await updateTask(
        tx,
        ctx,
        task,
        { status: "completed", result: request.result, error: null },
        attribution,
      );
      await emit(tx, ctx, task.id, {
        type: "task.finished",
        payload: { status: "completed", result: request.result, error: null },
        ...attribution,
      });
      const verification = plan ? await taskVerification(tx, task) : undefined;
      await recordTaskUpdate(
        tx,
        ctx,
        task,
        "completed",
        verification
          ? `Verification: ${summaryLine(verification)}.\n\n${request.result}`
          : request.result,
      );
      rc.taskFinished = true;
      return;
    }
    // A turn that ends without the coordinator's own answer to the user gets
    // a system message saying what holds: a spend cap stopped it, or its
    // completion did not pass verification (its last words, "done", would
    // mislead, so they are not posted).
    const held = unverified
      ? {
          text: `Not completed: the verification checks have not all passed for goal version ${task.goalVersion}.`,
          replaces: true,
        }
      : cap
        ? {
            text: `Stopped: ${cap.reason} ${cap.advice}`,
            replaces: !text.trim(),
          }
        : undefined;
    if (!held?.replaces)
      await postMessage(
        tx,
        ctx,
        {
          taskId: task.id,
          authorKind: "bot",
          authorBotId: session.botId,
          sessionId: session.id,
          intent: "discussion",
          text,
        },
        attribution,
      );
    if (held)
      await postMessage(
        tx,
        ctx,
        {
          taskId: task.id,
          authorKind: "system",
          sessionId: session.id,
          intent: "discussion",
          text: held.text,
        },
        attribution,
      );
    await updateSession(
      tx,
      ctx,
      session,
      { status: "waiting", waitingFor: "user", completionRequested: null },
      attribution,
    );
    await closeRun(tx, ctx, rc.run, "waiting", attribution);
    if (task.status !== "waiting") {
      await updateTask(tx, ctx, task, { status: "waiting" }, attribution);
      // A task that continues and waits again is a new event.
      // Held, the chat is told what holds, after any text of the turn it posted.
      await recordTaskUpdate(
        tx,
        ctx,
        task,
        "waiting",
        held
          ? [held.replaces ? "" : text.trim(), held.text]
              .filter(Boolean)
              .join("\n\n")
          : text,
      );
    }
    return;
  }
  const parent = await getSession(tx, session.parentSessionId);
  const message = await postMessage(
    tx,
    ctx,
    {
      taskId: task.id,
      authorKind: "bot",
      authorBotId: session.botId,
      sessionId: session.id,
      intent: "result",
      text: cap
        ? `${text}\n\n(Stopped before finishing: ${cap.reason})`.trim()
        : text,
      recipientBotIds: parent ? [parent.botId] : [],
    },
    attribution,
  );
  await updateSession(
    tx,
    ctx,
    session,
    { status: "completed", result: message.text },
    attribution,
  );
  await closeRun(tx, ctx, rc.run, "completed", attribution);
  if (!parent) return;
  const stale =
    session.goalVersion < task.goalVersion
      ? `\n\n(This work was done for goal version ${session.goalVersion}; the goal is now version ${task.goalVersion}.)`
      : "";
  await deliver(
    tx,
    parent,
    {
      kind: "result",
      text: `Result from ${rc.bot.name} (session ${session.id}):\n${message.text}${stale}\n\n${await unreadNote(tx, ctx, session, rc.bot.name)}${await openDelegationsText(tx, parent)}`,
      sourceMessageId: message.id,
    },
    { wake: true, ctx },
  );
}

/** The run was stopped (user stop, or its parent or task finished). */
async function cancelRun(
  tx: Tx,
  rc: RunContext,
  task: TaskRow,
  session: SessionRow,
) {
  const { ctx } = rc.deps;
  const attribution = attributionOf(rc);
  await closeOpenTools(
    tx,
    ctx,
    rc.run,
    attribution,
    "Interrupted: the task was stopped.",
  );
  await closeRun(tx, ctx, rc.run, "cancelled", attribution);
  if (!isFinishedStatus(session.status))
    await updateSession(tx, ctx, session, { status: "cancelled" }, attribution);
  if (await settleCancellation(tx, ctx, task)) rc.taskFinished = true;
  else if (isFinishedStatus(task.status)) rc.taskFinished = true;
}

/** The worker is stopping: end this run and queue the session to resume on the next worker. */
async function handOff(rc: RunContext) {
  const { ctx } = rc.deps;
  await writeRun(rc, async (tx) => {
    await lockTask(tx, rc.task.id);
    const session = await getSession(tx, rc.session.id);
    if (!session) return;
    const attribution = attributionOf(rc);
    const note =
      "The worker stopped; the session resumes from its last completed turn.";
    await closeOpenTools(tx, ctx, rc.run, attribution, note);
    await closeRun(tx, ctx, rc.run, "cancelled", attribution, note);
    if (!isFinishedStatus(session.status))
      await updateSession(tx, ctx, session, { status: "queued" }, attribution);
    await complete(tx, rc.job.lease);
    await enqueue(tx, {
      kind: "session.run",
      taskId: rc.task.id,
      sessionId: session.id,
      payload: { reason: "recovery" },
    });
    await wakeWorkers(tx, rc.task.id);
  });
}

/** A run that had nothing to do: the session goes back to where it was, and nothing is posted. */
async function restorePrevious(tx: Tx, rc: RunContext, session: SessionRow) {
  const { ctx } = rc.deps;
  const attribution = attributionOf(rc);
  const previous = rc.previous;
  await updateSession(
    tx,
    ctx,
    session,
    previous.status === "waiting"
      ? { status: "waiting", waitingFor: previous.waitingFor ?? "delegations" }
      : { status: previous.status === "running" ? "queued" : previous.status },
    attribution,
  );
  await closeRun(
    tx,
    ctx,
    rc.run,
    previous.status === "waiting" ? "waiting" : "completed",
    attribution,
  );
}

/**
 * Applies the outcome of a run (after any continuation) in one fenced
 * transaction. `snapshotted` says the run's files are recorded (its last
 * snapshot completed), which clears its `snapshot_pending`.
 */
export async function finishRun(
  rc: RunContext,
  raw: RunOutcome,
  mayContinue: boolean,
  snapshotted = false,
): Promise<"done" | "continue"> {
  // Final text and errors (a thrown message included) become messages and
  // session records: redacted like everything else the run persists.
  const outcome = rc.redact(raw);
  const reason = rc.control.reason;
  if (rc.control.fenced) return "done";
  if (reason === "shutdown") {
    await handOff(rc);
    return "done";
  }
  const { ctx } = rc.deps;
  return writeRun(rc, async (tx): Promise<"done" | "continue"> => {
    const task = await lockTask(tx, rc.task.id);
    const session = await getSession(tx, rc.session.id);
    if (!task || !session) {
      await complete(tx, rc.job.lease);
      return "done";
    }
    rc.task = task;
    rc.session = session;
    const parent = session.parentSessionId
      ? await getSession(tx, session.parentSessionId)
      : undefined;
    const stopped =
      reason === "cancel" ||
      task.cancelRequestedAt !== null ||
      isFinishedStatus(task.status) ||
      isFinishedStatus(session.status) ||
      (parent !== undefined && isFinishedStatus(parent.status));
    // With the task locked no delivery can interleave: input that arrived
    // since the last drain continues the run instead of ending the turn.
    if (
      !stopped &&
      mayContinue &&
      outcome.kind === "ended" &&
      (await hasContinuingInput(tx, session.id))
    )
      return "continue";
    if (stopped) await cancelRun(tx, rc, task, session);
    else if (outcome.kind === "held") await parkHeld(tx, rc, session);
    else if (outcome.kind === "idle") {
      if (rc.reason === "recovery")
        // The last turn ended before the restart; finish it now (nothing was posted yet).
        await endTurn(
          tx,
          rc,
          task,
          session,
          (await lastAssistantText(tx, session.id)) ?? "",
        );
      else await restorePrevious(tx, rc, session);
    } else if (outcome.kind === "budget" && outcome.limit === "spend") {
      const reason =
        rc.spendStop?.message ?? outcome.reason ?? "A spend cap was reached.";
      await endTurn(tx, rc, task, session, outcome.finalText, {
        reason,
        advice: rc.spendStop?.advice ?? "Raise the spend cap to continue.",
      });
    } else if (outcome.kind === "ended" || outcome.kind === "budget")
      await endTurn(
        tx,
        rc,
        task,
        session,
        outcome.kind === "budget"
          ? `${outcome.finalText}${BUDGET_NOTE}`.trim()
          : outcome.finalText,
      );
    else {
      const error =
        outcome.kind === "error"
          ? outcome.code
            ? `model error (${outcome.code}): ${outcome.error}`
            : outcome.error
          : outcome.reason === "sandbox_released"
            ? "The task's sandbox was released while the run was in progress."
            : "The run was aborted.";
      await closeRun(tx, ctx, rc.run, "failed", attributionOf(rc), error);
      const failed = await failSessionTx(
        tx,
        ctx,
        task,
        session,
        error,
        attributionOf(rc),
      );
      if (failed.taskFinished) rc.taskFinished = true;
    }
    // Nothing left running but calls waiting for approval: the task waits for the user.
    await settleApprovalWait(tx, ctx, task.id, attributionOf(rc));
    if (snapshotted)
      await tx
        .update(runs)
        .set({ snapshotPending: false })
        .where(eq(runs.id, rc.run.id));
    await complete(tx, rc.job.lease);
    return "done";
  });
}
