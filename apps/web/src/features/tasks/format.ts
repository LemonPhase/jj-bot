/** Number formats for the Tasks screen: token counts, cost and file sizes. */
import type { Usage } from "@jj/contracts";

const compact = (value: number, unit: number, suffix: string) => {
  const scaled = value / unit;
  return `${scaled >= 100 ? Math.round(scaled) : Number(scaled.toFixed(1))}${suffix}`;
};

/** 950, 14.2k, 3.1M. */
export function formatCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return compact(value, 1000, "k");
  return compact(value, 1_000_000, "M");
}

/** "$0.00", "<$0.01", "$1.24". */
export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** Model input plus output tokens: what a run read and wrote. */
export const tokenTotal = (usage: Usage): number =>
  usage.inputTokens + usage.outputTokens;

/** "14.2k tokens · $0.00". */
export const usageLine = (usage: Usage): string =>
  `${formatCount(tokenTotal(usage))} tokens · ${formatCost(usage.costUsd)}`;

const grouped = (value: number) => value.toLocaleString("en-GB");

/** The full breakdown, for a tooltip or the inspector. */
export function usageDetail(usage: Usage): string {
  const calls = `${usage.modelCalls} model call${usage.modelCalls === 1 ? "" : "s"}`;
  return [
    calls,
    `${grouped(usage.inputTokens)} in`,
    `${grouped(usage.outputTokens)} out`,
    `${grouped(usage.cacheReadTokens)} cache read`,
    `${grouped(usage.cacheWriteTokens)} cache write`,
    `$${usage.costUsd.toFixed(4)}`,
  ].join(" · ");
}

/** 512 B, 2.1 KB, 3.4 MB. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Number((bytes / 1024).toFixed(1))} KB`;
  if (bytes < 1024 ** 3) return `${Number((bytes / 1024 ** 2).toFixed(1))} MB`;
  return `${Number((bytes / 1024 ** 3).toFixed(1))} GB`;
}
