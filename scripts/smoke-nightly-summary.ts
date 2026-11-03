// The nightly live run's pure parts (scripts/smoke-nightly.ts): the
// environment it hands each smoke, the results and their Markdown job
// summary. No process, file or network access.
import { formatSpendAgainstCap, formatUsd, type Usage } from "@jj/contracts";

/**
 * The environment of a nightly smoke. Always the docker driver: the commands
 * a live model writes run in an isolated sandbox without network, never next
 * to the provider key in this environment. None of the remote or restart
 * settings, so smoke:e2e boots its own server, and only the nightly's caps.
 */
export function smokeEnv(
  base: Readonly<Record<string, string | undefined>>,
  settings: Readonly<Record<string, string>>,
  run: { model: string; reportPath: string; sandboxImage?: string },
): Record<string, string | undefined> {
  return {
    ...base,
    JJ_SMOKE_BASE_URL: undefined,
    JJ_SMOKE_TOKEN: undefined,
    JJ_SMOKE_RESTART_COMMAND: undefined,
    JJ_SMOKE_UNREACHABLE: undefined,
    JJ_SMOKE_MAX_USD: undefined,
    JJ_SMOKE_TASK_CAP_USD: undefined,
    JJ_MAX_USD_PER_DAY: undefined,
    ...settings,
    JJ_SMOKE_MODEL: run.model,
    JJ_SMOKE_REPORT: run.reportPath,
    JJ_SMOKE_DRIVER: "docker",
    JJ_SMOKE_SANDBOX_IMAGE: run.sandboxImage,
  };
}

/** The fields of a smoke's JJ_SMOKE_REPORT that the summary reads. */
export interface SmokeReport {
  status: "passed" | "failed";
  usage: Usage | null;
  durationMs: number;
  /** The spend cap that stopped the smoke, when one did. */
  capped?: string;
  /** smoke:runtime: an unexpected error. */
  error?: string;
  /** smoke:e2e: the server's daily cap (`JJ_MAX_USD_PER_DAY`), null for none. */
  capUsdPerDay?: number | null;
  /** smoke:e2e: every step, in order. */
  steps?: { name: string; ok: boolean; ms: number; detail?: string }[];
}

/** How a smoke ended: its exit code, or the timeout that stopped it. */
export interface SmokeExit {
  code: number | null;
  timedOutAfterMs?: number;
}

export type CheckState = "passed" | "failed" | "capped" | "not run";

export interface CheckResult {
  /** The npm script, such as `smoke:runtime`. */
  name: string;
  /** What it checks, in a few words. */
  what: string;
  state: CheckState;
  /** Priced spend, from the smoke's report; null when it reported none. */
  costUsd: number | null;
  modelCalls: number | null;
  ms: number;
  detail?: string;
  steps?: SmokeReport["steps"];
}

export type NightlyState = "passed" | "failed" | "capped" | "skipped";

export interface NightlyOutcome {
  state: NightlyState;
  model: string;
  /** The run's cost cap, in US dollars. */
  capUsd: number;
  /** Each task's cap on the server smoke:e2e boots. */
  taskCapUsd: number;
  ms: number;
  checks: CheckResult[];
  /** Why the run was skipped. */
  note?: string;
}

/** A check that never started, such as one the cost cap left no room for. */
export function notRun(name: string, what: string, why: string): CheckResult {
  return {
    name,
    what,
    state: "not run",
    costUsd: 0,
    modelCalls: 0,
    ms: 0,
    detail: why,
  };
}

/** A check's result from its report (undefined when it wrote none) and its exit. */
export function checkResult(
  name: string,
  what: string,
  report: SmokeReport | undefined,
  exit: SmokeExit,
  ms: number,
): CheckResult {
  const base = { name, what, ms, steps: report?.steps };
  if (!report)
    return {
      ...base,
      state: "failed",
      costUsd: null,
      modelCalls: null,
      detail:
        exit.timedOutAfterMs !== undefined
          ? `stopped after ${formatMs(exit.timedOutAfterMs)}, before it reported`
          : `exited with ${exit.code ?? "a signal"} without a report`,
    };
  const costUsd = report.usage?.costUsd ?? null;
  const spend = {
    costUsd,
    modelCalls: report.usage?.modelCalls ?? null,
  };
  const dailyCap = report.capUsdPerDay ?? null;
  if (report.capped)
    return { ...base, ...spend, state: "capped", detail: report.capped };
  if (report.status === "passed" && exit.code === 0)
    return { ...base, ...spend, state: "passed" };
  // A failure once the server's cap was reached, though no step saw the cap.
  if (dailyCap !== null && costUsd !== null && costUsd >= dailyCap) {
    const shown = formatSpendAgainstCap(costUsd, dailyCap);
    return {
      ...base,
      ...spend,
      state: "capped",
      detail: `The server's daily spend cap (JJ_MAX_USD_PER_DAY): ${shown.spent} of ${shown.cap} spent.`,
    };
  }
  const failed = report.steps?.find((entry) => !entry.ok);
  return {
    ...base,
    ...spend,
    state: "failed",
    detail: failed
      ? `${failed.name}${failed.detail ? `: ${failed.detail}` : ""}`
      : (report.error ?? `exited with ${exit.code ?? "a signal"}`),
  };
}

/** A cap stop outranks the failures it causes. */
export function overallState(checks: CheckResult[]): NightlyState {
  if (checks.some((entry) => entry.state === "capped")) return "capped";
  if (checks.some((entry) => entry.state === "failed")) return "failed";
  return "passed";
}

/** What the checks spent; `known` is false when one ran but reported nothing. */
export function spent(checks: CheckResult[]): { usd: number; known: boolean } {
  return {
    usd: checks.reduce((total, entry) => total + (entry.costUsd ?? 0), 0),
    known: checks.every((entry) => entry.costUsd !== null),
  };
}

/**
 * What is left of `capUsd` after `spentUsd`, rounded down to a millionth of a
 * dollar so a later cap never adds up to more than the whole.
 */
export function remainingUsd(capUsd: number, spentUsd: number): number {
  return Math.max(0, Math.floor((capUsd - spentUsd) * 1e6) / 1e6);
}

export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s`;
}

const titles: Record<NightlyState, string> = {
  passed: "passed",
  failed: "FAILED",
  capped: "stopped at the cost cap",
  skipped: "skipped",
};

const results: Record<CheckState, string> = {
  passed: "passed",
  failed: "**FAILED**",
  capped: "**stopped at the cost cap**",
  "not run": "not run",
};

/** Text safe in a Markdown table cell: no HTML, pipes or line breaks. */
function cell(text: string, max = 400): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const clipped = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  return clipped
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "\\|");
}

const usd = (value: number | null) =>
  value === null ? "unknown" : formatUsd(value);

/** The job summary: the outcome, the spend against the cap, each check and each step. */
export function renderSummary(outcome: NightlyOutcome): string {
  const lines = [`## Nightly live run: ${titles[outcome.state]}`, ""];
  if (outcome.state === "skipped") {
    lines.push(`Model \`${outcome.model}\`. ${outcome.note ?? ""}`.trim(), "");
    return `${lines.join("\n")}\n`;
  }
  const total = spent(outcome.checks);
  lines.push(
    `Model \`${outcome.model}\`. Spent ${total.known ? "" : "at least "}**${formatUsd(total.usd)}** of the **${formatUsd(outcome.capUsd)}** cost cap (each task capped at ${formatUsd(outcome.taskCapUsd)}) in ${formatMs(outcome.ms)}.`,
    "",
    "| Check | Result | Cost | Model calls | Time |",
    "| --- | --- | --- | --- | --- |",
  );
  for (const entry of outcome.checks)
    lines.push(
      `| \`${entry.name}\`: ${cell(entry.what)} | ${results[entry.state]}${entry.detail ? `: ${cell(entry.detail)}` : ""} | ${usd(entry.costUsd)} | ${entry.modelCalls ?? "unknown"} | ${formatMs(entry.ms)} |`,
    );
  for (const entry of outcome.checks) {
    if (!entry.steps?.length) continue;
    const failed = entry.steps.filter((item) => !item.ok).length;
    lines.push(
      "",
      `<details><summary><code>${entry.name}</code> steps: ${entry.steps.length - failed} passed, ${failed} failed</summary>`,
      "",
      "| Step | Result | Time |",
      "| --- | --- | --- |",
      ...entry.steps.map(
        (item) =>
          `| ${cell(item.name)} | ${item.ok ? "ok" : `**FAILED**${item.detail ? `: ${cell(item.detail)}` : ""}`} | ${formatMs(item.ms)} |`,
      ),
      "",
      "</details>",
    );
  }
  return `${lines.join("\n")}\n`;
}
