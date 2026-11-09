// OpenTelemetry spans for the engine's work: a session run (or a chat reply)
// with its model turns and tool calls as children, and the sandbox start.
// Spans are built with the API alone; without a tracer provider (no
// OTEL_EXPORTER_OTLP_ENDPOINT) they are no-ops. Parents are passed
// explicitly, so no global context manager is needed. Attributes are ids,
// names, counts, cost and outcomes only: never a prompt, a tool's arguments
// or output, or model text.
import {
  type Attributes,
  type Context,
  ROOT_CONTEXT,
  type Span,
  SpanStatusCode,
  type Tracer,
  trace,
} from "@opentelemetry/api";
import type { ExecutorEvent } from "../ports";
import { type EngineMetrics, modelLabels } from "./metrics";

export const SPANS = {
  sessionRun: "jj.session.run",
  chatReply: "jj.chat.reply",
  modelTurn: "jj.model.turn",
  toolCall: "jj.tool.call",
  sandboxAcquire: "jj.sandbox.acquire",
} as const;

/** Every attribute a JJ Bot span may carry. */
export const SPAN_ATTRIBUTES = [
  "jj.task.id",
  "jj.session.id",
  "jj.run.id",
  "jj.bot.id",
  "jj.job.id",
  "jj.session.role",
  "jj.run.reason",
  "jj.run.number",
  "jj.outcome",
  "jj.error.code",
  "jj.stop_reason",
  "jj.sandbox.driver",
  "jj.tool.exit_code",
  "jj.model_calls",
  "jj.tool_calls",
  "jj.cost_usd",
  "jj.unpriced_calls",
  "gen_ai.operation.name",
  "gen_ai.provider.name",
  "gen_ai.request.model",
  "gen_ai.tool.name",
  "gen_ai.tool.call.id",
  "gen_ai.usage.input_tokens",
  "gen_ai.usage.output_tokens",
  "gen_ai.usage.cache_read.input_tokens",
  "gen_ai.usage.cache_creation.input_tokens",
] as const;

export type SpanAttribute = (typeof SPAN_ATTRIBUTES)[number];
type SpanAttributes = Partial<Record<SpanAttribute, string | number>>;

/** A span under `parent` (none: a root span). */
export function startSpan(
  tracer: Tracer,
  name: string,
  attributes: SpanAttributes,
  parent: Context = ROOT_CONTEXT,
): Span {
  return tracer.startSpan(
    name,
    { attributes: attributes as Attributes },
    parent,
  );
}

/** Ends `span` with its outcome; `failed` marks it an error. */
export function endSpan(
  span: Span,
  outcome: string,
  failed = false,
  attributes: SpanAttributes = {},
) {
  span.setAttributes({ ...attributes, "jj.outcome": outcome } as Attributes);
  if (failed) span.setStatus({ code: SpanStatusCode.ERROR });
  span.end();
}

/**
 * A provider's tool call id (`call_…`, `toolu_…`): kept only when it looks
 * like one, since the model's response is where it comes from.
 */
const CALL_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

interface OpenTool {
  span: Span;
  tool: string;
  startedAt: number;
}

/**
 * One session run or chat reply as a span, with a child span per model turn
 * and per tool call built from the executor's events. Tool calls are timed
 * into `jj_tool_call_duration_seconds` too, under the tool's name when the
 * activity declared it, `mcp` for a declared MCP tool (whose names are the
 * servers'), else `other` (a model can call a tool that does not exist, and
 * its name is the model's text).
 */
export class ActivityTrace {
  readonly span: Span;
  readonly context: Context;
  private known: ReadonlySet<string> = new Set();
  private mcp: ReadonlySet<string> = new Set();
  private turn: Span | undefined;
  private readonly tools = new Map<string, OpenTool>();
  private readonly totals = {
    modelCalls: 0,
    toolCalls: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: 0,
    unpriced: 0,
  };
  private ended = false;

  constructor(
    private readonly tracer: Tracer,
    private readonly metrics: EngineMetrics,
    name: string,
    attributes: SpanAttributes,
  ) {
    this.span = startSpan(tracer, name, attributes);
    this.context = trace.setSpan(ROOT_CONTEXT, this.span);
  }

  /** The tools this activity offers its model, by name, and its MCP tools, labelled `mcp`. */
  declareTools(names: Iterable<string>, mcp: Iterable<string> = []) {
    this.known = new Set(names);
    this.mcp = new Set(mcp);
  }

  /** The tool's metric label and span name: its own when declared, `mcp` for a declared MCP tool, else `other`. */
  toolLabel(name: string): string {
    if (this.known.has(name)) return name;
    return this.mcp.has(name) ? "mcp" : "other";
  }

  observe(event: ExecutorEvent): void {
    if (this.ended) return;
    switch (event.type) {
      case "model.started": {
        this.turn?.end();
        const model = event.model ? modelLabels(event.model) : undefined;
        this.turn = startSpan(
          this.tracer,
          SPANS.modelTurn,
          {
            "gen_ai.operation.name": "chat",
            ...(model
              ? {
                  "gen_ai.provider.name": model.provider,
                  "gen_ai.request.model": model.model,
                }
              : {}),
          },
          this.context,
        );
        return;
      }
      case "model.finished": {
        const model = modelLabels(event.model);
        const span =
          this.turn ??
          startSpan(this.tracer, SPANS.modelTurn, {}, this.context);
        this.turn = undefined;
        const { usage } = event;
        this.totals.modelCalls += 1;
        this.totals.input += usage.inputTokens;
        this.totals.output += usage.outputTokens;
        this.totals.cacheRead += usage.cacheReadTokens;
        this.totals.cacheWrite += usage.cacheWriteTokens;
        this.totals.cost += usage.costUsd;
        this.totals.unpriced += usage.unpricedCalls;
        const failed = event.stopReason === "error";
        endSpan(span, failed ? "error" : "ok", failed, {
          "gen_ai.operation.name": "chat",
          "gen_ai.provider.name": model.provider,
          "gen_ai.request.model": model.model,
          "gen_ai.usage.input_tokens": usage.inputTokens,
          "gen_ai.usage.output_tokens": usage.outputTokens,
          "gen_ai.usage.cache_read.input_tokens": usage.cacheReadTokens,
          "gen_ai.usage.cache_creation.input_tokens": usage.cacheWriteTokens,
          "jj.cost_usd": usage.costUsd,
          "jj.unpriced_calls": usage.unpricedCalls,
          "jj.stop_reason": event.stopReason,
        });
        return;
      }
      case "tool.started": {
        const tool = this.toolLabel(event.tool);
        this.tools.get(event.toolCallId)?.span.end();
        this.tools.set(event.toolCallId, {
          tool,
          startedAt: performance.now(),
          span: startSpan(
            this.tracer,
            SPANS.toolCall,
            {
              "gen_ai.tool.name": tool,
              ...(CALL_ID.test(event.toolCallId)
                ? { "gen_ai.tool.call.id": event.toolCallId }
                : {}),
            },
            this.context,
          ),
        });
        return;
      }
      case "tool.finished": {
        const open = this.tools.get(event.toolCallId);
        if (!open) return;
        this.tools.delete(event.toolCallId);
        this.totals.toolCalls += 1;
        const outcome = event.ok ? "ok" : "error";
        this.metrics.toolCall(
          open.tool,
          outcome,
          (performance.now() - open.startedAt) / 1000,
        );
        endSpan(
          open.span,
          outcome,
          !event.ok,
          typeof event.exitCode === "number"
            ? { "jj.tool.exit_code": event.exitCode }
            : {},
        );
      }
    }
  }

  /** Token and cost totals of the model turns so far. */
  get usage() {
    return { ...this.totals };
  }

  /**
   * Ends the activity's span with `outcome`. A turn or tool call still open
   * (the run was stopped or failed during it) ends as `interrupted`.
   */
  end(outcome: string, failed = false, attributes: SpanAttributes = {}) {
    if (this.ended) return;
    this.ended = true;
    if (this.turn) endSpan(this.turn, "interrupted", true);
    this.turn = undefined;
    for (const open of this.tools.values()) {
      this.metrics.toolCall(
        open.tool,
        "interrupted",
        (performance.now() - open.startedAt) / 1000,
      );
      endSpan(open.span, "interrupted", true);
    }
    this.tools.clear();
    endSpan(this.span, outcome, failed, {
      ...attributes,
      "jj.model_calls": this.totals.modelCalls,
      "jj.tool_calls": this.totals.toolCalls,
      "gen_ai.usage.input_tokens": this.totals.input,
      "gen_ai.usage.output_tokens": this.totals.output,
      "gen_ai.usage.cache_read.input_tokens": this.totals.cacheRead,
      "gen_ai.usage.cache_creation.input_tokens": this.totals.cacheWrite,
      "jj.cost_usd": this.totals.cost,
      "jj.unpriced_calls": this.totals.unpriced,
    });
  }
}
