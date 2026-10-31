// What happens when a run ends: the session waits, completes, fails or is
// cancelled, results go to the parent's inbox (waking it), and the task
// completes, waits for the user, fails or finishes its stop. One lease-fenced
// transaction per outcome.
import { isFinishedStatus } from "@jj/contracts";
import {
  bots,
  complete,
  enqueue,
  type SessionRow,
  sessionEntries,
  sessionInbox,
  type TaskRow,
  type Tx,
} from "@jj/db";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import type { EngineContext } from "../context";
import { type Attribution, emit, wakeWorkers } from "../events";
import { deliver, postMessage } from "../services/messages";
import {
  cancelOpenSessions,
  getSession,
  lockTask,
  openChildren,
  updateSession,
  updateTask,
} from "../services/sessions";
import { settleCancellation } from "../services/tasks";
import type { RunOutcome } from "../ports";
import { attributionOf, type RunContext, writeRun } from "./run-context";
import { closeOpenTools, closeRun } from "./runs";

export interface CompletionRequest {
  result: string;
  goalVersion: number;
}

const BUDGET_NOTE = "\n\n(Stopped at the turn budget.)";

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
        text: `Failure from ${name} (session ${failed.id}):\n${error}`,
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
  await emit(tx, task.id, {
    type: "task.finished",
    payload: { status: "failed", result: null, error: text },
    ...attribution,
  });
  return { taskFinished: true };
}

/** The session ended its turn: wait for delegations, report to the parent, or finish/wait the task. */
async function endTurn(
  tx: Tx,
  rc: RunContext,
  task: TaskRow,
  session: SessionRow,
  text: string,
) {
  const { ctx } = rc.deps;
  const attribution = attributionOf(rc);
  if ((await openChildren(tx, session)).length > 0) {
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
    if (request && request.goalVersion === task.goalVersion) {
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
      await emit(tx, task.id, {
        type: "task.finished",
        payload: { status: "completed", result: request.result, error: null },
        ...attribution,
      });
      rc.taskFinished = true;
      return;
    }
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
      { status: "waiting", waitingFor: "user", completionRequested: null },
      attribution,
    );
    await closeRun(tx, ctx, rc.run, "waiting", attribution);
    if (task.status !== "waiting")
      await updateTask(tx, ctx, task, { status: "waiting" }, attribution);
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
      text,
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
      text: `Result from ${rc.bot.name} (session ${session.id}):\n${message.text}${stale}`,
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
    await closeOpenTools(tx, rc.run, attribution, note);
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

/** The text of the transcript's last entry when it is a final assistant message. */
async function lastAssistantText(tx: Tx, sessionId: string) {
  const [row] = await tx
    .select({ entry: sessionEntries.entry })
    .from(sessionEntries)
    .where(eq(sessionEntries.sessionId, sessionId))
    .orderBy(desc(sessionEntries.seq))
    .limit(1);
  return row ? assistantText(row.entry) : undefined;
}

/** A pi assistant message's text blocks, joined; undefined for any other entry. */
export function assistantText(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const message = entry as { role?: unknown; content?: unknown };
  if (message.role !== "assistant") return undefined;
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return undefined;
  return message.content
    .flatMap((block: { type?: unknown; text?: unknown }) =>
      block?.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("");
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

/** Applies the outcome of a run (after any continuation) in one fenced transaction. */
export async function finishRun(
  rc: RunContext,
  outcome: RunOutcome,
  mayContinue: boolean,
): Promise<"done" | "continue"> {
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
    await complete(tx, rc.job.lease);
    return "done";
  });
}

async function hasContinuingInput(tx: Tx, sessionId: string) {
  const [row] = await tx
    .select({ id: sessionInbox.id })
    .from(sessionInbox)
    .where(
      and(
        eq(sessionInbox.sessionId, sessionId),
        isNull(sessionInbox.deliveredAt),
        inArray(sessionInbox.kind, ["brief", "result", "steering"]),
      ),
    )
    .limit(1);
  return row !== undefined;
}
