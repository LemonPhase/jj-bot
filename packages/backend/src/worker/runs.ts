// Run rows and what a run reads at its end: closing a run, reporting what it
// left in flight (a command running when a run ended abnormally is reported as
// interrupted with an unknown outcome and never re-run), the transcript's last
// text and how its last turn ended, and input that continues a run.
import {
  type Executor,
  type RunRow,
  type RunStatus,
  runs,
  type SessionRow,
  sessionEntries,
  sessionInbox,
  type Tx,
  taskEvents,
} from "@jj/db";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  max,
  sql,
} from "drizzle-orm";
import type { EngineContext } from "../context";
import { type Attribution, emit } from "../events";
import { isParkedText } from "./parking";

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

/**
 * The transcript's last message. Compaction entries are checkpoints, not
 * messages, and are skipped.
 */
async function lastEntry(exec: Executor, sessionId: string) {
  const [row] = await exec
    .select({ entry: sessionEntries.entry })
    .from(sessionEntries)
    .where(
      and(
        eq(sessionEntries.sessionId, sessionId),
        sql`${sessionEntries.entry}->>'role' is distinct from 'compaction'`,
      ),
    )
    .orderBy(desc(sessionEntries.seq))
    .limit(1);
  return row?.entry;
}

/** The text of the transcript's last message when it is a final assistant message. */
export async function lastAssistantText(tx: Tx, sessionId: string) {
  const entry = await lastEntry(tx, sessionId);
  return entry ? assistantText(entry) : undefined;
}

/**
 * How a transcript's last turn ended: `answer` when it ends with the model's
 * answer (an assistant message that calls no tools), `engine` when the
 * engine ended the turn after its calls (a parked turn, whose calls are
 * answered with `parkedText`, or a `complete_task` that succeeded, which
 * ends the run). Undefined while the turn is open: an empty transcript,
 * input the model has not answered, or results of its calls it has not
 * seen. Compaction entries are checkpoints, not messages, and are skipped.
 */
export function turnEnd(entries: readonly unknown[]): TurnEnd | undefined {
  const messages = entries.filter((entry) => roleOf(entry) !== "compaction");
  let start = messages.length - 1;
  while (start >= 0 && roleOf(messages[start]) !== "assistant") start -= 1;
  if (start < 0) return undefined;
  const after = messages.slice(start + 1);
  if (!callsTools(messages[start]))
    return after.length === 0 ? "answer" : undefined;
  if (
    after.length === 0 ||
    after.some((entry) => roleOf(entry) !== "toolResult")
  )
    return undefined;
  return after.some(endsRun) ? "engine" : undefined;
}

export type TurnEnd = "answer" | "engine";

const roleOf = (entry: unknown) =>
  entry && typeof entry === "object"
    ? (entry as { role?: unknown }).role
    : undefined;

const blocksOf = (entry: unknown): { type?: unknown; text?: unknown }[] => {
  const content = (entry as { content?: unknown }).content;
  return Array.isArray(content) ? content : [];
};

const callsTools = (entry: unknown) =>
  blocksOf(entry).some((block) => block?.type === "toolCall");

/** A tool result with which the engine ended the turn, or the run. */
function endsRun(entry: unknown): boolean {
  const result = entry as { toolName?: unknown; isError?: unknown };
  if (result.isError !== true) return result.toolName === "complete_task";
  const text = blocksOf(entry)
    .flatMap((block) =>
      block?.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("");
  return isParkedText(text);
}

/** How the session's transcript's last turn ended (`turnEnd`), read from its tail. */
export async function endedTurn(
  exec: Executor,
  sessionId: string,
): Promise<TurnEnd | undefined> {
  const [last] = await exec
    .select({ seq: max(sessionEntries.seq) })
    .from(sessionEntries)
    .where(
      and(
        eq(sessionEntries.sessionId, sessionId),
        sql`${sessionEntries.entry}->>'role' = 'assistant'`,
      ),
    );
  if (last?.seq == null) return undefined;
  const rows = await exec
    .select({ entry: sessionEntries.entry })
    .from(sessionEntries)
    .where(
      and(
        eq(sessionEntries.sessionId, sessionId),
        gte(sessionEntries.seq, last.seq),
      ),
    )
    .orderBy(asc(sessionEntries.seq));
  return turnEnd(rows.map((row) => row.entry));
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

/** Input kinds that start or continue a run; plain messages wait for the next activation. */
export const CONTINUING_KINDS = ["brief", "result", "steering"] as const;

/** A brief, result or steering: input that starts or continues a run. */
export const isContinuing = (kind: string) =>
  (CONTINUING_KINDS as readonly string[]).includes(kind);

/** Undelivered input that starts or continues a run (briefs, results, steering). */
export async function hasContinuingInput(tx: Tx, sessionId: string) {
  const [row] = await tx
    .select({ id: sessionInbox.id })
    .from(sessionInbox)
    .where(
      and(
        eq(sessionInbox.sessionId, sessionId),
        isNull(sessionInbox.deliveredAt),
        inArray(sessionInbox.kind, [...CONTINUING_KINDS]),
      ),
    )
    .limit(1);
  return row !== undefined;
}
