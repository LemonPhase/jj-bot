// Live smoke test of the pi runtime: one real tool cycle (model -> bash in a
// `local` sandbox -> model) with the model in JJ_SMOKE_MODEL (default
// openai/gpt-6-luna). Needs that provider's key in the environment or .env.
// Prints the model, turns, tool calls and usage; exits non-zero on failure.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addUsage, emptyUsage } from "@jj/contracts";
import {
  type ExecutorEvent,
  ModelRegistry,
  ModelResolutionError,
  PiSessionExecutor,
} from "@jj/runtime";
import { LocalSandboxDriver } from "@jj/sandbox";

const ref = process.env.JJ_SMOKE_MODEL?.trim() || "openai/gpt-6-luna";
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
  const events: ExecutorEvent[] = [];
  const started = Date.now();
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
      },
    });
    const usage = events.reduce(
      (total, event) =>
        event.type === "model.finished" ? addUsage(total, event.usage) : total,
      emptyUsage(),
    );
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
    console.info(
      redact(
        JSON.stringify(
          {
            test: "runtime",
            status: passed ? "passed" : "failed",
            model: ref,
            outcome,
            turns: usage.modelCalls,
            toolCalls: tools,
            usage,
            durationMs: Date.now() - started,
          },
          null,
          2,
        ),
      ),
    );
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
    console.error(
      redact(
        `smoke:runtime failed: ${error instanceof Error ? error.stack : String(error)}`,
      ),
    );
    process.exitCode = 1;
  },
);
