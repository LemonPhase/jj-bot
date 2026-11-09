// Spans and metrics below the API: an activity's model turns and tool calls,
// tool names it did not declare, calls a stop cut short, sandbox starts that
// fail, and the worker's heartbeat row.
import { workerHeartbeats } from "@jj/db";
import { LocalSandboxDriver } from "@jj/sandbox";
import { sandboxSpecSchema } from "@jj/sandbox/contract";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { resolveConfig } from "../config";
import type { EngineContext } from "../context";
import { createDriverRegistry } from "../drivers";
import type { EngineDriver, ExecutorEvent } from "../ports";
import {
  OPEN_TIMEOUT,
  openTestDatabase,
  quietLogger,
  type TestDatabase,
  testEngine,
  until,
} from "../testing/harness";
import { TaskSandboxes } from "../worker/sandboxes";
import { createMetrics } from "./metrics";
import { ActivityTrace, SPANS } from "./tracing";

const exporter = new InMemorySpanExporter();
const provider = new TracerProvider({
  spanProcessors: [new SimpleSpanProcessor({ exporter })],
});
const tracer = provider.getTracer("test");
beforeEach(() => exporter.reset());

const usage = {
  modelCalls: 1,
  inputTokens: 120,
  outputTokens: 30,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.0004,
  unpricedCalls: 0,
};

const sampleOf = (text: string, line: string) =>
  Number(
    text
      .split("\n")
      .find((entry) => entry.startsWith(line))
      ?.split(" ")
      .at(-1) ?? Number.NaN,
  );

describe("ActivityTrace", () => {
  it("nests model turns and tool calls under its span, with their counts and cost", async () => {
    const metrics = createMetrics();
    const activity = new ActivityTrace(tracer, metrics, SPANS.sessionRun, {
      "jj.run.id": "run_1",
    });
    activity.declareTools(["bash", "delegate"]);
    const events: ExecutorEvent[] = [
      { type: "model.started", model: "openai/gpt-6-luna" },
      {
        type: "model.finished",
        model: "openai/gpt-6-luna",
        stopReason: "toolUse",
        usage,
        text: "I will list the files",
      },
      {
        type: "tool.started",
        toolCallId: "call_1",
        tool: "bash",
        summary: "ls -la /secret",
      },
      {
        type: "tool.started",
        // Not an id a provider gives: the model's text, kept out of the span.
        toolCallId: "call 2: cat /secret",
        tool: "made_up_tool",
        summary: "x",
      },
      {
        type: "tool.finished",
        toolCallId: "call_1",
        tool: "bash",
        summary: "ls -la /secret",
        ok: false,
        exitCode: 2,
        output: "ls: cannot access",
        truncated: false,
      },
      {
        type: "tool.finished",
        toolCallId: "call 2: cat /secret",
        tool: "made_up_tool",
        summary: "x",
        ok: false,
        truncated: false,
      },
      // A turn cut short by a stop: still open when the run ends.
      { type: "model.started", model: "openai/gpt-6-luna" },
      {
        type: "tool.started",
        toolCallId: "call_3",
        tool: "delegate",
        summary: "Grace",
      },
    ];
    for (const event of events) activity.observe(event);
    activity.end("cancelled");

    const spans = exporter.getFinishedSpans();
    const root = spans.find((span) => span.name === SPANS.sessionRun);
    expect(root?.attributes).toMatchObject({
      "jj.run.id": "run_1",
      "jj.outcome": "cancelled",
      "jj.model_calls": 1,
      "jj.tool_calls": 2,
      "gen_ai.usage.input_tokens": 120,
      "jj.cost_usd": 0.0004,
    });
    const children = spans.filter(
      (span) => span.parentSpanContext?.spanId === root?.spanContext().spanId,
    );
    expect(
      children.map((span) => [span.name, span.attributes["jj.outcome"]]),
    ).toEqual(
      expect.arrayContaining([
        [SPANS.modelTurn, "ok"],
        [SPANS.modelTurn, "interrupted"],
        [SPANS.toolCall, "error"],
        [SPANS.toolCall, "error"],
        [SPANS.toolCall, "interrupted"],
      ]),
    );
    expect(children).toHaveLength(5);
    const tools = children
      .filter((span) => span.name === SPANS.toolCall)
      .map((span) => span.attributes["gen_ai.tool.name"]);
    // A name the model made up is not a span attribute or a label.
    expect(tools.sort()).toEqual(["bash", "delegate", "other"]);
    // Call ids are kept only when they look like one.
    expect(
      children
        .filter((span) => span.name === SPANS.toolCall)
        .map((span) => span.attributes["gen_ai.tool.call.id"])
        .sort(),
    ).toEqual(["call_1", "call_3", undefined]);
    expect(
      children.find((span) => span.attributes["gen_ai.tool.name"] === "bash")
        ?.attributes["jj.tool.exit_code"],
    ).toBe(2);
    const text = await metrics.text();
    expect(text).not.toContain("made_up_tool");
    expect(
      sampleOf(
        text,
        'jj_tool_call_duration_seconds_count{tool="other",outcome="error"}',
      ),
    ).toBe(1);
    expect(
      sampleOf(
        text,
        'jj_tool_call_duration_seconds_count{tool="delegate",outcome="interrupted"}',
      ),
    ).toBe(1);
    for (const span of spans)
      for (const value of Object.values(span.attributes))
        expect(String(value)).not.toMatch(
          /secret|list the files|cannot access/,
        );
  });

  it("labels declared MCP tools mcp, so server-chosen names never become label values", () => {
    const activity = new ActivityTrace(
      tracer,
      createMetrics(),
      SPANS.sessionRun,
      {},
    );
    activity.declareTools(["bash"], ["mcp__docs__search"]);
    expect(activity.toolLabel("bash")).toBe("bash");
    expect(activity.toolLabel("mcp__docs__search")).toBe("mcp");
    expect(activity.toolLabel("mcp__docs__other")).toBe("other");
  });
});

describe("sandbox starts", () => {
  const spec = sandboxSpecSchema.parse({
    driver: "local",
    network: { mode: "open" },
    workspace: "task",
  });

  function sandboxes(driver: EngineDriver) {
    const metrics = createMetrics();
    const ctx = {
      config: resolveConfig({}),
      drivers: createDriverRegistry([{ driver, label: "Local" }]),
      logger: quietLogger,
      metrics,
      tracer,
    } as unknown as EngineContext;
    return {
      manager: new TaskSandboxes(ctx, { statuses: async () => new Map() }),
      metrics,
    };
  }

  it("are timed by driver and traced under the run, failures counted", async () => {
    const local = new LocalSandboxDriver();
    const failing: EngineDriver = {
      id: local.id,
      capabilities: local.capabilities,
      validateSpec: (value) => local.validateSpec(value),
      probe: () => local.probe(),
      acquire: async () => {
        throw new Error("the image could not be pulled");
      },
    };
    const broken = sandboxes(failing);
    const run = new ActivityTrace(tracer, broken.metrics, SPANS.sessionRun, {});
    await expect(
      broken.manager.acquire(
        "task_1",
        "sess_1",
        spec,
        undefined,
        undefined,
        run.context,
      ),
    ).rejects.toThrow(
      "The sandbox could not start: the image could not be pulled",
    );
    run.end("error", true);
    const text = await broken.metrics.text();
    expect(
      sampleOf(text, 'jj_sandbox_acquire_failures_total{driver="local"}'),
    ).toBe(1);
    expect(
      sampleOf(
        text,
        'jj_sandbox_acquire_duration_seconds_count{driver="local",outcome="error"}',
      ),
    ).toBe(1);
    const acquire = exporter
      .getFinishedSpans()
      .find((span) => span.name === SPANS.sandboxAcquire);
    expect(acquire?.attributes).toMatchObject({
      "jj.sandbox.driver": "local",
      "jj.task.id": "task_1",
      "jj.outcome": "error",
    });
    expect(acquire?.parentSpanContext?.spanId).toBe(
      run.span.spanContext().spanId,
    );

    const working = sandboxes(local);
    const hold = await working.manager.acquire("task_2", "sess_2", spec);
    // Held: a second run of the task starts nothing.
    const again = await working.manager.acquire("task_2", "sess_3", spec);
    hold.done();
    again.done();
    await working.manager.releaseAll();
    const ok = await working.metrics.text();
    expect(
      sampleOf(
        ok,
        'jj_sandbox_acquire_duration_seconds_count{driver="local",outcome="ok"}',
      ),
    ).toBe(1);
    expect(ok).not.toContain(
      'jj_sandbox_acquire_failures_total{driver="local"}',
    );
  });
});

describe("the worker's heartbeat", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = await openTestDatabase();
  }, OPEN_TIMEOUT);
  afterAll(async () => {
    await db.close();
  });

  const row = async (workerId: string) =>
    (
      await db.database.db
        .select()
        .from(workerHeartbeats)
        .where(eq(workerHeartbeats.workerId, workerId))
    )[0];

  it(
    "is recorded while the loop polls, removed on stop and left by a crash",
    async () => {
      const first = await testEngine(db.database);
      const id = first.engine.context.config.workerId;
      const beat = await until(() => row(id), { what: "a heartbeat row" });
      expect(beat.seenAt.getTime()).toBeGreaterThan(Date.now() - 60_000);
      await first.engine.worker.stop();
      expect(await row(id)).toBeUndefined();
      await first.dispose();

      const crashed = await testEngine(db.database);
      const crashedId = crashed.engine.context.config.workerId;
      await until(() => row(crashedId), { what: "a heartbeat row" });
      await crashed.engine.worker.abandon();
      expect(await row(crashedId)).toBeDefined();
      await crashed.dispose();
    },
    OPEN_TIMEOUT,
  );

  it(
    "is not recorded where no other process could read it (PGlite)",
    async () => {
      const engine = await testEngine(db.database, {
        config: { workerHeartbeat: false },
      });
      const id = engine.engine.context.config.workerId;
      // Polling, but no row.
      await until(() => engine.engine.worker.lastPollAt, {
        what: "a claim pass",
      });
      await until(
        async () =>
          engine.engine.worker.lastPollAt &&
          Date.now() - engine.engine.worker.lastPollAt.getTime() < 1_000,
      );
      expect(await row(id)).toBeUndefined();
      await engine.engine.worker.stop();
      await engine.dispose();
    },
    OPEN_TIMEOUT,
  );
});
