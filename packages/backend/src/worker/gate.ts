// The verification gate. When a coordinator whose task has a plan called
// `complete_task` and its turn ended (after the run's last tool, so nothing
// batched after `complete_task` can change the workspace behind a check), the
// worker runs every criterion of the plan in the task's sandbox and records
// each outcome. All passed: the completion request records the attempt and
// `endTurn` completes the task, after checking that evidence again in its own
// transaction. Otherwise the request is cleared and the coordinator gets the
// outcomes as a result it must react to.
import {
  CHECK_OUTPUT_PREVIEW_LIMIT,
  type CheckOutcome,
  isFinishedStatus,
  type VerificationCheck,
  type VerificationCriterion,
  type VerificationPlan,
} from "@jj/contracts";
import {
  type SessionRow,
  sessions,
  type TaskRow,
  type Tx,
  taskEvents,
  verificationChecks,
} from "@jj/db";
import { and, eq, max, sql } from "drizzle-orm";
import { emit } from "../events";
import { planOf, toVerificationCheck } from "../records";
import type { CutEdges } from "../redact";
import { deliver, postMessage } from "../services/messages";
import { getSession, lockTask } from "../services/sessions";
import {
  type CheckRun,
  clipDetail,
  headAndTail,
  runCheck,
  tailOf,
} from "./checks";
import type { CompletionRequest } from "./outcomes";
import { quoteLines } from "./quote";
import { attributionOf, type RunContext, spill, writeRun } from "./run-context";
import type { SandboxHold } from "./sandboxes";

/** Bytes of a failing command's output the coordinator is shown. */
const MODEL_TAIL_BYTES = 2 * 1024;

export type GateResult = "none" | "passed" | "failed";

interface Pending {
  plan: VerificationPlan;
  request: CompletionRequest;
  attempt: number;
}

/**
 * The completion request a gate must check, or undefined when none is due. A
 * request this run's gate already passed is not due again; one another run
 * verified is stale (that run may have been cut off after its gate, and a
 * later turn may have changed the workspace), so the gate runs again.
 */
function dueRequest(
  task: TaskRow,
  session: SessionRow,
  runId: string,
): { plan: VerificationPlan; request: CompletionRequest } | undefined {
  if (session.parentSessionId !== null) return undefined;
  const request = session.completionRequested as CompletionRequest | null;
  if (!request || request.verification?.runId === runId) return undefined;
  if (request.goalVersion !== task.goalVersion) return undefined;
  if (task.cancelRequestedAt || isFinishedStatus(task.status)) return undefined;
  const plan = planOf(task.verificationPlan);
  return plan ? { plan, request } : undefined;
}

/**
 * The next attempt number of a goal version: one more than every gate run
 * that started for it, including one a crash cut off before any check was
 * recorded (its `verification.started` event is durable), so an attempt's
 * number is never reused.
 */
async function nextAttempt(tx: Tx, taskId: string, goalVersion: number) {
  const [started] = await tx
    .select({
      value: max(sql<number>`(${taskEvents.payload}->>'attempt')::int`),
    })
    .from(taskEvents)
    .where(
      and(
        eq(taskEvents.taskId, taskId),
        eq(taskEvents.type, "verification.started"),
        sql`(${taskEvents.payload}->>'goalVersion')::int = ${goalVersion}`,
      ),
    );
  const [checked] = await tx
    .select({ value: max(verificationChecks.attempt) })
    .from(verificationChecks)
    .where(
      and(
        eq(verificationChecks.taskId, taskId),
        eq(verificationChecks.goalVersion, goalVersion),
      ),
    );
  return Math.max(Number(started?.value ?? 0), checked?.value ?? 0) + 1;
}

const OUTCOME_WORD: Record<CheckOutcome, string> = {
  passed: "passed",
  failed: "FAILED",
  inconclusive: "INCONCLUSIVE",
};

/** One criterion's outcome as the coordinator is told it. */
function outcomeLines(
  criterion: VerificationCriterion,
  run: CheckRun,
  redact: (text: string) => string,
): string[] {
  const what =
    criterion.method === "command" ? ` \`${criterion.command}\`` : "";
  const lines = [
    `- ${criterion.id} (${criterion.description}): ${OUTCOME_WORD[run.outcome]}.${what} ${run.detail}`,
  ];
  if (run.outcome !== "passed" && run.output?.trim())
    lines.push(
      `  Output (its last ${MODEL_TAIL_BYTES / 1024} KiB at most):`,
      quoteLines(tailOf(redact(run.output), MODEL_TAIL_BYTES)),
    );
  return lines;
}

/**
 * Runs the gate when the coordinator's completion request awaits it. Returns
 * `none` when no gate was due (no plan, no request, already verified, a stale
 * goal version, a stopping task) or the run was stopped meanwhile.
 */
export async function runVerificationGate(
  rc: RunContext,
  hold: SandboxHold,
  deadline: Date,
): Promise<GateResult> {
  // Cheap first: only a coordinator that asked to complete can be due.
  if (
    rc.control.reason ||
    rc.session.parentSessionId !== null ||
    !rc.session.completionRequested
  )
    return "none";
  const { ctx } = rc.deps;
  const pending = await writeRun(
    rc,
    async (tx): Promise<Pending | undefined> => {
      const task = await lockTask(tx, rc.task.id);
      const session = await getSession(tx, rc.session.id);
      if (!task || !session) return undefined;
      rc.task = task;
      rc.session = session;
      const due = dueRequest(task, session, rc.run.id);
      if (!due) return undefined;
      const attempt = await nextAttempt(tx, task.id, task.goalVersion);
      await emit(tx, task.id, {
        type: "verification.started",
        payload: {
          goalVersion: task.goalVersion,
          attempt,
          criteria: due.plan.length,
        },
        ...attributionOf(rc),
      });
      return { ...due, attempt };
    },
  );
  if (!pending) return "none";
  rc.verificationAttempts += 1;
  const { plan, request, attempt } = pending;
  const goalVersion = request.goalVersion;
  const redact = (text: string, cut?: CutEdges) => rc.redact(text, cut);
  const previewBytes = Math.min(
    CHECK_OUTPUT_PREVIEW_LIMIT,
    ctx.config.outputCapBytes,
  );
  const runs: { criterion: VerificationCriterion; run: CheckRun }[] = [];
  for (const [position, criterion] of plan.entries()) {
    if (rc.control.controller.signal.aborted) break;
    const startedAt = ctx.clock();
    const run = await runCheck(criterion, {
      sandbox: hold.sandbox,
      limits: hold.spec.limits,
      signal: rc.control.controller.signal,
      deadline,
      result: request.result,
      redact,
    });
    runs.push({ criterion, run });
    await writeRun(rc, async (tx) => {
      // Output is redacted before it is capped or spilled, like tool output.
      const output = run.output === null ? null : redact(run.output);
      let preview: string | null = null;
      let truncated = false;
      let artifactId: string | null = null;
      if (output !== null) {
        const capped = headAndTail(output, previewBytes);
        preview = capped.text;
        truncated = capped.truncated;
        if (truncated)
          artifactId = await spill(
            tx,
            rc,
            output,
            `verification ${criterion.id} output (goal version ${goalVersion}, attempt ${attempt})`,
          );
      }
      const [row] = await tx
        .insert(verificationChecks)
        .values({
          id: ctx.ids("check"),
          taskId: rc.task.id,
          goalVersion,
          attempt,
          position,
          criterionId: criterion.id,
          method: criterion.method,
          outcome: run.outcome,
          exitCode: run.exitCode,
          interrupted: run.interrupted,
          durationMs: Math.max(0, Math.round(run.durationMs)),
          detail: clipDetail(redact(run.detail)),
          output: preview,
          truncated,
          artifactId,
          sessionId: rc.session.id,
          runId: rc.run.id,
          startedAt,
          finishedAt: ctx.clock(),
        })
        .returning();
      if (!row) throw new Error("The check insert returned no row.");
      const check: VerificationCheck = toVerificationCheck(row);
      await emit(tx, rc.task.id, {
        type: "verification.checked",
        payload: { check },
        ...attributionOf(rc),
      });
    });
  }
  const count = (outcome: CheckOutcome) =>
    runs.filter(({ run }) => run.outcome === outcome).length;
  const passed = count("passed");
  const failed = count("failed");
  const inconclusive = plan.length - passed - failed;
  const outcome: CheckOutcome =
    passed === plan.length ? "passed" : failed > 0 ? "failed" : "inconclusive";
  return writeRun(rc, async (tx): Promise<GateResult> => {
    const task = await lockTask(tx, rc.task.id);
    const session = await getSession(tx, rc.session.id);
    if (!task || !session) return "none";
    rc.task = task;
    rc.session = session;
    const attribution = attributionOf(rc);
    await emit(tx, task.id, {
      type: "verification.finished",
      payload: { goalVersion, attempt, outcome, passed, failed, inconclusive },
      ...attribution,
    });
    // Stopped, or the request moved on (the goal changed, new input set it
    // aside): what happens next is decided elsewhere; the evidence stays.
    const current = session.completionRequested as CompletionRequest | null;
    if (
      rc.control.reason ||
      task.cancelRequestedAt ||
      isFinishedStatus(task.status) ||
      task.goalVersion !== goalVersion ||
      !current ||
      current.goalVersion !== goalVersion ||
      current.result !== request.result
    )
      return "none";
    const where = `goal version ${goalVersion}, attempt ${attempt}`;
    if (outcome === "passed") {
      const verified: CompletionRequest = {
        ...request,
        verification: { attempt, runId: rc.run.id },
      };
      await tx
        .update(sessions)
        .set({ completionRequested: { ...verified } })
        .where(eq(sessions.id, session.id));
      rc.session = { ...session, completionRequested: { ...verified } };
      await postMessage(
        tx,
        ctx,
        {
          taskId: task.id,
          authorKind: "system",
          sessionId: session.id,
          intent: "notification",
          text: `Verification passed: all ${plan.length} checks passed (${where}).`,
        },
        attribution,
      );
      return "passed";
    }
    await tx
      .update(sessions)
      .set({ completionRequested: null })
      .where(eq(sessions.id, session.id));
    rc.session = { ...session, completionRequested: null };
    const notPassed = runs
      .filter(({ run }) => run.outcome !== "passed")
      .map(({ criterion, run }) => `${criterion.id} ${run.outcome}`);
    const notRun = plan.length - runs.length;
    const message = await postMessage(
      tx,
      ctx,
      {
        taskId: task.id,
        authorKind: "system",
        sessionId: session.id,
        intent: "notification",
        text: `Verification ${outcome === "failed" ? "failed" : "was inconclusive"}: ${passed} of ${plan.length} checks passed (${where}); ${[...notPassed, ...(notRun ? [`${notRun} not run`] : [])].join(", ")}. The task did not complete.`,
      },
      attribution,
    );
    const left = ctx.config.maxVerificationAttempts - rc.verificationAttempts;
    const next =
      left > 0
        ? `Revise the work, then call \`complete_task\` again: it runs every check again. ${left} more attempt${left === 1 ? "" : "s"} in this run.`
        : "No verification attempts are left in this run: do not call `complete_task` again. Tell the user what still fails and what you need, then end your turn; the task waits for the user.";
    await deliver(
      tx,
      session,
      {
        kind: "result",
        // The plan's own text (a command) is the user's; it is stored here, so redacted too.
        text: redact(
          [
            `Verification of ${where}: ${passed} of ${plan.length} checks passed, so the task did not complete.`,
            ...runs.flatMap(({ criterion, run }) =>
              outcomeLines(criterion, run, redact),
            ),
            ...plan
              .slice(runs.length)
              .map(
                (criterion) =>
                  `- ${criterion.id} (${criterion.description}): not run.`,
              ),
            "",
            next,
          ].join("\n"),
        ),
        sourceMessageId: message.id,
      },
      { wake: true, ctx },
    );
    return "failed";
  });
}
