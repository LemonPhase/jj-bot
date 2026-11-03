// Observability end to end: JSON log lines with request, task, session and
// run ids and every secret redacted; the span tree of a scripted task, with
// no content in any attribute; `GET /metrics` behind the token, with bounded
// labels; and trace export over OTLP only when its endpoint is set.
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createLogger, SPAN_ATTRIBUTES, SPANS } from "@jj/backend";
import { runs, taskEvents } from "@jj/db";
import {
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { eq } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createApp } from "./app";
import { secretKeys } from "./config";
import { type RunningServer, startServer } from "./server";
import {
  createBots,
  OPEN_TIMEOUT,
  quietLogger,
  type TestApp,
  testApp,
  until,
  untilTask,
} from "./testing";
import { startTracing, tracesUrl } from "./tracing";

const PROVIDER_KEY = "sk-observability-0123456789abcdefghij";
const API_TOKEN = "observability-api-token-0123456789";
const STORED = "ghp_storedSecretValue0123456789abcdef";
const REPLACED = "ghp_replacementSecret0123456789abcdef";
const GOAL = "Write notes about albatross migration routes";

type Line = Record<string, any>;

/** A JSON logger at debug whose lines land in `lines`. */
function capturingLogger() {
  const lines: Line[] = [];
  const raw: string[] = [];
  const logger = createLogger({
    level: "debug",
    write: (line) => {
      raw.push(line);
      lines.push(JSON.parse(line));
    },
  });
  return { logger, lines, raw };
}

const exporter = new InMemorySpanExporter();
const provider = new TracerProvider({
  spanProcessors: [new SimpleSpanProcessor({ exporter })],
});
const log = capturingLogger();
let t: TestApp;
let taskId: string;
let adaId: string;

beforeAll(async () => {
  t = await testApp({
    logger: log.logger,
    tracer: provider.getTracer("test"),
    // The key only configures a provider no bot uses: every bot is scripted.
    env: {
      OPENAI_API_KEY: PROVIDER_KEY,
      API_TOKEN,
      JJ_DEFAULT_MODEL: "scripted/team",
    },
    secretKeys: secretKeys({
      JJ_SECRET_KEY: randomBytes(32).toString("base64"),
    }),
  });
  const ada = await t.call("POST", "/api/bots", {
    name: "Ada",
    model: "scripted/team",
  });
  // A priced model, so the worker's runs have a cost.
  const grace = await t.call("POST", "/api/bots", {
    name: "Grace",
    model: "scripted/team-priced",
  });
  const created = await t.call("POST", "/api/tasks", {
    goal: GOAL,
    coordinatorBotId: ada.body.bot.id,
    participantBotIds: [grace.body.bot.id],
  });
  expect(created.status).toBe(201);
  taskId = created.body.task.id;
  adaId = ada.body.bot.id;
  await untilTask(t, taskId, (view) => view.task.status === "completed");
}, OPEN_TIMEOUT);
afterAll(async () => {
  await t?.dispose();
  await provider.shutdown();
});

describe("the log", () => {
  it("is one JSON object per line, and a request's lines carry its id", async () => {
    expect(log.raw.length).toBeGreaterThan(0);
    for (const line of log.raw) expect(() => JSON.parse(line)).not.toThrow();
    const response = await t.app.request("/api/bots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Linus" }),
    });
    expect(response.status).toBe(201);
    const requestId = response.headers.get("X-Request-Id");
    expect(requestId).toMatch(/^req_[A-Za-z0-9_-]{16}$/);
    expect(log.lines).toContainEqual(
      expect.objectContaining({
        level: "info",
        msg: "POST /api/bots 201",
        requestId,
        method: "POST",
        path: "/api/bots",
        status: 201,
        durationMs: expect.any(Number),
      }),
    );
  });

  it("is the engine's own log for an app given none", async () => {
    const app = createApp({
      engine: t.engine,
      config: { workerEmbedded: true },
    });
    const response = await app.request("/api/nothing-here");
    expect(response.status).toBe(404);
    expect(log.lines).toContainEqual(
      expect.objectContaining({
        msg: "GET /api/nothing-here 404",
        requestId: response.headers.get("X-Request-Id"),
      }),
    );
  });

  it("keeps a proxy's well-formed X-Request-Id and replaces anything else", async () => {
    const kept = await t.app.request("/api/nope", {
      headers: { "X-Request-Id": "edge-7f3a.1" },
    });
    expect(kept.headers.get("X-Request-Id")).toBe("edge-7f3a.1");
    expect(log.lines).toContainEqual(
      expect.objectContaining({
        msg: "GET /api/nope 404",
        requestId: "edge-7f3a.1",
      }),
    );
    const replaced = await t.app.request("/health", {
      headers: { "X-Request-Id": "not an id; DROP TABLE" },
    });
    expect(replaced.headers.get("X-Request-Id")).toMatch(/^req_/);
  });

  it("gives every line of a run its task, session and run ids", async () => {
    const rows = await t.database.db
      .select({ id: runs.id, sessionId: runs.sessionId })
      .from(runs)
      .where(eq(runs.taskId, taskId));
    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows)
      for (const msg of ["Session run started", "Session run finished"])
        expect(log.lines, msg).toContainEqual(
          expect.objectContaining({
            msg,
            taskId,
            sessionId: row.sessionId,
            runId: row.id,
            jobId: expect.stringMatching(/^job_/),
          }),
        );
    const finished = log.lines.find(
      (line) =>
        line.msg === "Session run finished" && line.runId === rows[0]?.id,
    );
    expect(finished).toMatchObject({
      outcome: "ended",
      durationMs: expect.any(Number),
      modelCalls: expect.any(Number),
    });
    // Debug lines of the run's model and tool calls carry the ids too.
    for (const msg of ["Model call finished", "Tool call finished"])
      expect(
        log.lines.some(
          (line) => line.msg === msg && line.taskId === taskId && line.runId,
        ),
        msg,
      ).toBe(true);
    // Only their own: the request that created the task woke the worker, but
    // its runs are not that request's.
    const ofRuns = log.lines.filter((line) => line.runId);
    expect(ofRuns.length).toBeGreaterThan(0);
    for (const line of ofRuns) {
      expect(line.requestId, line.msg).toBeUndefined();
      expect(
        rows.map((entry) => entry.id),
        line.msg,
      ).toContain(line.runId);
    }
  });

  it("redacts provider keys, the API token, stored and replaced secrets from every line", async () => {
    expect(
      (await t.call("PUT", "/api/secrets/GH_TOKEN", { value: STORED })).status,
    ).toBe(201);
    expect(
      (await t.call("PUT", "/api/secrets/GH_TOKEN", { value: REPLACED }))
        .status,
    ).toBe(200);
    // A failure whose message holds every secret: the stack goes to the log.
    const list = t.engine.bots.list;
    t.engine.bots.list = async () => {
      throw new Error(
        `upstream said ${PROVIDER_KEY} / ${API_TOKEN} / ${STORED} / ${REPLACED}`,
      );
    };
    try {
      const response = await t.app.request("/api/bots");
      expect(response.status).toBe(500);
      const requestId = response.headers.get("X-Request-Id");
      const failure = log.lines.find(
        (line) => line.level === "error" && line.requestId === requestId,
      );
      expect(failure?.msg).toBe("GET /api/bots failed");
      expect(failure?.error).toContain(
        "upstream said [redacted] / [redacted] / [redacted] / [redacted]",
      );
    } finally {
      t.engine.bots.list = list;
    }
    const all = log.raw.join("\n");
    for (const secret of [PROVIDER_KEY, API_TOKEN, STORED, REPLACED])
      expect(all).not.toContain(secret);
  });
});

describe("traces", () => {
  const spans = () => exporter.getFinishedSpans();
  const ofTask = () =>
    spans().filter(
      (span) =>
        span.name === SPANS.sessionRun &&
        span.attributes["jj.task.id"] === taskId,
    );
  const parentOf = (span: ReadableSpan) => span.parentSpanContext?.spanId;

  it("has a span per session run, with its sandbox start, model turns and tool calls as children", async () => {
    const rows = await t.database.db
      .select()
      .from(runs)
      .where(eq(runs.taskId, taskId));
    const runSpans = ofTask();
    expect(runSpans.map((span) => span.attributes["jj.run.id"]).sort()).toEqual(
      rows.map((row) => row.id).sort(),
    );
    for (const span of runSpans) {
      const row = rows.find(
        (entry) => entry.id === span.attributes["jj.run.id"],
      );
      expect(span.attributes).toMatchObject({
        "jj.session.id": row?.sessionId,
        "jj.outcome": "ended",
        "jj.session.role": expect.stringMatching(/^(coordinator|worker)$/),
        "jj.run.reason": row?.reason,
      });
      expect(parentOf(span)).toBeUndefined();
      const children = spans().filter(
        (child) => parentOf(child) === span.spanContext().spanId,
      );
      const turns = children.filter((child) => child.name === SPANS.modelTurn);
      expect(turns.length, "model turns").toBeGreaterThan(0);
      expect(span.attributes["jj.model_calls"]).toBe(turns.length);
      for (const turn of turns)
        expect(turn.attributes).toMatchObject({
          "gen_ai.provider.name": "scripted",
          "gen_ai.request.model": expect.stringMatching(/^team/),
          "gen_ai.usage.input_tokens": expect.any(Number),
          "jj.outcome": "ok",
        });
      const tools = children.filter((child) => child.name === SPANS.toolCall);
      expect(span.attributes["jj.tool_calls"]).toBe(tools.length);
      for (const tool of tools)
        expect(tool.attributes["gen_ai.tool.name"]).not.toBe("other");
    }
    // Every session made tool calls (delegate, write, complete_task, …).
    const toolNames = spans()
      .filter((span) => span.name === SPANS.toolCall)
      .map((span) => span.attributes["gen_ai.tool.name"]);
    expect(toolNames).toEqual(
      expect.arrayContaining(["delegate", "complete_task"]),
    );
    // The task's one sandbox started under the run that needed it first.
    const acquires = spans().filter(
      (span) =>
        span.name === SPANS.sandboxAcquire &&
        span.attributes["jj.task.id"] === taskId,
    );
    expect(acquires).toHaveLength(1);
    expect(acquires[0]?.attributes).toMatchObject({
      "jj.sandbox.driver": "local",
      "jj.outcome": "ok",
    });
    expect(runSpans.map((span) => span.spanContext().spanId)).toContain(
      acquires[0] && parentOf(acquires[0]),
    );
    // The priced worker's cost is on its turns and its run.
    expect(
      runSpans.some((span) => Number(span.attributes["jj.cost_usd"]) > 0),
    ).toBe(true);
  });

  it("carries only the listed attributes, and no prompt, argument, output or model text", async () => {
    const events = await t.database.db
      .select({ payload: taskEvents.payload })
      .from(taskEvents)
      .where(eq(taskEvents.taskId, taskId));
    // What the task's events say in words: tool summaries (a tool without
    // one is summarized by its name), outputs and model text.
    const content = events.flatMap(({ payload }) => {
      const { summary, output, text, tool } = payload as Record<
        string,
        unknown
      >;
      return [summary === tool ? undefined : summary, output, text].filter(
        (value): value is string =>
          typeof value === "string" && value.length >= 8,
      );
    });
    expect(content.length).toBeGreaterThan(0);
    const allowed = new Set<string>(SPAN_ATTRIBUTES);
    for (const span of spans()) {
      for (const [key, value] of Object.entries(span.attributes)) {
        expect(allowed.has(key), `${span.name} ${key}`).toBe(true);
        if (typeof value !== "string") continue;
        expect(value).not.toContain("albatross");
        expect(value).not.toContain("notes-");
        for (const text of content) expect(value).not.toContain(text);
      }
    }
  });
});

describe("GET /metrics", () => {
  const sample = (
    text: string,
    name: string,
    labels: Record<string, string>,
  ) => {
    const want = Object.entries(labels).map(
      ([key, value]) => `${key}="${value}"`,
    );
    const line = text
      .split("\n")
      .find(
        (entry) =>
          entry.startsWith(`${name}{`) &&
          want.every((label) => entry.includes(label)),
      );
    return line === undefined ? undefined : Number(line.split(" ").at(-1));
  };

  it("reports the task's runs, tools, tokens, cost, claims and sandbox start", async () => {
    const response = await t.app.request("/metrics");
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/plain");
    const text = await response.text();
    const positive: [string, Record<string, string>][] = [
      [
        "jj_session_run_duration_seconds_count",
        { role: "coordinator", outcome: "ended" },
      ],
      [
        "jj_session_run_duration_seconds_count",
        { role: "worker", outcome: "ended" },
      ],
      [
        "jj_tool_call_duration_seconds_count",
        { tool: "delegate", outcome: "ok" },
      ],
      ["jj_model_calls_total", { provider: "scripted", model: "team" }],
      [
        "jj_model_tokens_total",
        { provider: "scripted", model: "team", type: "input" },
      ],
      [
        "jj_model_tokens_total",
        { provider: "scripted", model: "team-priced", type: "output" },
      ],
      [
        "jj_model_cost_usd_total",
        { provider: "scripted", model: "team-priced" },
      ],
      [
        "jj_model_unpriced_calls_total",
        { provider: "scripted", model: "team" },
      ],
      ["jj_queue_claim_latency_seconds_count", { kind: "session.run" }],
      [
        "jj_sandbox_acquire_duration_seconds_count",
        { driver: "local", outcome: "ok" },
      ],
    ];
    for (const [name, labels] of positive)
      expect(
        sample(text, name, labels),
        `${name} ${JSON.stringify(labels)}`,
      ).toBeGreaterThan(0);
    expect(sample(text, "jj_queue_depth", { kind: "session.run" })).toBe(0);
    expect(text).toMatch(/^jj_worker_active_jobs \d+$/m);
    // The process's own metrics are the server's to add (startServer), not a test engine's.
    expect(text).not.toContain("process_cpu_seconds_total");
  });

  it("has no id among its label values", async () => {
    const text = await (await t.app.request("/metrics")).text();
    const values = [...text.matchAll(/="([^"]*)"/g)].map((match) => match[1]);
    expect(values.length).toBeGreaterThan(0);
    for (const value of values)
      expect(value).not.toMatch(/^(task|sess|run|bot|job|usage|req)_/);
    expect(text).not.toContain(taskId);
  });

  // It opens a database of its own, so it gets the opening budget.
  it(
    "counts queued jobs no worker has claimed",
    async () => {
      const idle = await testApp({ startWorker: false });
      try {
        const [ada] = Object.values(await createBots(idle, ["Ada"]));
        await idle.call("POST", "/api/tasks", {
          goal: "Wait",
          coordinatorBotId: ada,
        });
        const text = await (await idle.app.request("/metrics")).text();
        expect(sample(text, "jj_queue_depth", { kind: "session.run" })).toBe(1);
        expect(sample(text, "jj_queue_depth", { kind: "chat.reply" })).toBe(0);
      } finally {
        await idle.dispose();
      }
    },
    OPEN_TIMEOUT,
  );

  it("is behind the API token like /api, and never served as a page", async () => {
    const guarded = createApp({
      engine: t.engine,
      config: { workerEmbedded: true, apiToken: API_TOKEN, webDist: null },
      logger: quietLogger,
    });
    expect((await guarded.request("/metrics")).status).toBe(401);
    expect(
      (
        await guarded.request("/metrics", {
          headers: { Authorization: "Bearer wrong" },
        })
      ).status,
    ).toBe(401);
    const allowed = await guarded.request("/metrics", {
      headers: { Authorization: `Bearer ${API_TOKEN}` },
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.text()).toContain("jj_session_run_duration_seconds");
    // Without a token, the same Host check as /api.
    expect((await t.app.request("http://evil.example/metrics")).status).toBe(
      403,
    );
    expect(
      (
        await t.app.request("/metrics", {
          headers: { "Sec-Fetch-Site": "cross-site" },
        })
      ).status,
    ).toBe(403);
  });
});

describe("a chat reply", () => {
  it("is a span with its model turns and tool calls, and logged with the bot's id", async () => {
    const sent = await t.call("POST", `/api/bots/${adaId}/messages`, {
      text: "What is the status of my tasks?",
    });
    expect(sent.status).toBe(201);
    const reply = await until(
      () => {
        const done = exporter
          .getFinishedSpans()
          .filter(
            (span) =>
              span.name === SPANS.chatReply &&
              span.attributes["jj.bot.id"] === adaId &&
              span.attributes["jj.task.id"] === undefined,
          );
        return done.at(-1);
      },
      { what: "the reply's span" },
    );
    expect(reply.attributes).toMatchObject({
      "jj.outcome": "ok",
      "jj.job.id": expect.stringMatching(/^job_/),
      "jj.model_calls": 2,
      "jj.tool_calls": 1,
    });
    const children = exporter
      .getFinishedSpans()
      .filter(
        (span) => span.parentSpanContext?.spanId === reply.spanContext().spanId,
      );
    expect(children.map((span) => span.name).sort()).toEqual([
      SPANS.modelTurn,
      SPANS.modelTurn,
      SPANS.toolCall,
    ]);
    expect(
      children.find((span) => span.name === SPANS.toolCall)?.attributes[
        "gen_ai.tool.name"
      ],
    ).toBe("list_tasks");
    expect(log.lines).toContainEqual(
      expect.objectContaining({
        msg: "Chat reply finished",
        botId: adaId,
        jobId: reply.attributes["jj.job.id"],
        outcome: "ok",
        modelCalls: 2,
      }),
    );
    // The reply's lines carry its job and bot, and not the ids of the
    // request that sent the message or of a run that woke the loop.
    const ofJob = log.lines.filter(
      (line) => line.jobId === reply.attributes["jj.job.id"],
    );
    expect(ofJob.length).toBeGreaterThanOrEqual(2);
    for (const line of ofJob) {
      expect(line.botId).toBe(adaId);
      for (const key of ["requestId", "taskId", "sessionId", "runId"])
        expect(line[key], `${line.msg} ${key}`).toBeUndefined();
    }
    const text = await (await t.app.request("/metrics")).text();
    expect(text).toMatch(
      /^jj_tool_call_duration_seconds_count\{tool="list_tasks",outcome="ok"\} [1-9]/m,
    );
  });
});

describe("trace export", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads no SDK and creates no exporter without OTEL_EXPORTER_OTLP_ENDPOINT", async () => {
    const load = vi.fn();
    expect(
      await startTracing(
        { OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://127.0.0.1:1/v1/traces" },
        "jj-api",
        quietLogger,
        { load },
      ),
    ).toBeUndefined();
    expect(load).not.toHaveBeenCalled();
    expect(tracesUrl({})).toBeUndefined();
    expect(
      tracesUrl({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/" }),
    ).toBe("http://collector:4318/v1/traces");
  });

  describe("to a collector that is down", () => {
    /** Starts tracing to `url`, ends one span and times the shutdown. */
    async function shutDownAgainst(url: string) {
      const warnings: string[] = [];
      const tracing = await startTracing(
        { OTEL_EXPORTER_OTLP_ENDPOINT: url },
        "jj-api",
        { ...quietLogger, warn: (message) => warnings.push(message) },
        { exportTimeoutMs: 300 },
      );
      if (!tracing) throw new Error("no tracing");
      tracing.tracer.startSpan(SPANS.sessionRun).end();
      const started = Date.now();
      await expect(tracing.shutdown()).resolves.toBeUndefined();
      return { ms: Date.now() - started, warnings };
    }

    it("neither fails nor holds up the shutdown when it refuses connections", async () => {
      const closed = createServer();
      await new Promise<void>((resolve) =>
        closed.listen(0, "127.0.0.1", resolve),
      );
      const { port } = closed.address() as AddressInfo;
      await new Promise((resolve) => closed.close(resolve));
      const { ms, warnings } = await shutDownAgainst(
        `http://127.0.0.1:${port}`,
      );
      expect(ms).toBeLessThan(2_000);
      expect(warnings.join("\n")).toMatch(/Trace export|Flushing the traces/);
    });

    it("gives up on it after the export timeout when it never answers", async () => {
      const sockets = new Set<import("node:net").Socket>();
      const silent = createServer(() => {});
      silent.on("connection", (socket) => sockets.add(socket));
      await new Promise<void>((resolve) =>
        silent.listen(0, "127.0.0.1", resolve),
      );
      const { port } = silent.address() as AddressInfo;
      try {
        const { ms, warnings } = await shutDownAgainst(
          `http://127.0.0.1:${port}`,
        );
        expect(ms).toBeLessThan(2_000);
        expect(warnings.length).toBeGreaterThan(0);
      } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => silent.close(resolve));
      }
    });
  });

  describe("with OTEL_EXPORTER_OTLP_ENDPOINT", () => {
    let collector: Server;
    let server: RunningServer | undefined;
    const received: { headers: Record<string, unknown>; body: any }[] = [];

    beforeAll(async () => {
      collector = createServer((request, response) => {
        let body = "";
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          if (request.url === "/v1/traces")
            received.push({ headers: request.headers, body: JSON.parse(body) });
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end("{}");
        });
      });
      await new Promise<void>((resolve) =>
        collector.listen(0, "127.0.0.1", resolve),
      );
    });
    afterAll(async () => {
      await server?.close();
      await new Promise((resolve) => collector.close(resolve));
    });

    it(
      "exports the server's spans over OTLP/HTTP, flushing them at shutdown",
      async () => {
        const { port } = collector.address() as AddressInfo;
        server = await startServer({
          logger: quietLogger,
          env: {
            API_PORT: "0",
            JJ_DATABASE_PATH: "memory://",
            JJ_SANDBOX_DRIVERS: "local",
            JJ_ENABLE_SCRIPTED_MODEL: "true",
            OTEL_EXPORTER_OTLP_ENDPOINT: `http://127.0.0.1:${port}`,
            OTEL_EXPORTER_OTLP_HEADERS:
              "x-collector-key=collector-key-0123456789abcdef",
            OTEL_EXPORTER_OTLP_TRACES_HEADERS:
              "x-traces-key=traces-key-0123456789abcdef",
          },
        });
        expect(server.tracing?.url).toBe(`http://127.0.0.1:${port}/v1/traces`);
        // The collector's keys are secrets like the others.
        expect(await server.services.secrets()).toEqual(
          expect.arrayContaining([
            {
              name: "OTEL_EXPORTER_OTLP_HEADERS",
              value: "collector-key-0123456789abcdef",
            },
            {
              name: "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
              value: "traces-key-0123456789abcdef",
            },
          ]),
        );
        const call = async (method: string, path: string, body?: unknown) =>
          (
            await fetch(`${server?.url}${path}`, {
              method,
              headers: { "Content-Type": "application/json" },
              body: body === undefined ? undefined : JSON.stringify(body),
            })
          ).json() as Promise<any>;
        const { bot } = await call("POST", "/api/bots", { name: "Ada" });
        const { task } = await call("POST", "/api/tasks", {
          goal: "Write one note",
          coordinatorBotId: bot.id,
        });
        const deadline = Date.now() + 30_000;
        while (
          (await call("GET", `/api/tasks/${task.id}`)).task.status !==
          "completed"
        ) {
          if (Date.now() > deadline)
            throw new Error("The task did not complete");
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        await server.close();
        server = undefined;
        const names = received.flatMap(({ body }) =>
          body.resourceSpans.flatMap((resource: any) =>
            resource.scopeSpans.flatMap((scope: any) =>
              scope.spans.map((span: any) => span.name),
            ),
          ),
        );
        expect(names).toEqual(
          expect.arrayContaining([
            SPANS.sessionRun,
            SPANS.modelTurn,
            SPANS.toolCall,
          ]),
        );
        expect(received[0]?.headers["x-collector-key"]).toBe(
          "collector-key-0123456789abcdef",
        );
        expect(received[0]?.headers["x-traces-key"]).toBe(
          "traces-key-0123456789abcdef",
        );
        const service =
          received[0]?.body.resourceSpans[0].resource.attributes.find(
            (attribute: any) => attribute.key === "service.name",
          );
        expect(service?.value.stringValue).toBe("jj-api");
      },
      OPEN_TIMEOUT,
    );
  });
});
