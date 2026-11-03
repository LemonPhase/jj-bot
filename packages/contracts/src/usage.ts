import { z } from "zod";
import { idSchema, spendCapUsdSchema, timestampSchema } from "./common";
import { usageSchema } from "./tasks";

/**
 * Which cap stopped a model call: the task's own (`task.spendCapUsd`), the
 * bot's rolling 24 hours (its profile's `budgets.maxUsdPerBotPerDay`), or the
 * whole instance's rolling 24 hours (the server's `JJ_MAX_USD_PER_DAY`).
 */
export const SPEND_SCOPES = ["task", "bot", "instance"] as const;
export const spendScopeSchema = z.enum(SPEND_SCOPES);

/**
 * The share of a task's cap past which its spend is flagged (`spend.threshold`,
 * shown amber). Approvals (#87) will build on it.
 */
export const SPEND_SOFT_THRESHOLD = 0.8;

/** At most `places` decimals, trailing zeros dropped down to cents. */
function fixedUsd(usd: number, places: number): string {
  const [whole, fraction = ""] = usd.toFixed(places).split(".");
  return `$${whole}.${fraction.replace(/0+$/, "").padEnd(2, "0")}`;
}

const placesFor = (usd: number) => (usd >= 1 ? 2 : usd >= 0.01 ? 4 : 6);

/**
 * US dollars as people read them: cents from a dollar up, else up to four
 * places (six below a cent) without trailing zeros. "$5.00", "$0.035",
 * "$0.004789". The server's messages and the clients use the same one.
 */
export function formatUsd(usd: number): string {
  return fixedUsd(usd, placesFor(usd));
}

const shownValue = (text: string) => Number(text.slice(1));

/**
 * Spend next to a cap, each as `formatUsd` shows it unless that would make
 * them compare differently from what they are: then both get more places,
 * so spend over a cap never reads as at or under it, and under never as at
 * or over. "$4.996 of $5.00", "$0.015 of $0.01".
 */
export function formatSpendAgainstCap(
  spentUsd: number,
  capUsd: number,
): { spent: string; cap: string } {
  const order = Math.sign(spentUsd - capUsd);
  let spent = formatUsd(spentUsd);
  let cap = formatUsd(capUsd);
  for (
    let places = Math.max(placesFor(spentUsd), placesFor(capUsd));
    Math.sign(shownValue(spent) - shownValue(cap)) !== order && places <= 12;
    places += 1
  ) {
    spent = fixedUsd(spentUsd, places);
    cap = fixedUsd(capUsd, places);
  }
  return { spent, cap };
}

/** `details` of a 409 SPEND_CAP_REACHED. */
export const spendCapReachedDetailsSchema = z.object({
  scope: spendScopeSchema,
  spentUsd: z.number().nonnegative(),
  capUsd: spendCapUsdSchema,
  /** The bot whose cap it is, for the `bot` scope. */
  botId: idSchema.optional(),
});

/**
 * `GET /api/usage`: spend over rolling windows ending at `asOf`, everything
 * the server recorded (task sessions, compaction and direct chat). Calls on
 * models with no listed price are counted in `unpricedCalls`, not in `costUsd`.
 */
export const usageReportSchema = z.object({
  asOf: timestampSchema,
  instance: z.object({
    last24h: usageSchema,
    last7d: usageSchema,
    last30d: usageSchema,
    /** The instance cap over any rolling 24 hours (`JJ_MAX_USD_PER_DAY`); null for none. */
    capUsdPerDay: spendCapUsdSchema.nullable(),
  }),
  /** Every active bot, and archived ones with usage in the last 30 days. */
  bots: z.array(
    z.object({
      botId: idSchema,
      name: z.string().min(1),
      archived: z.boolean(),
      last24h: usageSchema,
      last30d: usageSchema,
      /** The part of `last30d` spent on direct chat replies. */
      chatLast30d: usageSchema,
      /** The bot's cap over any rolling 24 hours, from its profile; null for none. */
      capUsdPerDay: spendCapUsdSchema.nullable(),
    }),
  ),
  /** Models used in the last 30 days, most expensive first. */
  models: z.array(z.object({ model: z.string().min(1), last30d: usageSchema })),
});

export type SpendScope = z.infer<typeof spendScopeSchema>;
export type SpendCapReachedDetails = z.infer<
  typeof spendCapReachedDetailsSchema
>;
export type UsageReport = z.infer<typeof usageReportSchema>;
