// Spend approvals. When a cap's option asks for it (`approveSpendPastThreshold`:
// the task's for its own cap, the bot's own profile's for its daily cap), a
// model call past SPEND_SOFT_THRESHOLD of the cap waits for the user's
// go-ahead. The guard runs after the hard caps (spend.ts), in the same fenced
// write: it finds or records the one pending approval of the cap value, and
// the run ends `held` before the call. Every session it covers is held the
// same way, at its next model call or its launch. The answer wakes them: an
// approval lets them run on up to the cap, a denial stops them as the cap
// would, at the threshold. The records share the approvals table, events and
// route with tool approvals (approvals.ts).
import {
  formatUsd,
  SPEND_SOFT_THRESHOLD,
  type SpendApproval,
  type SpendApprovalScope,
} from "@jj/contracts";
import {
  type ApprovalRow,
  approvals,
  type Executor,
  enqueue,
  type SessionRow,
  type SpendApprovalColumn,
  sessions,
  type TaskRow,
  type Tx,
  tasks as tasksTable,
} from "@jj/db";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { EngineContext } from "../context";
import { type Attribution, emit, wakeWorkers } from "../events";
import { pendingApproval, updateApproval } from "./approvals";
import {
  botCapUsd,
  botSpentUsd,
  DAY_MS,
  type SpendStop,
  taskSpentUsd,
} from "./spend";
import { recordTaskUpdate } from "./task-updates";

const isoOrNull = (date: Date | null) => (date ? date.toISOString() : null);
const isSpend = eq(approvals.kind, "spend");

/** A spend approval's cap and amounts (`approvals.spend`). */
const spendOf = (row: ApprovalRow): SpendApprovalColumn => {
  if (!row.spend)
    throw new Error(`Approval ${row.id} is not a spend approval.`);
  return row.spend;
};

export function toSpendApproval(row: ApprovalRow): SpendApproval {
  const spend = spendOf(row);
  return {
    kind: "spend",
    id: row.id,
    taskId: row.taskId,
    sessionId: row.sessionId,
    runId: row.runId,
    botId: row.botId,
    scope: spend.scope,
    spentUsd: spend.spentUsd,
    capUsd: spend.capUsd,
    thresholdUsd: spend.thresholdUsd,
    status: row.status,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
    decidedAt: isoOrNull(row.decidedAt),
  };
}

/** The cap value a spend approval is about, and the spend that crossed its threshold. */
interface Crossing {
  scope: SpendApprovalScope;
  capUsd: number;
  spentUsd: number;
  /** The bot whose cap it is (bot scope). */
  botId?: string;
  botName: string;
}

const sameCap = (row: ApprovalRow, crossing: Crossing) => {
  const spend = spendOf(row);
  return (
    spend.scope === crossing.scope &&
    spend.capUsd === crossing.capUsd &&
    (crossing.scope !== "bot" || row.botId === crossing.botId)
  );
};

/** "the task's $5.00 cap", "Ada's $20.00 daily cap". */
const capName = (crossing: Pick<Crossing, "scope" | "capUsd" | "botName">) =>
  crossing.scope === "task"
    ? `the task's ${formatUsd(crossing.capUsd)} cap`
    : `${crossing.botName}'s ${formatUsd(crossing.capUsd)} daily cap`;

const percent = `${Math.round(SPEND_SOFT_THRESHOLD * 100)}%`;

/**
 * A denial, as a cap at the threshold: what the stopped sessions report, and
 * what lets the task go on.
 */
function deniedStop(crossing: Crossing): SpendStop {
  return {
    scope: crossing.scope,
    spentUsd: crossing.spentUsd,
    capUsd: crossing.capUsd,
    ...(crossing.botId ? { botId: crossing.botId } : {}),
    message: `spend past ${percent} of ${capName(crossing)} was not approved.`,
    advice:
      "A message that continues the task asks again; raise the cap, or stop asking past the threshold, to go on without the question.",
  };
}

/** What the coordinator's chat is told about a request. */
function updateText(crossing: Crossing, sessionBot: string): string {
  const spent = formatUsd(crossing.spentUsd);
  const cap = formatUsd(crossing.capUsd);
  return crossing.scope === "task"
    ? `The task spent ${spent} of its ${cap} cap, past the ${percent} threshold (${sessionBot} was about to make a model call). No model call starts until the user approves spending up to the cap.`
    : `${crossing.botName} spent ${spent} of its ${cap} daily cap in the last 24 hours, past the ${percent} threshold. None of its model calls in this task starts until the user approves spending up to the cap.`;
}

/** What the next model call of a session does about spend approvals. */
export type SpendVerdict =
  | { kind: "go" }
  /** It waits for this pending approval: the run ends `held` without making it. */
  | { kind: "hold"; approval: ApprovalRow; text: string }
  /** The user denied going past the threshold: it is refused as at a cap. */
  | { kind: "denied"; stop: SpendStop };

/**
 * The caps past their threshold whose option asks first, for a model call of
 * `session` in `task` (locked): the task's own, then its bot's.
 */
async function crossings(
  tx: Tx,
  ctx: EngineContext,
  task: TaskRow,
  session: Pick<SessionRow, "botId">,
): Promise<Crossing[]> {
  const found: Crossing[] = [];
  const bot = await botCapUsd(tx, session.botId);
  if (task.approveSpendPastThreshold && task.spendCapUsd !== null) {
    const spentUsd = await taskSpentUsd(tx, task.id);
    if (spentUsd >= task.spendCapUsd * SPEND_SOFT_THRESHOLD)
      found.push({
        scope: "task",
        capUsd: task.spendCapUsd,
        spentUsd,
        botName: bot.name,
      });
  }
  if (bot.approveSpendPastThreshold && bot.capUsd !== null) {
    const spentUsd = await botSpentUsd(tx, session.botId, ctx.clock());
    if (spentUsd >= bot.capUsd * SPEND_SOFT_THRESHOLD)
      found.push({
        scope: "bot",
        capUsd: bot.capUsd,
        spentUsd,
        botId: session.botId,
        botName: bot.name,
      });
  }
  return found;
}

/**
 * Whether a model call of `session` may start as far as spend approvals go,
 * asked after the hard caps let it. For each cap past its threshold whose
 * option is on, most specific first: an approval covers it (approved, on
 * bot scope within 24 hours of the answer), a pending one holds the call, a
 * denial in this stretch of the task's work refuses it, and with none the
 * call records the cap's pending approval and is held. Locks the task.
 */
export async function spendApprovalVerdict(
  tx: Tx,
  ctx: EngineContext,
  input: {
    taskId: string;
    session: Pick<SessionRow, "id" | "botId">;
    runId: string;
    attribution: Attribution;
  },
): Promise<SpendVerdict> {
  const [task] = await tx
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.id, input.taskId))
    .for("update");
  if (!task) return { kind: "go" };
  const found = await crossings(tx, ctx, task, input.session);
  if (found.length === 0) return { kind: "go" };
  const rows = await tx
    .select()
    .from(approvals)
    .where(and(isSpend, eq(approvals.taskId, task.id)))
    .orderBy(asc(approvals.createdAt), asc(approvals.id));
  const now = ctx.clock().getTime();
  for (const crossing of found) {
    const own = rows.filter((row) => sameCap(row, crossing));
    const pending = own.find((row) => row.status === "pending");
    if (pending)
      return { kind: "hold", approval: pending, text: holdText(crossing) };
    const covered = own.some(
      (row) =>
        row.status === "approved" &&
        (crossing.scope === "task" ||
          (row.decidedAt !== null && now - row.decidedAt.getTime() < DAY_MS)),
    );
    if (covered) continue;
    // A denial (or the stop that cancelled it) covers this stretch only.
    const refused = own.some(
      (row) =>
        (row.status === "denied" || row.status === "cancelled") &&
        row.resolvedAt === null,
    );
    if (refused) return { kind: "denied", stop: deniedStop(crossing) };
    const approval = await requestSpendApproval(tx, ctx, task, crossing, input);
    return { kind: "hold", approval, text: holdText(crossing) };
  }
  return { kind: "go" };
}

const holdText = (crossing: Crossing) =>
  `Waiting for the user's approval to spend past ${percent} of ${capName(crossing)}.`;

/** Records the cap value's pending approval, emits it, and tells the coordinator's chat. */
async function requestSpendApproval(
  tx: Tx,
  ctx: EngineContext,
  task: TaskRow,
  crossing: Crossing,
  input: { session: Pick<SessionRow, "id" | "botId">; runId: string },
): Promise<ApprovalRow> {
  const spend: SpendApprovalColumn = {
    scope: crossing.scope,
    spentUsd: crossing.spentUsd,
    capUsd: crossing.capUsd,
    // Shown, not compared: rounded so 80% of $0.05 reads 0.04, not 0.04000000000000001.
    thresholdUsd: Number((crossing.capUsd * SPEND_SOFT_THRESHOLD).toFixed(9)),
  };
  const [row] = await tx
    .insert(approvals)
    .values({
      id: ctx.ids("approval"),
      kind: "spend",
      taskId: task.id,
      sessionId: input.session.id,
      runId: input.runId,
      botId: crossing.botId ?? input.session.botId,
      spend,
      createdAt: ctx.clock(),
    })
    .returning();
  if (!row) throw new Error("The approval insert returned no row.");
  await emit(tx, ctx, task.id, {
    type: "approval.requested",
    payload: { approval: toSpendApproval(row) },
    botId: input.session.botId,
    sessionId: row.sessionId,
    runId: row.runId,
  });
  await recordTaskUpdate(
    tx,
    ctx,
    task,
    "approval",
    updateText(crossing, crossing.botName),
    { approvalId: row.id },
  );
  return row;
}

/** True when a pending spend approval covers the sessions of this bot. */
const covers = (row: ApprovalRow, session: Pick<SessionRow, "botId">) =>
  spendOf(row).scope === "task" || row.botId === session.botId;

/**
 * The pending approval that holds the session: its own held call, else a
 * pending spend approval of its task that covers it (the task's cap, or its
 * bot's). A session it holds starts no run until the user answers.
 */
export async function holdingApproval(
  exec: Executor,
  session: Pick<SessionRow, "id" | "taskId" | "botId">,
): Promise<ApprovalRow | undefined> {
  const own = await pendingApproval(exec, session.id);
  if (own) return own;
  const rows = await exec
    .select()
    .from(approvals)
    .where(
      and(
        isSpend,
        eq(approvals.taskId, session.taskId),
        eq(approvals.status, "pending"),
      ),
    )
    .orderBy(asc(approvals.createdAt), asc(approvals.id));
  return rows.find((row) => covers(row, session));
}

/**
 * Wakes every session of the task that waits for approval without a call of
 * its own waiting: the sessions spend approvals hold. Each checks again at
 * its launch, and one still held waits on.
 */
export async function wakeSpendHeld(tx: Tx, taskId: string): Promise<void> {
  const held = await tx
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.taskId, taskId),
        eq(sessions.status, "waiting"),
        eq(sessions.waitingFor, "approval"),
      ),
    )
    .orderBy(asc(sessions.createdAt), asc(sessions.id));
  let woke = false;
  for (const session of held) {
    if (await pendingApproval(tx, session.id)) continue;
    await enqueue(tx, { kind: "session.run", taskId, sessionId: session.id });
    woke = true;
  }
  if (woke) await wakeWorkers(tx, taskId);
}

/**
 * Expires the pending spend approvals (of one task, or all) whose cap value
 * no longer applies, or whose option was turned off, and wakes the sessions
 * they held to check again. Call it after a task's cap or option changes
 * (with the task locked) or a runtime profile's.
 */
export async function recheckSpendApprovals(
  tx: Tx,
  ctx: EngineContext,
  filter: { taskId?: string } = {},
): Promise<void> {
  const rows = await tx
    .select()
    .from(approvals)
    .where(
      and(
        isSpend,
        eq(approvals.status, "pending"),
        ...(filter.taskId ? [eq(approvals.taskId, filter.taskId)] : []),
      ),
    )
    // Tasks in id order, as transactions that lock several take them.
    .orderBy(asc(approvals.taskId), asc(approvals.createdAt));
  const woken = new Set<string>();
  for (const row of rows) {
    const spend = spendOf(row);
    let reason: string | undefined;
    if (spend.scope === "task") {
      const [task] = await tx
        .select()
        .from(tasksTable)
        .where(eq(tasksTable.id, row.taskId))
        .for("update");
      if (!task) continue;
      if (task.spendCapUsd === null)
        reason = "the task's spend cap was removed before the user answered.";
      else if (task.spendCapUsd !== spend.capUsd)
        reason = `the task's spend cap changed to ${formatUsd(task.spendCapUsd)} before the user answered.`;
      else if (!task.approveSpendPastThreshold)
        reason = `asking before spending past ${percent} of the cap was turned off before the user answered.`;
    } else {
      const bot = await botCapUsd(tx, row.botId);
      if (bot.capUsd === null)
        reason = `${bot.name}'s daily spend cap was removed before the user answered.`;
      else if (bot.capUsd !== spend.capUsd)
        reason = `${bot.name}'s daily spend cap changed to ${formatUsd(bot.capUsd)} before the user answered.`;
      else if (!bot.approveSpendPastThreshold)
        reason = `asking before spending past ${percent} of ${bot.name}'s cap was turned off before the user answered.`;
    }
    if (!reason) continue;
    await updateApproval(tx, ctx, row, {
      status: "expired",
      reason,
      decidedAt: ctx.clock(),
    });
    woken.add(row.taskId);
  }
  for (const taskId of woken) await wakeSpendHeld(tx, taskId);
}

/**
 * The task finished (completed, failed or stopped): its pending spend
 * approvals are cancelled, since nothing is left for them to hold.
 */
export async function cancelSpendApprovals(
  tx: Tx,
  ctx: EngineContext,
  task: Pick<TaskRow, "id" | "status">,
  attribution: Attribution = {},
): Promise<void> {
  const rows = await tx
    .select()
    .from(approvals)
    .where(
      and(
        isSpend,
        eq(approvals.taskId, task.id),
        eq(approvals.status, "pending"),
      ),
    );
  const reason =
    task.status === "cancelled"
      ? "the task was stopped before the user answered."
      : "the task finished before the user answered.";
  for (const row of rows)
    await updateApproval(
      tx,
      ctx,
      row,
      { status: "cancelled", reason, decidedAt: ctx.clock() },
      { botId: row.botId, sessionId: row.sessionId, ...attribution },
    );
}

/**
 * A user message continued the task (`task.reopened`): a new stretch of
 * work starts, so the denials (and stops) of the last one no longer cover
 * their cap values, and the next call past a threshold asks again.
 */
export async function endSpendStretch(
  tx: Tx,
  ctx: EngineContext,
  taskId: string,
): Promise<void> {
  await tx
    .update(approvals)
    .set({ resolvedAt: ctx.clock() })
    .where(
      and(
        isSpend,
        eq(approvals.taskId, taskId),
        inArray(approvals.status, ["denied", "cancelled"]),
        isNull(approvals.resolvedAt),
      ),
    );
}
