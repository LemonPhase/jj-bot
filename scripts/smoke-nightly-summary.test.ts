import { readFileSync } from "node:fs";
import { emptyUsage } from "@jj/contracts";
import { describe, expect, it } from "vitest";
import {
  type CheckResult,
  checkResult,
  type NightlyOutcome,
  notRun,
  overallState,
  remainingUsd,
  renderSummary,
  type SmokeReport,
  smokeEnv,
  spent,
} from "./smoke-nightly-summary";

const usage = (costUsd: number, modelCalls = 3) => ({
  ...emptyUsage(),
  costUsd,
  modelCalls,
});

const report = (overrides: Partial<SmokeReport> = {}): SmokeReport => ({
  status: "passed",
  usage: usage(0.01),
  durationMs: 1000,
  ...overrides,
});

describe("checkResult", () => {
  it("passes a smoke that passed and exited 0, with its spend", () => {
    expect(
      checkResult("smoke:e2e", "e2e", report(), { code: 0 }, 1234),
    ).toMatchObject({
      state: "passed",
      costUsd: 0.01,
      modelCalls: 3,
      ms: 1234,
    });
  });

  it("reports a cap stop the smoke noticed, over the failure it caused", () => {
    const result = checkResult(
      "smoke:e2e",
      "e2e",
      report({
        status: "failed",
        capped: "The server's daily spend cap: $0.0042 of $0.004 spent.",
        steps: [{ name: "follow", ok: false, ms: 5, detail: "stopped" }],
      }),
      { code: 1 },
      10,
    );
    expect(result).toMatchObject({
      state: "capped",
      detail: "The server's daily spend cap: $0.0042 of $0.004 spent.",
    });
  });

  it("puts a failure past the server's daily cap down to the cap, a pass not", () => {
    const atCap = { usage: usage(0.05), capUsdPerDay: 0.05 };
    const failed = checkResult(
      "smoke:e2e",
      "e2e",
      report({ status: "failed", ...atCap }),
      { code: 1 },
      10,
    );
    expect(failed.state).toBe("capped");
    expect(failed.detail).toBe(
      "The server's daily spend cap (JJ_MAX_USD_PER_DAY): $0.05 of $0.05 spent.",
    );
    expect(
      checkResult("smoke:e2e", "e2e", report(atCap), { code: 0 }, 10).state,
    ).toBe("passed");
  });

  it("names the first failed step", () => {
    const result = checkResult(
      "smoke:e2e",
      "e2e",
      report({
        status: "failed",
        capUsdPerDay: 1,
        steps: [
          { name: "boot", ok: true, ms: 1 },
          { name: "direct chat", ok: false, ms: 2, detail: "no task" },
        ],
      }),
      { code: 1 },
      10,
    );
    expect(result).toMatchObject({
      state: "failed",
      detail: "direct chat: no task",
    });
  });

  it("fails a passed report whose process failed", () => {
    expect(
      checkResult("smoke:runtime", "runtime", report(), { code: 1 }, 1).state,
    ).toBe("failed");
  });

  it("fails a smoke without a report, its spend unknown", () => {
    expect(
      checkResult(
        "smoke:e2e",
        "e2e",
        undefined,
        { code: null, timedOutAfterMs: 1_800_000 },
        1,
      ),
    ).toMatchObject({
      state: "failed",
      costUsd: null,
      detail: "stopped after 30 min 00 s, before it reported",
    });
  });
});

describe("the cost cap", () => {
  it("leaves the rest of the cap, rounded down and never below zero", () => {
    expect(remainingUsd(0.25, 0.0004567)).toBe(0.249543);
    expect(remainingUsd(0.25, 0.3)).toBe(0);
  });

  it("adds up what the checks spent, and knows when it is unknown", () => {
    const passed = checkResult("a", "a", report(), { code: 0 }, 1);
    const silent = checkResult("b", "b", undefined, { code: 1 }, 1);
    expect(spent([passed])).toEqual({ usd: 0.01, known: true });
    expect(spent([passed, silent])).toEqual({ usd: 0.01, known: false });
  });

  it("ranks a cap stop above a failure, and a failure above a pass", () => {
    const passed = { state: "passed" } as CheckResult;
    const failed = { state: "failed" } as CheckResult;
    const capped = { state: "capped" } as CheckResult;
    expect(overallState([passed, notRun("b", "b", "no room")])).toBe("passed");
    expect(overallState([failed, passed])).toBe("failed");
    expect(overallState([failed, capped])).toBe("capped");
  });
});

describe("renderSummary", () => {
  const outcome = (checks: CheckResult[]): NightlyOutcome => ({
    state: overallState(checks),
    model: "openai/gpt-6-luna",
    capUsd: 0.25,
    taskCapUsd: 0.125,
    ms: 95_000,
    checks,
  });

  it("shows the result, the spend against the cap, and each check and step", () => {
    const summary = renderSummary(
      outcome([
        checkResult(
          "smoke:runtime",
          "one tool cycle",
          report({ usage: usage(0.0004, 2) }),
          { code: 0 },
          4200,
        ),
        checkResult(
          "smoke:e2e",
          "the whole server",
          report({
            status: "failed",
            usage: usage(0.0123, 40),
            capUsdPerDay: 0.2496,
            steps: [
              { name: "boot", ok: true, ms: 800 },
              {
                name: "direct chat",
                ok: false,
                ms: 61_000,
                detail: "a | b <b>\nc",
              },
            ],
          }),
          { code: 1 },
          90_000,
        ),
      ]),
    );
    expect(summary).toContain("## Nightly live run: FAILED");
    expect(summary).toContain(
      "Spent **$0.0127** of the **$0.25** cost cap (each task capped at $0.125) in 1 min 35 s.",
    );
    expect(summary).toContain(
      "| `smoke:runtime`: one tool cycle | passed | $0.0004 | 2 | 4.2 s |",
    );
    expect(summary).toContain(
      "| `smoke:e2e`: the whole server | **FAILED**: direct chat: a \\| b &lt;b&gt; c | $0.0123 | 40 | 1 min 30 s |",
    );
    expect(summary).toContain("steps: 1 passed, 1 failed");
    expect(summary).toContain("| boot | ok | 800 ms |");
  });

  it("says when the cap stopped the run, and that the spend is a floor when one check reported none", () => {
    const summary = renderSummary(
      outcome([
        checkResult("smoke:runtime", "runtime", undefined, { code: 1 }, 1),
        checkResult(
          "smoke:e2e",
          "e2e",
          report({ status: "failed", capped: "The task's spend cap." }),
          { code: 1 },
          1,
        ),
      ]),
    );
    expect(summary).toContain("## Nightly live run: stopped at the cost cap");
    expect(summary).toContain("Spent at least **$0.01**");
    expect(summary).toContain(
      "**stopped at the cost cap**: The task's spend cap.",
    );
  });

  it("explains a skipped run", () => {
    expect(
      renderSummary({
        ...outcome([]),
        state: "skipped",
        note: "No OPENAI_API_KEY is set.",
      }),
    ).toBe(
      "## Nightly live run: skipped\n\nModel `openai/gpt-6-luna`. No OPENAI_API_KEY is set.\n\n",
    );
  });
});

describe("the nightly workflow", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/nightly-live.yml", import.meta.url),
    "utf8",
  );
  /** The keys of a top-level block, such as the triggers under `on:`. */
  const keysOf = (block: string) =>
    [
      ...(
        workflow.match(
          new RegExp(`^${block}:\\n((?:[ #].*\\n|\\n)*)`, "m"),
        )?.[1] ?? ""
      ).matchAll(/^ {2}([\w-]+):/gm),
    ].map((match) => match[1]);

  it("runs only on its schedule and by hand, never for a pull request or push", () => {
    expect(keysOf("on")).toEqual(["schedule", "workflow_dispatch"]);
    expect(workflow).not.toMatch(/pull_request|push:/);
    // Nightly, off the hour.
    expect(workflow).toMatch(/cron: "([1-9]|[1-5]\d) \d+ \* \* \*"/);
  });

  it("can only read the repository, and hands the key to one step", () => {
    expect(keysOf("permissions")).toEqual(["contents"]);
    expect(workflow).toMatch(/^permissions:\n {2}contents: read\n/m);
    expect(workflow.match(/secrets\.\w+/g)).toEqual(["secrets.OPENAI_API_KEY"]);
  });

  it("runs the live smokes on docker: the daemon checked and the sandbox image built first", () => {
    const runs = [...workflow.matchAll(/^ {8}run: (.+)$/gm)].map(
      (match) => match[1],
    );
    expect(runs).toEqual([
      "npm ci",
      "docker version",
      "npm run sandbox:image",
      "npm run smoke:nightly",
    ]);
    // The key's step runs the nightly script, whose smokes always get the
    // docker driver (smokeEnv, below); nothing in the workflow overrides it.
    expect(workflow).not.toMatch(/JJ_SMOKE_DRIVER|JJ_SANDBOX_DRIVERS/);
  });
});

describe("smokeEnv", () => {
  const run = { model: "openai/gpt-6-luna", reportPath: "/tmp/r.json" };

  it("always selects the docker driver, whatever the environment says", () => {
    for (const driver of [undefined, "local", "docker"]) {
      const env = smokeEnv(
        { OPENAI_API_KEY: "k", JJ_SMOKE_DRIVER: driver },
        {},
        run,
      );
      expect(env.JJ_SMOKE_DRIVER).toBe("docker");
    }
  });

  it("drops remote, restart and stale cap settings, and keeps the nightly's own", () => {
    const env = smokeEnv(
      {
        PATH: "/bin",
        JJ_SMOKE_BASE_URL: "http://127.0.0.1:3001",
        JJ_SMOKE_TOKEN: "t",
        JJ_SMOKE_RESTART_COMMAND: "docker compose restart app",
        JJ_SMOKE_UNREACHABLE: "app:3001",
        JJ_MAX_USD_PER_DAY: "100",
        JJ_SMOKE_MAX_USD: "100",
        JJ_SMOKE_TASK_CAP_USD: "100",
        JJ_SMOKE_SANDBOX_IMAGE: "elsewhere:1",
      },
      { JJ_MAX_USD_PER_DAY: "0.2", JJ_SMOKE_TASK_CAP_USD: "0.125" },
      { ...run, sandboxImage: "jj-sandbox:local-fallback" },
    );
    expect(env).toEqual({
      PATH: "/bin",
      JJ_SMOKE_BASE_URL: undefined,
      JJ_SMOKE_TOKEN: undefined,
      JJ_SMOKE_RESTART_COMMAND: undefined,
      JJ_SMOKE_UNREACHABLE: undefined,
      JJ_SMOKE_MAX_USD: undefined,
      JJ_MAX_USD_PER_DAY: "0.2",
      JJ_SMOKE_TASK_CAP_USD: "0.125",
      JJ_SMOKE_MODEL: "openai/gpt-6-luna",
      JJ_SMOKE_REPORT: "/tmp/r.json",
      JJ_SMOKE_DRIVER: "docker",
      JJ_SMOKE_SANDBOX_IMAGE: "jj-sandbox:local-fallback",
    });
    expect(smokeEnv({}, {}, run).JJ_SMOKE_SANDBOX_IMAGE).toBeUndefined();
  });
});
