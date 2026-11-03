// Live smoke test of the pi runtime: one real tool cycle (model -> bash in a
// `local` sandbox -> model) with the model in JJ_SMOKE_MODEL (default
// openai/gpt-6-luna). Needs that provider's key in the environment or .env.
// Prints the model, turns, tool calls and usage; exits non-zero on failure.
//
// JJ_SMOKE_MAX_USD caps its spend: no model call starts once the calls so far
// cost that much (a call in flight finishes), and the run then fails as
// stopped at the cap. JJ_SMOKE_REPORT=<path> also writes the result as JSON.
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  addUsage,
  emptyUsage,
  formatSpendAgainstCap,
  MAX_SPEND_CAP_USD,
} from "@jj/contracts";
import {
  configureOutboundProxy,
  type ExecutorEvent,
  ModelRegistry,
  ModelResolutionError,
  PiSessionExecutor,
} from "@jj/runtime";
import { LocalSandboxDriver } from "@jj/sandbox";

// Provider SDKs use Node's fetch, which ignores HTTPS_PROXY on its own.
const proxy = configureOutboundProxy(process.env);
const ref = process.env.JJ_SMOKE_MODEL?.trim() || "openai/gpt-6-luna";
const reportPath = process.env.JJ_SMOKE_REPORT?.trim() || undefined;
const capRaw = process.env.JJ_SMOKE_MAX_USD?.trim();
const capUsd = capRaw ? Number(capRaw) : undefined;
if (
  capUsd !== undefined &&
  !(Number.isFinite(capUsd) && capUsd > 0 && capUsd <= MAX_SPEND_CAP_USD)
) {
  console.error(
    `smoke:runtime: JJ_SMOKE_MAX_USD must be a positive number of US dollars, at most ${MAX_SPEND_CAP_USD}.`,
  );
  process.exit(2);
}
const registry = new ModelRegistry({ env: process.env });

let key: string | undefined;
try {
  key = registry.resolve(ref).getApiKey();
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  console.error(`smoke:runtime refused to run ${ref}: ${reason}`);
  if (error instanceof ModelResolutionError && error.code === "unconfigured")
    console.error(
      "Set the provider's key in the environment or .env, or choose another model with JJ_SMOKE_MODEL=provider/model.",
    );
  process.exit(2);
}
if (!key) {
  console.error(
    `smoke:runtime refused to run ${ref}: it needs a provider key, and ${ref} has none.`,
  );
  process.exit(2);
}

/** Never print a key, even inside a provider error message. */
const redact = (text: string) =>
  key ? text.split(key).join("[redacted]") : text;

const events: ExecutorEvent[] = [];
const started = Date.now();
const usageSoFar = () =>
  events.reduce(
    (total, event) =>
      event.type === "model.finished" ? addUsage(total, event.usage) : total,
    emptyUsage(),
  );
/** Why a model call was refused at JJ_SMOKE_MAX_USD, once one was. */
let capped: string | undefined;

/** Prints the result and, with JJ_SMOKE_REPORT, writes it there. */
function report(result: Record<string, unknown>) {
  const text = redact(
    JSON.stringify(
      {
        test: "runtime",
        ...result,
        model: ref,
        capUsd: capUsd ?? null,
        ...(capped ? { capped } : {}),
        usage: usageSoFar(),
        durationMs: Date.now() - started,
      },
      null,
      2,
    ),
  );
  console.info(text);
  if (reportPath) writeFileSync(reportPath, `${text}\n`);
}

async function main(): Promise<boolean> {
  const root = await mkdtemp(join(tmpdir(), "jj-smoke-runtime-"));
  const driver = new LocalSandboxDriver({ root });
  const spec = driver.validateSpec({
    driver: "local",
    network: { mode: "open" },
  });
  const sandbox = await driver.acquire({
    sessionId: "smoke",
    taskId: "smoke",
    spec,
    workspaceKey: "smoke",
  });
  try {
    const outcome = await new PiSessionExecutor({ models: registry }).run({
      sessionId: "smoke",
      runId: "smoke-1",
      systemPrompt:
        "You are a smoke test for a coding agent. Use the tools exactly as asked and keep replies short.",
      transcript: [],
      inputs: [
        "Use the bash tool to run exactly: echo JJ_RUNTIME_SMOKE_$((6*7))\nThen reply with only the number that follows JJ_RUNTIME_SMOKE_ in its output.",
      ],
      model: ref,
      sandbox,
      sandboxLimits: spec.limits,
      codingTools: ["bash", "read", "write"],
      collaborationTools: [],
      budgets: { maxTurns: 6, deadline: new Date(Date.now() + 120_000) },
      signal: AbortSignal.timeout(150_000),
      hooks: {
        onEvent: (event) => {
          events.push(event);
        },
        onTurnComplete: () => {},
        drainInbox: async () => [],
        spillOutput: async () => "smoke-artifact",
        admitModelCall: async () => {
          const spent = usageSoFar().costUsd;
          if (capUsd === undefined || spent < capUsd) return undefined;
          const shown = formatSpendAgainstCap(spent, capUsd);
          capped = `The run reached JJ_SMOKE_MAX_USD: ${shown.spent} of ${shown.cap} spent.`;
          return capped;
        },
      },
    });
    const usage = usageSoFar();
    const tools = events.flatMap((event) =>
      event.type === "tool.finished"
        ? [
            {
              tool: event.tool,
              summary: event.summary,
              ok: event.ok,
              exitCode: event.exitCode,
              output: event.output?.slice(0, 200),
            },
          ]
        : [],
    );
    const bashed = tools.some(
      (call) =>
        call.tool === "bash" &&
        call.ok &&
        call.output?.includes("JJ_RUNTIME_SMOKE_42"),
    );
    const answered =
      outcome.kind === "ended" && outcome.finalText.includes("42");
    const passed = bashed && answered && usage.modelCalls >= 2;
    report({
      status: passed ? "passed" : "failed",
      proxy: proxy
        ? { httpsProxy: proxy.httpsProxy, httpProxy: proxy.httpProxy }
        : "none",
      outcome,
      turns: usage.modelCalls,
      toolCalls: tools,
    });
    return passed;
  } finally {
    await sandbox.release();
    await rm(root, { recursive: true, force: true });
  }
}

main().then(
  (passed) => {
    process.exitCode = passed ? 0 : 1;
  },
  (error: unknown) => {
    const detail = error instanceof Error ? error.stack : String(error);
    console.error(redact(`smoke:runtime failed: ${detail}`));
    report({
      status: "failed",
      error: error instanceof Error ? error.message : String(error),
    });
    process.exitCode = 1;
  },
);
