// `GET /api/usage`: recorded model usage over rolling windows, for the whole
// instance, per bot (direct chat apart) and per model, with the caps that
// apply. Aggregated in SQL over the last 30 days.
import {
  profileBudgetsSchema,
  type Usage,
  type UsageReport,
} from "@jj/contracts";
import { bots, runtimeProfiles, usage } from "@jj/db";
import { desc, gt, isNull, type SQL, sql } from "drizzle-orm";
import type { EngineContext } from "../context";
import { profileSettings } from "../records";
import { DAY_MS } from "./spend";

const num = (expression: SQL) => sql<number>`${expression}`.mapWith(Number);

/** The usage of the rows matching `filter` (all rows without one), as select fields. */
function totals(filter?: SQL) {
  const where = filter ? sql` filter (where ${filter})` : sql``;
  return {
    modelCalls: num(sql`count(*)${where}`),
    inputTokens: num(sql`coalesce(sum(${usage.inputTokens})${where}, 0)`),
    outputTokens: num(sql`coalesce(sum(${usage.outputTokens})${where}, 0)`),
    cacheReadTokens: num(
      sql`coalesce(sum(${usage.cacheReadTokens})${where}, 0)`,
    ),
    cacheWriteTokens: num(
      sql`coalesce(sum(${usage.cacheWriteTokens})${where}, 0)`,
    ),
    costUsd: num(sql`coalesce(sum(${usage.costUsd})${where}, 0)`),
    unpricedCalls: num(
      filter
        ? sql`count(*) filter (where ${filter} and not ${usage.priced})`
        : sql`count(*) filter (where not ${usage.priced})`,
    ),
  };
}

type Prefixed<Prefix extends string> = {
  [Key in keyof Usage as `${Prefix}_${Key}`]: SQL.Aliased<number>;
};

/** `totals(filter)` with every field aliased `<prefix>_<field>`, for several in one row. */
function prefixed<Prefix extends string>(
  prefix: Prefix,
  filter?: SQL,
): Prefixed<Prefix> {
  return Object.fromEntries(
    Object.entries(totals(filter)).map(([key, value]) => [
      `${prefix}_${key}`,
      value.as(`${prefix}_${key}`),
    ]),
  ) as Prefixed<Prefix>;
}

/** Reads the `<prefix>_<field>` columns of a row back into a Usage. */
function unprefix(prefix: string, row: Record<string, unknown>): Usage {
  const value = (key: keyof Usage) => Number(row[`${prefix}_${key}`] ?? 0);
  return {
    modelCalls: value("modelCalls"),
    inputTokens: value("inputTokens"),
    outputTokens: value("outputTokens"),
    cacheReadTokens: value("cacheReadTokens"),
    cacheWriteTokens: value("cacheWriteTokens"),
    costUsd: value("costUsd"),
    unpricedCalls: value("unpricedCalls"),
  };
}

export async function usageReport(ctx: EngineContext): Promise<UsageReport> {
  const now = ctx.clock();
  const ago = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const day = gt(usage.createdAt, ago(1)) as SQL;
  const week = gt(usage.createdAt, ago(7)) as SQL;
  const month = gt(usage.createdAt, ago(30));

  const [instance] = await ctx.db
    .select({
      ...prefixed("day", day),
      ...prefixed("week", week),
      ...prefixed("month"),
    })
    .from(usage)
    .where(month);
  const perBot = await ctx.db
    .select({
      botId: usage.botId,
      ...prefixed("day", day),
      ...prefixed("month"),
      ...prefixed("chat", isNull(usage.taskId) as SQL),
    })
    .from(usage)
    .where(month)
    .groupBy(usage.botId);
  const perModel = await ctx.db
    .select({ model: usage.model, ...prefixed("month") })
    .from(usage)
    .where(month)
    .groupBy(usage.model)
    .orderBy(desc(sql`coalesce(sum(${usage.costUsd}), 0)`), usage.model);

  const botRows = await ctx.db
    .select({
      id: bots.id,
      name: bots.name,
      profileId: bots.runtimeProfileId,
      archivedAt: bots.archivedAt,
    })
    .from(bots)
    .orderBy(bots.name);
  const profiles = await ctx.db.select().from(runtimeProfiles);
  const fallback = profiles.find((profile) => profile.isDefault);
  const capOf = (profileId: string | null) => {
    const profile = profileId
      ? profiles.find((candidate) => candidate.id === profileId)
      : fallback;
    return (
      profile
        ? profileSettings(profile).budgets
        : profileBudgetsSchema.parse({})
    ).maxUsdPerBotPerDay;
  };
  const byBot = new Map(perBot.map((row) => [row.botId, row]));

  return {
    asOf: now.toISOString(),
    instance: {
      last24h: unprefix("day", instance ?? {}),
      last7d: unprefix("week", instance ?? {}),
      last30d: unprefix("month", instance ?? {}),
      capUsdPerDay: ctx.config.maxUsdPerDay,
    },
    bots: botRows
      .filter((bot) => bot.archivedAt === null || byBot.has(bot.id))
      .map((bot) => {
        const row = byBot.get(bot.id) ?? {};
        return {
          botId: bot.id,
          name: bot.name,
          archived: bot.archivedAt !== null,
          last24h: unprefix("day", row),
          last30d: unprefix("month", row),
          chatLast30d: unprefix("chat", row),
          capUsdPerDay: capOf(bot.profileId),
        };
      }),
    models: perModel.map((row) => ({
      model: row.model,
      last30d: unprefix("month", row),
    })),
  };
}
