// The engine's Prometheus metrics, one registry per engine, served by the API
// as `GET /metrics`. Every label takes a bounded set of values: job kinds,
// session roles, outcomes, tool names the run declared (else `other`),
// catalog models and registered drivers. Never a task, session, bot or run
// id. Uses @prometheus-io/client (formerly prom-client), which keeps the text
// format, histogram buckets and the process's own metrics correct.
import type { ModelRef, Usage } from "@jj/contracts";
import type { JobKind } from "@jj/db";
import {
  Counter,
  collectDefaultMetrics,
  Gauge,
  Histogram,
  Registry,
} from "@prometheus-io/client";

/** Outcomes a session run, model turn or tool call is counted under. */
export type Outcome = string;

export interface MetricSources {
  /** Jobs queued and due, by kind. */
  queueDepth(): Promise<Partial<Record<JobKind, number>>>;
  /** Jobs this process's worker runs right now. */
  activeJobs(): number;
}

export interface EngineMetrics {
  readonly contentType: string;
  /** The exposition text. */
  text(): Promise<string>;
  /** Where the gauges read their values at each scrape. */
  track(sources: MetricSources): void;
  /** A job's first claim, `seconds` after it became due. */
  claimed(kind: JobKind, seconds: number): void;
  sessionRun(role: string, outcome: Outcome, seconds: number): void;
  toolCall(tool: string, outcome: Outcome, seconds: number): void;
  modelCall(model: ModelRef, usage: Usage): void;
  sandboxAcquire(driver: string, outcome: Outcome, seconds: number): void;
}

export interface MetricsOptions {
  /** The process's CPU, memory, event loop and GC metrics too (for the server and worker processes). */
  processMetrics?: boolean;
  /** Reports a failed gauge read (the database is down); the scrape still answers. */
  onError?: (what: string, error: unknown) => void;
}

/** `provider/model` as its two labels. */
export function modelLabels(model: ModelRef): {
  provider: string;
  model: string;
} {
  const slash = model.indexOf("/");
  return slash > 0
    ? { provider: model.slice(0, slash), model: model.slice(slash + 1) }
    : { provider: "unknown", model };
}

const JOB_KINDS: readonly JobKind[] = [
  "session.run",
  "chat.reply",
  "mcp.discover",
];

export function createMetrics(options: MetricsOptions = {}): EngineMetrics {
  const registry = new Registry();
  if (options.processMetrics) collectDefaultMetrics({ register: registry });
  let sources: MetricSources | undefined;

  new Gauge({
    name: "jj_queue_depth",
    help: "Jobs queued and due, by kind (all workers).",
    labelNames: ["kind"],
    registers: [registry],
    async collect() {
      if (!sources) return;
      try {
        const depth = await sources.queueDepth();
        for (const kind of JOB_KINDS) this.set({ kind }, depth[kind] ?? 0);
      } catch (error) {
        options.onError?.("the queue depth", error);
      }
    },
  });
  new Gauge({
    name: "jj_worker_active_jobs",
    help: "Jobs this process's worker is running.",
    registers: [registry],
    collect() {
      if (sources) this.set(sources.activeJobs());
    },
  });
  const claims = new Histogram({
    name: "jj_queue_claim_latency_seconds",
    help: "Time from a job becoming due to its first claim.",
    labelNames: ["kind"],
    buckets: [0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
    registers: [registry],
  });
  const runs = new Histogram({
    name: "jj_session_run_duration_seconds",
    help: "Session runs, from their start to their outcome.",
    labelNames: ["role", "outcome"],
    buckets: [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300, 600, 1800],
    registers: [registry],
  });
  const tools = new Histogram({
    name: "jj_tool_call_duration_seconds",
    help: "Tool calls of session runs and chat replies.",
    labelNames: ["tool", "outcome"],
    buckets: [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 120, 600],
    registers: [registry],
  });
  const modelCalls = new Counter({
    name: "jj_model_calls_total",
    help: "Model calls, compactions included.",
    labelNames: ["provider", "model"],
    registers: [registry],
  });
  const tokens = new Counter({
    name: "jj_model_tokens_total",
    help: "Tokens of model calls, by type (input, output, cache_read, cache_write).",
    labelNames: ["provider", "model", "type"],
    registers: [registry],
  });
  const cost = new Counter({
    name: "jj_model_cost_usd_total",
    help: "Listed cost of model calls in US dollars; calls on unpriced models add 0.",
    labelNames: ["provider", "model"],
    registers: [registry],
  });
  const unpriced = new Counter({
    name: "jj_model_unpriced_calls_total",
    help: "Model calls on a model with no listed price, whose cost is unknown.",
    labelNames: ["provider", "model"],
    registers: [registry],
  });
  const acquires = new Histogram({
    name: "jj_sandbox_acquire_duration_seconds",
    help: "Sandbox starts, by driver and outcome.",
    labelNames: ["driver", "outcome"],
    buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120],
    registers: [registry],
  });
  const acquireFailures = new Counter({
    name: "jj_sandbox_acquire_failures_total",
    help: "Sandbox starts that failed, by driver.",
    labelNames: ["driver"],
    registers: [registry],
  });

  return {
    contentType: registry.contentType,
    text: () => registry.metrics(),
    track(next) {
      sources = next;
    },
    claimed(kind, seconds) {
      claims.observe({ kind }, Math.max(0, seconds));
    },
    sessionRun(role, outcome, seconds) {
      runs.observe({ role, outcome }, seconds);
    },
    toolCall(tool, outcome, seconds) {
      tools.observe({ tool, outcome }, seconds);
    },
    modelCall(ref, usage) {
      const labels = modelLabels(ref);
      modelCalls.inc(labels);
      const counts = [
        ["input", usage.inputTokens],
        ["output", usage.outputTokens],
        ["cache_read", usage.cacheReadTokens],
        ["cache_write", usage.cacheWriteTokens],
      ] as const;
      for (const [type, value] of counts)
        tokens.inc({ ...labels, type }, Math.max(0, value || 0));
      cost.inc(labels, Math.max(0, usage.costUsd || 0));
      if (usage.unpricedCalls > 0) unpriced.inc(labels, usage.unpricedCalls);
    },
    sandboxAcquire(driver, outcome, seconds) {
      acquires.observe({ driver, outcome }, seconds);
      if (outcome === "error") acquireFailures.inc({ driver });
    },
  };
}
