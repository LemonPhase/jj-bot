// Run rows and what a run reads at its end: closing a run, reporting what it
// left in flight (a command running when a run ended abnormally is reported as
// interrupted with an unknown outcome and never re-run), the transcript's last
// text and input that continues a run.
import {
  type RunRow,
  type RunStatus,
  runs,
  type SessionRow,
  sessionEntries,
  sessionInbox,
  type Tx,
  taskEvents,
} from "@jj/db";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
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

/** The text of the transcript's last entry when it is a final assistant message. */
export async function lastAssistantText(tx: Tx, sessionId: string) {
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

/** Undelivered input that continues a run (results, briefs, steering). */
export async function hasContinuingInput(tx: Tx, sessionId: string) {
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
