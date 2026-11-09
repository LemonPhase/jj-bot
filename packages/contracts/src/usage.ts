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
 * The share of a cap past which its spend is flagged (`spend.threshold`,
 * for the task's cap, shown amber). A warning only, unless the cap's option
 * (`approveSpendPastThreshold`) asks for the user's go-ahead there: then a
 * spend approval holds the model calls the cap counts (`spendApprovalSchema`).
 */
export const SPEND_SOFT_THRESHOLD = 0.8;

export { formatSpendAgainstCap, formatUsd } from "./money";

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
