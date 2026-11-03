// Spend caps. One guard decides whether a model call may start: the task's
// own cap, the bot's rolling 24 hours (its profile's `maxUsdPerBotPerDay`)
// and the instance's rolling 24 hours (`JJ_MAX_USD_PER_DAY`), all against
// the priced spend already recorded in `usage`. Calls on models with no listed
// price record no cost, so no cap can bound them; they are counted apart.
import {
  formatSpendAgainstCap,
  profileBudgetsSchema,
  SPEND_SOFT_THRESHOLD,
  type SpendCapReachedDetails,
  type SpendScope,
} from "@jj/contracts";
import { bots, type Executor, type Tx, taskEvents, tasks, usage } from "@jj/db";
import { and, desc, eq, gt, inArray, type SQL, sql } from "drizzle-orm";
import type { EngineContext } from "../context";
import { DomainError } from "../errors";
import { type Attribution, emit } from "../events";
import { profileSettings } from "../records";
import { profileFor } from "./profiles";

export const DAY_MS = 24 * 60 * 60_000;

/** A cap the next model call would exceed. */
export interface SpendStop extends SpendCapReachedDetails {
  /** What was reached, for the model, the task log and the API. */
  message: string;
  /** What lets the work go on. */
  advice: string;
}

async function spent(exec: Executor, where: SQL | undefined): Promise<number> {
  const [row] = await exec
    .select({
      value: sql<number>`coalesce(sum(${usage.costUsd}), 0)`.mapWith(Number),
    })
    .from(usage)
    .where(where);
  return row?.value ?? 0;
}

/** The task's priced spend so far, compaction and every session included. */
export const taskSpentUsd = (exec: Executor, taskId: string) =>
  spent(exec, eq(usage.taskId, taskId));

/** A bot's priced spend in the 24 hours before `now`, task sessions and chat. */
export const botSpentUsd = (exec: Executor, botId: string, now: Date) =>
  spent(
    exec,
    and(
      eq(usage.botId, botId),
      gt(usage.createdAt, new Date(now.getTime() - DAY_MS)),
    ),
  );

/** Everything's priced spend in the 24 hours before `now`. */
export const instanceSpentUsd = (exec: Executor, now: Date) =>
  spent(exec, gt(usage.createdAt, new Date(now.getTime() - DAY_MS)));

/** A bot's cap over any 24 hours, from its profile (else the default profile). */
export async function botCapUsd(
  exec: Executor,
  botId: string,
): Promise<{ name: string; capUsd: number | null }> {
  const [bot] = await exec
    .select({ name: bots.name, profileId: bots.runtimeProfileId })
    .from(bots)
    .where(eq(bots.id, botId));
  const profile = await profileFor(exec, bot?.profileId ?? null);
  const budgets = profile
    ? profileSettings(profile).budgets
    : profileBudgetsSchema.parse({});
  return { name: bot?.name ?? "The bot", capUsd: budgets.maxUsdPerBotPerDay };
}

/** The task cap a new task of this coordinator gets: its profile's `maxUsdPerTask`. */
export async function taskCapFor(
  exec: Executor,
  coordinatorBotId: string,
): Promise<number | null> {
  const [bot] = await exec
    .select({ profileId: bots.runtimeProfileId })
    .from(bots)
    .where(eq(bots.id, coordinatorBotId));
  const profile = await profileFor(exec, bot?.profileId ?? null);
  return (
    profile ? profileSettings(profile).budgets : profileBudgetsSchema.parse({})
  ).maxUsdPerTask;
}

const reached = (spentUsd: number, capUsd: number | null): capUsd is number =>
  capUsd !== null && spentUsd >= capUsd;

/**
 * The first cap a model call of `botId` (in `taskId`, when it is a task's)
 * would exceed, most specific first: the task's, the bot's, the instance's.
 * Undefined while every cap has room. A call already in flight is not
 * counted until it finishes, so each running session can overshoot by one.
 */
export async function spendStop(
  exec: Executor,
  ctx: EngineContext,
  scope: { taskId?: string; botId: string },
): Promise<SpendStop | undefined> {
  const now = ctx.clock();
  if (scope.taskId) {
    const [task] = await exec
      .select({ capUsd: tasks.spendCapUsd })
      .from(tasks)
      .where(eq(tasks.id, scope.taskId));
    const capUsd = task?.capUsd ?? null;
    if (capUsd !== null) {
      const spentUsd = await taskSpentUsd(exec, scope.taskId);
      if (reached(spentUsd, capUsd)) return describe("task", spentUsd, capUsd);
    }
  }
  const bot = await botCapUsd(exec, scope.botId);
  if (bot.capUsd !== null) {
    const spentUsd = await botSpentUsd(exec, scope.botId, now);
    if (reached(spentUsd, bot.capUsd))
      return describe("bot", spentUsd, bot.capUsd, scope.botId, bot.name);
  }
  const instanceCap = ctx.config.maxUsdPerDay;
  if (instanceCap !== null) {
    const spentUsd = await instanceSpentUsd(exec, now);
    if (reached(spentUsd, instanceCap))
      return describe("instance", spentUsd, instanceCap);
  }
  return undefined;
}

function describe(
  scope: SpendScope,
  spentUsd: number,
  capUsd: number,
  botId?: string,
  botName = "The bot",
): SpendStop {
  const shown = formatSpendAgainstCap(spentUsd, capUsd);
  const amounts = `${shown.spent} of ${shown.cap}`;
  switch (scope) {
    case "task":
      return {
        scope,
        spentUsd,
        capUsd,
        message: `The task reached its spend cap: ${amounts} spent.`,
        advice: "Raise the task's spend cap to continue.",
      };
    case "bot":
      return {
        scope,
        spentUsd,
        capUsd,
        ...(botId ? { botId } : {}),
        message: `${botName} reached its daily spend cap: ${amounts} in the last 24 hours.`,
        advice: `Raise the cap in ${botName}'s runtime profile, or continue once its spend in the last 24 hours is below the cap.`,
      };
    case "instance":
      return {
        scope,
        spentUsd,
        capUsd,
        message: `This server reached its daily spend cap: ${amounts} in the last 24 hours.`,
        advice:
          "Raise JJ_MAX_USD_PER_DAY on the server, or continue once the spend in the last 24 hours is below the cap.",
      };
  }
}

/** 409 SPEND_CAP_REACHED when a model call of `botId` (in `taskId`) could not start now. */
export async function assertWithinCaps(
  exec: Executor,
  ctx: EngineContext,
  scope: { taskId?: string; botId: string },
): Promise<void> {
  const stop = await spendStop(exec, ctx, scope);
  if (!stop) return;
  const { message, advice, ...details } = stop;
  throw new DomainError("SPEND_CAP_REACHED", `${message} ${advice}`, details);
}

/**
 * Records `spend.capped` for a refused call, once per cap (scope, cap value
 * and, for a bot's cap, the bot) in each stretch of the task's work, which a
 * user message that continues it (`task.reopened`) starts afresh. The other
 * sessions the same cap stops add nothing new. Locks the task.
 */
export async function noteCapped(
  tx: Tx,
  taskId: string,
  stop: SpendStop,
  attribution: Attribution,
): Promise<void> {
  await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .for("update");
  const marks = await tx
    .select({
      type: taskEvents.type,
      botId: taskEvents.botId,
      payload: taskEvents.payload,
    })
    .from(taskEvents)
    .where(
      and(
        eq(taskEvents.taskId, taskId),
        inArray(taskEvents.type, ["spend.capped", "task.reopened"]),
      ),
    )
    .orderBy(desc(taskEvents.sequence));
  for (const mark of marks) {
    if (mark.type === "task.reopened") break;
    const payload = mark.payload as { scope?: unknown; capUsd?: unknown };
    if (
      payload.scope === stop.scope &&
      payload.capUsd === stop.capUsd &&
      (stop.scope !== "bot" || mark.botId === attribution.botId)
    )
      return;
  }
  await emit(tx, taskId, {
    type: "spend.capped",
    payload: {
      scope: stop.scope,
      spentUsd: stop.spentUsd,
      capUsd: stop.capUsd,
    },
    ...attribution,
  });
}

/**
 * Records `spend.threshold` once per cap value when the task's spend is past
 * SPEND_SOFT_THRESHOLD of its cap (and short of it). Only then is the task
 * locked, so concurrent sessions record it once.
 */
export async function noteThreshold(
  tx: Tx,
  taskId: string,
  attribution: Attribution,
): Promise<void> {
  const within = async (lock: boolean) => {
    const query = tx
      .select({ capUsd: tasks.spendCapUsd })
      .from(tasks)
      .where(eq(tasks.id, taskId));
    const [task] = lock ? await query.for("update") : await query;
    const capUsd = task?.capUsd ?? null;
    if (capUsd === null) return undefined;
    const spentUsd = await taskSpentUsd(tx, taskId);
    return spentUsd >= capUsd * SPEND_SOFT_THRESHOLD && spentUsd < capUsd
      ? { spentUsd, capUsd }
      : undefined;
  };
  if (!(await within(false))) return;
  const crossed = await within(true);
  if (!crossed) return;
  const [latest] = await tx
    .select({ payload: taskEvents.payload })
    .from(taskEvents)
    .where(
      and(
        eq(taskEvents.taskId, taskId),
        eq(taskEvents.type, "spend.threshold"),
      ),
    )
    .orderBy(desc(taskEvents.sequence))
    .limit(1);
  if (
    (latest?.payload as { capUsd?: unknown } | undefined)?.capUsd ===
    crossed.capUsd
  )
    return;
  await emit(tx, taskId, {
    type: "spend.threshold",
    payload: crossed,
    ...attribution,
  });
}
