// The nightly live-model acceptance run (.github/workflows/nightly-live.yml),
// also run locally with `npm run smoke:nightly`: smoke:runtime, then the live
// smoke:e2e, on a real model under a hard cost cap kept by the product's own
// spend caps, then a Markdown summary of each check's result, cost and time,
// appended to $GITHUB_STEP_SUMMARY when it is set and printed either way.
//
//   JJ_NIGHTLY_MODEL         provider/model, default openai/gpt-6-luna
//   JJ_NIGHTLY_MAX_USD       the run's cost cap in US dollars, default 0.25
//   JJ_NIGHTLY_TASK_CAP_USD  each task's cap in smoke:e2e, default half the cost cap
//
// smoke:runtime gets the whole cap (JJ_SMOKE_MAX_USD); smoke:e2e's server
// gets what is left as JJ_MAX_USD_PER_DAY, and each of its tasks the task cap
// (JJ_SMOKE_TASK_CAP_USD). Without the model's provider key the run is
// skipped with a notice and exits 0; a model with no listed price is refused,
// since no spend cap could bound it. Exits 0 when every check passed or the
// run was skipped, 1 when one failed or the cap stopped it, 2 for settings
// that cannot work.
import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { formatUsd, MAX_SPEND_CAP_USD } from "@jj/contracts";
import {
  ModelRegistry,
  ModelResolutionError,
  parseModelRef,
} from "@jj/runtime";
import {
  type CheckResult,
  checkResult,
  type NightlyOutcome,
  notRun,
  overallState,
  remainingUsd,
  renderSummary,
  type SmokeExit,
  type SmokeReport,
  spent,
} from "./smoke-nightly-summary";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const setting = (name: string) => process.env[name]?.trim() || undefined;
const inActions = process.env.GITHUB_ACTIONS === "true";
const started = Date.now();

/** A workflow command (annotation) in Actions; nothing locally. */
function annotate(level: "notice" | "error", title: string, message: string) {
  if (!inActions) return;
  const escape = (text: string) =>
    text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  console.log(`::${level} title=${escape(title)}::${escape(message)}`);
}

function publish(outcome: NightlyOutcome) {
  const summary = renderSummary(outcome);
  console.log(`\n${summary}`);
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, summary);
}

function refuse(message: string): never {
  console.error(`smoke:nightly: ${message}`);
  annotate("error", "Nightly live run could not start", message);
  process.exit(2);
}

const usdSetting = (name: string, fallback: number) => {
  const raw = setting(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!(Number.isFinite(value) && value > 0 && value <= MAX_SPEND_CAP_USD))
    refuse(
      `${name} must be a positive number of US dollars, at most ${MAX_SPEND_CAP_USD}; it is "${raw}".`,
    );
  return value;
};

const model = setting("JJ_NIGHTLY_MODEL") ?? "openai/gpt-6-luna";
const capUsd = usdSetting("JJ_NIGHTLY_MAX_USD", 0.25);
const taskCapUsd = usdSetting("JJ_NIGHTLY_TASK_CAP_USD", capUsd / 2);

const registry = new ModelRegistry({ env: process.env });
try {
  const resolved = registry.resolve(model);
  if (!(resolved.model.cost.input > 0 || resolved.model.cost.output > 0))
    refuse(
      `${model} has no listed price, so no spend cap could bound the run. Choose a priced model.`,
    );
} catch (error) {
  if (!(error instanceof ModelResolutionError)) throw error;
  if (error.code !== "unconfigured") refuse(error.message);
  const provider = registry
    .providers()
    .find((entry) => entry.id === parseModelRef(model)?.provider);
  const keys = provider?.envVars.join(" or ") ?? "the provider's key";
  const note = `No ${keys} is set, so the live run was skipped. To enable it, add ${keys} as a repository Actions secret (docs/development.md, "Nightly live run").`;
  console.log(`smoke:nightly: ${note}`);
  annotate("notice", "Nightly live run skipped", note);
  publish({
    state: "skipped",
    model,
    capUsd,
    taskCapUsd,
    ms: Date.now() - started,
    checks: [],
    note,
  });
  process.exit(0);
}

const reports = mkdtempSync(join(tmpdir(), "jj-smoke-nightly-"));

/**
 * Runs one smoke script with its output streamed, its report in `reports`,
 * and the environment the nightly gives it: none of the remote or restart
 * settings, so smoke:e2e always boots its own server.
 */
async function runSmoke(
  script: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<{ report: SmokeReport | undefined; exit: SmokeExit; ms: number }> {
  const reportPath = join(reports, `${script}.json`);
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    JJ_SMOKE_BASE_URL: undefined,
    JJ_SMOKE_TOKEN: undefined,
    JJ_SMOKE_RESTART_COMMAND: undefined,
    JJ_SMOKE_UNREACHABLE: undefined,
    JJ_SMOKE_MAX_USD: undefined,
    JJ_SMOKE_TASK_CAP_USD: undefined,
    JJ_MAX_USD_PER_DAY: undefined,
    ...env,
    JJ_SMOKE_MODEL: model,
    JJ_SMOKE_REPORT: reportPath,
  };
  const begun = Date.now();
  const exit = await new Promise<SmokeExit>((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", join(root, "scripts", `${script}.ts`)],
      { cwd: root, env: childEnv, stdio: "inherit" },
    );
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 15_000).unref();
    }, timeoutMs);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve(timedOut ? { code, timedOutAfterMs: timeoutMs } : { code });
    });
  });
  let report: SmokeReport | undefined;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf8")) as SmokeReport;
  } catch {
    report = undefined;
  }
  return { report, exit, ms: Date.now() - begun };
}

const RUNTIME = [
  "smoke:runtime",
  "one live tool cycle in a local sandbox",
] as const;
const E2E = [
  "smoke:e2e",
  "the whole server on the live model: delegation to two workers, stop, spend cap, verification, direct chat and its follow-up",
] as const;

const checks: CheckResult[] = [];
try {
  console.log(
    `smoke:nightly: ${model}, cost cap ${formatUsd(capUsd)}, each task capped at ${formatUsd(taskCapUsd)}`,
  );
  const runtime = await runSmoke(
    "smoke-runtime",
    { JJ_SMOKE_MAX_USD: String(capUsd) },
    5 * 60_000,
  );
  checks.push(
    checkResult(...RUNTIME, runtime.report, runtime.exit, runtime.ms),
  );

  const sofar = spent(checks);
  const left = remainingUsd(capUsd, sofar.usd);
  if (!sofar.known)
    checks.push(
      notRun(
        ...E2E,
        "smoke:runtime reported no spend, so the rest of the cap is unknown.",
      ),
    );
  else if (left <= 0)
    checks.push(
      notRun(
        ...E2E,
        `smoke:runtime spent the whole ${formatUsd(capUsd)} cost cap.`,
      ),
    );
  else {
    console.log(
      `smoke:nightly: smoke:e2e may spend ${formatUsd(left)} (JJ_MAX_USD_PER_DAY)`,
    );
    const e2e = await runSmoke(
      "smoke-e2e",
      {
        JJ_MAX_USD_PER_DAY: String(left),
        JJ_SMOKE_TASK_CAP_USD: String(taskCapUsd),
      },
      30 * 60_000,
    );
    checks.push(checkResult(...E2E, e2e.report, e2e.exit, e2e.ms));
  }
} finally {
  rmSync(reports, { recursive: true, force: true });
}

const outcome: NightlyOutcome = {
  state: overallState(checks),
  model,
  capUsd,
  taskCapUsd,
  ms: Date.now() - started,
  checks,
};
publish(outcome);
const total = spent(checks);
const spend = `${total.known ? "" : "at least "}${formatUsd(total.usd)} of ${formatUsd(capUsd)}`;
if (outcome.state === "capped") {
  const stop = checks.find((entry) => entry.state === "capped");
  annotate(
    "error",
    "Nightly live run stopped at its cost cap",
    `${stop?.name}: ${stop?.detail ?? ""} Spent ${spend}.`,
  );
} else if (outcome.state === "failed") {
  for (const entry of checks.filter((item) => item.state === "failed"))
    annotate(
      "error",
      `Nightly live run: ${entry.name} failed`,
      entry.detail ?? "",
    );
}
console.log(`smoke:nightly: ${outcome.state}, spent ${spend}`);
process.exit(outcome.state === "passed" ? 0 : 1);
