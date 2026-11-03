// The state of one claimed job while it runs, the lease-fenced write helper,
// and the executor hooks that turn runtime activity into durable rows.
import type { ApprovalRule } from "@jj/contracts";
import {
  type BotRow,
  type ClaimedJob,
  heartbeat,
  type Lease,
  type RunReason,
  type RunRow,
  type SessionRow,
  sessionEntries,
  sessionInbox,
  sessions,
  type TaskRow,
  type Tx,
  usage,
} from "@jj/db";
import { and, asc, eq, inArray, isNull, max } from "drizzle-orm";
import type { EngineContext } from "../context";
import { emit } from "../events";
import type { ActivityTrace } from "../observability/tracing";
import type { ExecutorEvent, PiMessage, RunHooks } from "../ports";
import type { Redactor } from "../redact";
import { noteResolved } from "../services/approvals";
import { storeArtifact } from "../services/artifacts";
import { lockTask, updateSession } from "../services/sessions";
import {
  noteCapped,
  noteThreshold,
  type SpendStop,
  spendStop,
} from "../services/spend";
import { reviewTurn } from "./parking";
import { COMPLETION_SET_ASIDE } from "./prompts";
import { isContinuing } from "./runs";
import type { TaskSandboxes } from "./sandboxes";

/** Why the worker stopped a job: the user stopped it, the worker is stopping, the lease was lost, or a simulated crash. */
export type AbortReason = "cancel" | "shutdown" | "lease-lost" | "crash";

export class JobControl {
  readonly controller = new AbortController();
  reason?: AbortReason;

  abort(reason: AbortReason) {
    // A crash or a lost lease overrides a softer reason: nothing may be written.
    if (this.reason && reason !== "crash" && reason !== "lease-lost") return;
    this.reason = reason;
    if (!this.controller.signal.aborted)
      this.controller.abort(new Error(`run stopped: ${reason}`));
  }

  /** True when the job must not write anything more. */
  get fenced(): boolean {
    return this.reason === "crash" || this.reason === "lease-lost";
  }
}

/**
 * What a job's run or reply ended as, for its span, metric and log line: how
 * the worker stopped it, else its own outcome. A bounded set of names.
 */
export function outcomeLabel(
  reason: AbortReason | undefined,
  outcome: string,
): string {
  switch (reason) {
    case "cancel":
      return "cancelled";
    case "shutdown":
      return "handed_back";
    case "lease-lost":
      return "lease_lost";
    case "crash":
      return "crashed";
    default:
      return outcome;
  }
}

/** The lease is gone (reclaimed or finished elsewhere); the run stops without writing. */
export class LeaseLostError extends Error {
  constructor() {
    super("The job lease was lost; the run stops without writing results.");
    this.name = "LeaseLostError";
  }
}

export interface WorkerDeps {
  ctx: EngineContext;
  sandboxes: TaskSandboxes;
}

/** Runs `fn` in a transaction that first re-checks (and row-locks) the job lease. */
export async function fencedWrite<T>(
  ctx: EngineContext,
  lease: Lease,
  control: JobControl,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (control.fenced) throw new LeaseLostError();
  return ctx.db.transaction(async (tx) => {
    if (!(await heartbeat(tx, lease, ctx.config.leaseMs))) {
      control.abort("lease-lost");
      throw new LeaseLostError();
    }
    return fn(tx);
  });
}

export interface RunContext {
  deps: WorkerDeps;
  job: ClaimedJob;
  control: JobControl;
  task: TaskRow;
  session: SessionRow;
  bot: BotRow;
  run: RunRow;
  reason: RunReason;
  /** The session's status before this run started. */
  previous: Pick<SessionRow, "status" | "waitingFor">;
  /** Inbox items handed to the executor and not yet persisted with the transcript. */
  claimed: Set<string>;
  nextSeq: number;
  startedAt: Date;
  /** Set when the run's write-back finished the task, so its sandbox can go. */
  taskFinished: boolean;
  /** Replaces the server's secrets in what this run persists (see redact.ts). */
  redact: Redactor;
  /** Verification gate runs in this run (gate.ts); capped by `maxVerificationAttempts`. */
  verificationAttempts: number;
  /** The cap that refused this run's model call, once one did. */
  spendStop?: SpendStop;
  /**
   * The run's polling turns since it last did work or its inbox last
   * delivered a brief, result or steering (parking.ts).
   */
  lookupTurns: number;
  /** The approval rules of the bot's own profile. */
  approvalRules?: readonly ApprovalRule[];
  /** The approval this run recorded for a call it held, once it did. */
  heldApprovalId?: string;
  /** The held call whose decision this run applies, while its result is not stored. */
  decisionCallId?: string;
  /**
   * The task's goal version as this run's model last read it: when its
   * prompt was built for an executor call, or when steering that carries a
   * goal change reached a coordinator. A call made at an older version than
   * the task's is never held.
   */
  goalVersionSeen?: number;
  /** The run's span, with its model turns and tool calls (session-run.ts). */
  activity?: ActivityTrace;
}

export const writeRun = <T>(rc: RunContext, fn: (tx: Tx) => Promise<T>) =>
  fencedWrite(rc.deps.ctx, rc.job.lease, rc.control, fn);

export const attributionOf = (rc: RunContext) => ({
  botId: rc.bot.id,
  sessionId: rc.session.id,
  runId: rc.run.id,
});

export async function nextEntrySeq(tx: Tx, sessionId: string) {
  const [row] = await tx
    .select({ value: max(sessionEntries.seq) })
    .from(sessionEntries)
    .where(eq(sessionEntries.sessionId, sessionId));
  return (row?.value ?? 0) + 1;
}

export async function loadTranscript(
  ctx: EngineContext,
  sessionId: string,
): Promise<PiMessage[]> {
  const rows = await ctx.db
    .select({ entry: sessionEntries.entry })
    .from(sessionEntries)
    .where(eq(sessionEntries.sessionId, sessionId))
    .orderBy(asc(sessionEntries.seq));
  return rows.map((row) => row.entry);
}

/** Marks inbox items delivered: they are now in the persisted transcript. */
async function markDelivered(tx: Tx, rc: RunContext) {
  if (rc.claimed.size === 0) return;
  await tx
    .update(sessionInbox)
    .set({ deliveredAt: rc.deps.ctx.clock() })
    .where(inArray(sessionInbox.id, [...rc.claimed]));
  rc.claimed.clear();
}

/**
 * Takes undelivered inbox items (oldest first) for the executor. They stay
 * undelivered until the executor persists them, so a crash before that
 * re-delivers them on recovery. `kinds` limits which items are taken;
 * `continuingOnly` takes nothing unless one of them continues a run (a brief,
 * result or steering), and then takes messages with it. A coordinator that
 * receives items catches up with the task's goal version, and any completion
 * it recorded earlier is dropped.
 */
export async function takeInbox(
  rc: RunContext,
  kinds?: readonly ("brief" | "result" | "steering" | "message")[],
  continuingOnly = false,
): Promise<string[]> {
  return writeRun(rc, async (tx) => {
    const task = await lockTask(tx, rc.task.id);
    if (task) rc.task = task;
    const items = await tx
      .select()
      .from(sessionInbox)
      .where(
        and(
          eq(sessionInbox.sessionId, rc.session.id),
          isNull(sessionInbox.deliveredAt),
          ...(kinds ? [inArray(sessionInbox.kind, [...kinds])] : []),
        ),
      )
      .orderBy(asc(sessionInbox.createdAt), asc(sessionInbox.id));
    const fresh = items.filter((item) => !rc.claimed.has(item.id));
    const continues = fresh.some((item) => isContinuing(item.kind));
    if (fresh.length === 0 || (continuingOnly && !continues)) return [];
    for (const item of fresh) rc.claimed.add(item.id);
    // Input that wakes a session is something to react to: looking things up
    // starts over. A message wakes no one, so it does not.
    if (continues) rc.lookupTurns = 0;
    // New input voids a completion recorded before it: the coordinator must
    // see the input first (a hand-off or crash can land between the two), and
    // is told so, or it would take its completion as done.
    const setAside = Boolean(rc.session.completionRequested);
    if (setAside) {
      await tx
        .update(sessions)
        .set({ completionRequested: null })
        .where(eq(sessions.id, rc.session.id));
      rc.session = { ...rc.session, completionRequested: null };
    }
    if (
      rc.session.parentSessionId === null &&
      rc.task.goalVersion > rc.session.goalVersion
    ) {
      rc.session = await updateSession(
        tx,
        rc.deps.ctx,
        rc.session,
        { goalVersion: rc.task.goalVersion },
        attributionOf(rc),
      );
      // The steering it is handed carries the goal change.
      rc.goalVersionSeen = rc.task.goalVersion;
    }
    const texts = fresh.map((item) => item.text);
    return setAside ? [COMPLETION_SET_ASIDE, ...texts] : texts;
  });
}

const clip = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

/** At most `bytes` UTF-8 bytes, cut on a character boundary. */
export function truncateUtf8(text: string, bytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= bytes) return text;
  let end = bytes;
  // Back up over continuation bytes (10xxxxxx) to a character start.
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

const labelName = (label: string) =>
  `${
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "output"
  }.txt`;

/** Stores text (already redacted) as an `output` artifact of the run; returns its id. */
export async function spill(
  tx: Tx,
  rc: RunContext,
  text: string,
  label: string,
) {
  const path = clip(label.trim() || "tool output", 200);
  const artifact = await storeArtifact(
    tx,
    rc.deps.ctx,
    {
      taskId: rc.task.id,
      kind: "output",
      path,
      name: labelName(path),
      content: Buffer.from(text, "utf8"),
      contentType: "text/plain; charset=utf-8",
    },
    attributionOf(rc),
  );
  return artifact.id;
}

async function recordEvent(tx: Tx, rc: RunContext, event: ExecutorEvent) {
  const attribution = attributionOf(rc);
  const { ctx } = rc.deps;
  switch (event.type) {
    case "model.started":
      await emit(tx, rc.task.id, {
        type: "model.started",
        payload: {},
        ...attribution,
      });
      return;
    case "model.finished": {
      if (event.warning)
        ctx.logger.warn(event.warning, {
          taskId: rc.task.id,
          sessionId: rc.session.id,
          runId: rc.run.id,
          model: event.model,
        });
      await tx.insert(usage).values({
        id: ctx.ids("usage"),
        taskId: rc.task.id,
        sessionId: rc.session.id,
        runId: rc.run.id,
        botId: rc.bot.id,
        model: event.model,
        inputTokens: event.usage.inputTokens,
        outputTokens: event.usage.outputTokens,
        cacheReadTokens: event.usage.cacheReadTokens,
        cacheWriteTokens: event.usage.cacheWriteTokens,
        costUsd: event.usage.costUsd,
        priced: event.usage.unpricedCalls === 0,
        createdAt: ctx.clock(),
      });
      await emit(tx, rc.task.id, {
        type: "model.finished",
        payload: {
          model: event.model,
          stopReason: event.stopReason,
          usage: { ...event.usage, modelCalls: 1 },
          ...(event.text ? { text: clip(event.text, 2000) } : {}),
        },
        ...attribution,
      });
      return;
    }
    case "tool.started":
      await emit(tx, rc.task.id, {
        type: "tool.started",
        payload: {
          toolCallId: clip(event.toolCallId, 128),
          tool: event.tool || "tool",
          summary: clip(event.summary, 300),
        },
        ...attribution,
      });
      return;
    case "tool.finished": {
      // The cap holds whatever the runtime did: oversized output is spilled here.
      let { output, artifactId, truncated } = event;
      const cap = ctx.config.outputCapBytes;
      if (output !== undefined && Buffer.byteLength(output, "utf8") > cap) {
        artifactId ??= await spill(
          tx,
          rc,
          output,
          event.summary.trim()
            ? `${event.tool} output: ${event.summary}`
            : `${event.tool} output`,
        );
        output = truncateUtf8(output, cap);
        truncated = true;
      }
      await emit(tx, rc.task.id, {
        type: "tool.finished",
        payload: {
          toolCallId: clip(event.toolCallId, 128),
          tool: event.tool || "tool",
          summary: clip(event.summary, 300),
          ok: event.ok,
          ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
          ...(event.interrupted ? { interrupted: event.interrupted } : {}),
          ...(output !== undefined ? { output } : {}),
          truncated,
          ...(artifactId ? { artifactId } : {}),
        },
        ...attribution,
      });
    }
  }
}

/**
 * Before a model call: refuses it at a spend cap (recording `spend.capped`),
 * and records `spend.threshold` when the task's spend passed the soft one.
 */
async function admitModelCall(rc: RunContext): Promise<string | undefined> {
  return writeRun(rc, async (tx) => {
    const attribution = attributionOf(rc);
    const stop = await spendStop(tx, rc.deps.ctx, {
      taskId: rc.task.id,
      botId: rc.bot.id,
    });
    if (!stop) {
      await noteThreshold(tx, rc.task.id, attribution);
      return undefined;
    }
    rc.spendStop = stop;
    await noteCapped(tx, rc.task.id, stop, attribution);
    return stop.message;
  });
}

/**
 * The run's spans, metrics and debug lines for an executor event: ids, names,
 * counts and cost, never its text. Recorded whether or not the event is then
 * stored, since the model call or command happened either way.
 */
export function observeEvent(rc: RunContext, event: ExecutorEvent) {
  const { ctx } = rc.deps;
  rc.activity?.observe(event);
  if (event.type === "model.finished") {
    ctx.metrics.modelCall(event.model, event.usage);
    ctx.logger.debug?.("Model call finished", {
      model: event.model,
      stopReason: event.stopReason,
      inputTokens: event.usage.inputTokens,
      outputTokens: event.usage.outputTokens,
      costUsd: event.usage.costUsd,
    });
  } else if (event.type === "tool.finished")
    ctx.logger.debug?.("Tool call finished", {
      tool: rc.activity?.toolLabel(event.tool) ?? "other",
      ok: event.ok,
      ...(typeof event.exitCode === "number"
        ? { exitCode: event.exitCode }
        : {}),
    });
}

/** The executor's hooks. What they persist is redacted first (see redact.ts). */
export function runHooks(rc: RunContext): RunHooks {
  const { redact } = rc;
  return {
    onEvent: (event) => {
      observeEvent(rc, event);
      return writeRun(rc, (tx) => recordEvent(tx, rc, redact(event)));
    },
    onTurnComplete: async (raw) => {
      if (raw.length === 0) return;
      const entries = redact(raw);
      await writeRun(rc, async (tx) => {
        await tx.insert(sessionEntries).values(
          entries.map((entry, index) => ({
            sessionId: rc.session.id,
            seq: rc.nextSeq + index,
            runId: rc.run.id,
            entry: entry as Record<string, unknown>,
            createdAt: rc.deps.ctx.clock(),
          })),
        );
        rc.nextSeq += entries.length;
        await markDelivered(tx, rc);
        // The decision's result is in the transcript now: it is applied once.
        if (rc.decisionCallId)
          await noteResolved(
            tx,
            rc.deps.ctx,
            rc.session.id,
            rc.decisionCallId,
            entries,
            rc.run.id,
          );
      });
    },
    // Once the model ended its turn, a message alone never gives it another:
    // it is taken only with input that continues the run anyway, and
    // otherwise waits for the session's next run (or, if the session
    // finishes first, goes to its parent with its result: outcomes.ts).
    drainInbox: (turnEnded) => takeInbox(rc, undefined, turnEnded),
    spillOutput: (text, label) =>
      writeRun(rc, (tx) => spill(tx, rc, redact(text), redact(label))),
    admitModelCall: () => admitModelCall(rc),
    reviewTurn: (calls) => reviewTurn(rc, calls),
  };
}
