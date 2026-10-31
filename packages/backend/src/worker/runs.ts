// Run rows: closing a run, and reporting what a run left in flight. A command
// that was running when a run ended abnormally is reported as interrupted with
// an unknown outcome; it is never re-run.
import {
  type RunRow,
  type RunStatus,
  runs,
  type SessionRow,
  type Tx,
  taskEvents,
} from "@jj/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { EngineContext } from "../context";
import { type Attribution, emit } from "../events";

const OUTCOME: Record<
  Exclude<RunStatus, "running">,
  "completed" | "waiting" | "failed" | "cancelled"
> = {
  completed: "completed",
  waiting: "waiting",
  failed: "failed",
  cancelled: "cancelled",
};

/** Ends a run row and emits `run.finished`. */
export async function closeRun(
  tx: Tx,
  ctx: EngineContext,
  run: RunRow,
  status: Exclude<RunStatus, "running">,
  attribution: Attribution,
  error?: string,
): Promise<void> {
  await tx
    .update(runs)
    .set({ status, error: error ?? null, finishedAt: ctx.clock() })
    .where(eq(runs.id, run.id));
  await emit(tx, run.taskId, {
    type: "run.finished",
    payload: { outcome: OUTCOME[status], ...(error ? { error } : {}) },
    ...attribution,
    runId: run.id,
  });
}

/**
 * Emits `tool.finished` (interrupted: unknown) for every tool the run started
 * and never reported finished, so the log shows what was cut off.
 */
export async function closeOpenTools(
  tx: Tx,
  run: RunRow,
  attribution: Attribution,
  note: string,
): Promise<void> {
  const rows = await tx
    .select()
    .from(taskEvents)
    .where(
      and(
        eq(taskEvents.taskId, run.taskId),
        eq(taskEvents.runId, run.id),
        inArray(taskEvents.type, ["tool.started", "tool.finished"]),
      ),
    )
    .orderBy(asc(taskEvents.sequence));
  const finished = new Set(
    rows
      .filter((row) => row.type === "tool.finished")
      .map((row) => String(row.payload.toolCallId)),
  );
  for (const row of rows) {
    if (row.type !== "tool.started") continue;
    const toolCallId = String(row.payload.toolCallId);
    if (finished.has(toolCallId)) continue;
    await emit(tx, run.taskId, {
      type: "tool.finished",
      payload: {
        toolCallId,
        tool: String(row.payload.tool),
        summary: String(row.payload.summary ?? ""),
        ok: false,
        interrupted: "unknown",
        output: note,
        truncated: false,
      },
      ...attribution,
      runId: run.id,
    });
  }
}

export async function runningRun(
  tx: Tx,
  sessionId: string,
): Promise<RunRow | undefined> {
  const [row] = await tx
    .select()
    .from(runs)
    .where(and(eq(runs.sessionId, sessionId), eq(runs.status, "running")));
  return row;
}

/** Closes a run left `running` by a worker that died. */
export async function closeStaleRun(
  tx: Tx,
  ctx: EngineContext,
  session: SessionRow,
  run: RunRow,
  status: "failed" | "cancelled",
  note: string,
): Promise<void> {
  const attribution = { botId: session.botId, sessionId: session.id };
  await closeOpenTools(tx, run, attribution, note);
  await closeRun(tx, ctx, run, status, attribution, note);
}
