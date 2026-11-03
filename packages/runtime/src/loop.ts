import {
  type AgentContext,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentMessage,
  type AgentTool,
  runAgentLoop,
  runAgentLoopContinue,
  runToolCall,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
  type Api,
  type AssistantMessage,
  createInitialSystemMessage,
  type ImageContent,
  type Message,
  type Model,
  type Usage as PiUsage,
  type RetryPolicy,
  type TextContent,
  type ToolCall,
  type ToolResultMessage,
  toToolDeclaration,
  type UserMessage,
  validateToolArguments,
} from "@earendil-works/pi-ai";
import {
  type ModelRef,
  TOOL_OUTPUT_PREVIEW_LIMIT,
  type Usage,
} from "@jj/contracts";
import {
  type ContextCompactor,
  compactionOffNote,
  cutByContext,
} from "./compaction";
import {
  classifyErrorText,
  classifyModelError,
  OUTPUT_CUT_BY_CONTEXT,
  type RunErrorCode,
  redactSecrets,
  retryingStreamFn,
  streamOf,
} from "./errors";
import type { ModelCallGate } from "./gate";
import { type McpToolBinding, summarizeMcpCall } from "./mcp/adapter";
import type { ResolvedModel } from "./models";
import {
  finalizeResult,
  isSandboxReleased,
  type OutputPolicy,
  type ToolCallDetails,
} from "./tools";
import { interruptedResult, repairTranscript } from "./transcript";
import type {
  CollabTool,
  ExecutorEvent,
  PendingToolCall,
  PiMessage,
  RunOutcome,
  ToolCallVerdict,
  TranscriptEntry,
  TurnCall,
} from "./types";

/** Largest delay a Node timer represents. */
const MAX_TIMER_MS = 2_147_483_647;

export const userMessage = (text: string): UserMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp: Date.now(),
});

export const assistantText = (message: AssistantMessage): string =>
  message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();

const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

const count = (value: number) => Math.max(0, Math.round(value || 0));

/**
 * True when the catalog lists a price for the model. Without one pi reports
 * a cost of 0, which may be free or unknown: such calls are counted as
 * unpriced, never as costing nothing.
 */
export const hasListedPrice = (model: Pick<Model<Api>, "cost">): boolean =>
  model.cost.input > 0 ||
  model.cost.output > 0 ||
  model.cost.cacheRead > 0 ||
  model.cost.cacheWrite > 0;

/** One model call's usage; a model without a listed price makes it an unpriced call. */
export function toContractUsage(
  usage: PiUsage,
  model: Pick<Model<Api>, "cost">,
): Usage {
  const priced = hasListedPrice(model);
  return {
    modelCalls: 1,
    inputTokens: count(usage.input),
    outputTokens: count(usage.output),
    cacheReadTokens: count(usage.cacheRead),
    cacheWriteTokens: count(usage.cacheWrite),
    costUsd: priced ? Math.max(0, usage.cost?.total || 0) : 0,
    unpricedCalls: priced ? 0 : 1,
  };
}

/**
 * A call's arguments without its `null` ones. pi's validation would turn a
 * `null` string into the text "null"; left out, a required argument is
 * reported missing and an optional one is absent.
 */
function withoutNulls(args: unknown): unknown {
  if (typeof args !== "object" || args === null || Array.isArray(args))
    return args;
  const entries = Object.entries(args);
  return entries.some(([, value]) => value === null)
    ? Object.fromEntries(entries.filter(([, value]) => value !== null))
    : args;
}

/** Engine-supplied tools as pi tools. `onEndRun` records a request to end the run. */
export function collabAgentTool(
  tool: CollabTool,
  policy: OutputPolicy,
  onEndRun: () => void,
): AgentTool {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    prepareArguments: withoutNulls,
    // Collaboration tools change shared task state; run them one at a time.
    executionMode: "sequential",
    async execute(toolCallId, params, signal) {
      const result = await tool.execute(params as Record<string, unknown>, {
        toolCallId,
        signal: signal ?? new AbortController().signal,
      });
      if (result.endRun) onEndRun();
      return finalizeResult(
        {
          content: [{ type: "text", text: result.text }],
          details: undefined,
          ...(result.isError ? { isError: true } : {}),
        },
        policy,
        tool.name,
      );
    },
  };
}

export function summarizeCall(
  tool: string,
  args: Record<string, unknown>,
  collab: CollabTool | undefined,
  redact: (text: string) => string = (text) => text,
  mcp?: McpToolBinding,
): string {
  if (mcp) return summarizeMcpCall(mcp, args, redact) || tool;
  let summary: string;
  if (collab) {
    try {
      summary = collab.summarize?.(args) ?? tool;
    } catch {
      summary = tool;
    }
  } else if (tool === "bash") summary = String(args.command ?? "");
  else if (tool === "grep")
    summary = `${String(args.pattern ?? "")}${args.path ? ` in ${String(args.path)}` : ""}`;
  else if (tool === "find")
    summary = `${String(args.pattern ?? "")}${args.path ? ` in ${String(args.path)}` : ""}`;
  else summary = String(args.path ?? ".");
  return clip(redact(summary).replace(/\s+/g, " ").trim() || tool, 300);
}

/** An approved call to run before the first model call (see `RunInput.decision`). */
export interface ApprovedCall {
  call: ToolCall;
  /** The assistant message that made it. */
  assistant: AssistantMessage;
  /** True when this run may start it; false when an earlier run claimed it. */
  claim(): Promise<boolean>;
}

/** The arguments a tool will receive, or undefined when pi will refuse the call. */
function validatedArgs(
  tools: readonly AgentTool[],
  call: ToolCall,
): Record<string, unknown> | undefined {
  const tool = tools.find((candidate) => candidate.name === call.name);
  if (!tool) return undefined;
  try {
    const prepared = tool.prepareArguments
      ? { ...call, arguments: tool.prepareArguments(call.arguments) }
      : call;
    const args = validateToolArguments(tool, prepared as ToolCall);
    return args && typeof args === "object"
      ? (args as Record<string, unknown>)
      : {};
  } catch {
    return undefined;
  }
}

export interface LoopSpec {
  resolved: ResolvedModel;
  streamFn: StreamFn;
  sessionId?: string;
  systemPrompt: string;
  tools: AgentTool[];
  collabTools: readonly CollabTool[];
  /** The MCP tools among `tools`, for their call summaries. */
  mcpTools?: readonly McpToolBinding[];
  /** The conversation after the summary, if any, repaired. */
  transcript: PiMessage[];
  /**
   * Context compaction (execution sessions; chat has none). Its summary, if
   * any, leads the context; when enabled it compacts past the threshold
   * before a model call, and once after a context overflow before retrying.
   */
  compactor?: ContextCompactor;
  /** Entries to persist before the first model call (inputs are added by the loop). */
  pendingEntries?: PiMessage[];
  inputs: UserMessage[];
  maxTurns: number;
  deadline?: Date;
  /**
   * Asked before every model call (the compactor asks it for its own calls).
   * A refused call is never sent and the loop ends with `budget`/`spend`.
   */
  gate?: ModelCallGate;
  signal: AbortSignal;
  /** Retries of transient provider failures. */
  retry: RetryPolicy;
  /** True once a tool asked to end the run. */
  endRequested(): boolean;
  /** Asked before each call runs; see `ToolCallVerdict`. Absent: every call runs. */
  reviewToolCall?: (call: PendingToolCall) => Promise<ToolCallVerdict>;
  /** Run before the first model call; its result joins the transcript. */
  approved?: ApprovedCall;
  /**
   * Asked for each response that calls tools, before any call runs or is
   * reviewed: text ends the run at this turn, answering every call with it
   * (see `RunHooks.reviewTurn`). Absent: every call runs.
   */
  reviewTurn?: (calls: readonly TurnCall[]) => Promise<string | undefined>;
  /** The inbox at a turn boundary; `turnEnded` after a turn that called no tools. */
  getSteering(turnEnded: boolean): Promise<UserMessage[]>;
  persist(entries: TranscriptEntry[]): Promise<void>;
  onEvent(event: ExecutorEvent): Promise<void>;
  /** Replaces the server's secrets in summaries, model text and output previews, before any clip. */
  redact?: (text: string) => string;
}

const persistable = (message: AgentMessage): message is PiMessage =>
  message.role === "user" ||
  message.role === "toolResult" ||
  (message.role === "assistant" &&
    message.stopReason !== "error" &&
    message.stopReason !== "aborted");

const toolCallsOf = (message: AssistantMessage) =>
  message.content.filter(
    (block): block is ToolCall => block.type === "toolCall",
  );
export const hasToolCalls = (message: AssistantMessage) =>
  toolCallsOf(message).length > 0;

/** The result recorded for a call the run stopped before it started. */
export const NOT_STARTED_TEXT = "Not started: the run was stopped.";

/** The result of an approved call from a response cut at the output limit: it never runs. */
export const TRUNCATED_CALL_TEXT =
  "Not run: the response that made this call hit the output token limit, so its arguments may be cut off. Make the call again with complete arguments.";

/** pi's in-memory result for a held call; it is never persisted or sent. */
const HELD_TEXT = "Waiting for the user's approval.";

/** The error text of the stand-in answer for a model call the gate refused; it is never reported. */
const REFUSED_CALL = "The model call was refused before it was sent.";

/** An aborted answer in place of a refused call: nothing was sent, nothing was used. */
function refusedAnswer(model: Model<Api>): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "aborted",
    errorMessage: REFUSED_CALL,
    timestamp: Date.now(),
  };
}

const isRefusedAnswer = (message: AgentMessage) =>
  message.role === "assistant" &&
  message.stopReason === "aborted" &&
  message.errorMessage === REFUSED_CALL;

/** A valid deadline and turn budget, or why not. */
export function budgetProblem(
  maxTurns: unknown,
  deadline?: unknown,
): string | undefined {
  if (
    typeof maxTurns !== "number" ||
    !Number.isFinite(maxTurns) ||
    maxTurns < 1
  )
    return "budgets.maxTurns must be a finite number of at least 1.";
  if (
    deadline !== undefined &&
    !(deadline instanceof Date && Number.isFinite(deadline.getTime()))
  )
    return "budgets.deadline must be a valid date.";
  return undefined;
}

/**
 * Runs pi's low-level agent loop over a transcript we own: no pi session
 * files, no settings, no context files. Persistence, steering, budgets, abort
 * and retries are wired through the loop's hooks.
 */
export async function runLoop(spec: LoopSpec): Promise<RunOutcome> {
  const { resolved } = spec;
  const ref: ModelRef = resolved.ref;
  const secrets = [resolved.getApiKey()];
  const redact = (text: string) => redactSecrets(text, secrets);
  // The server's secrets, applied before anything below cuts text.
  const scrub = spec.redact ?? ((text: string) => text);
  const fail = (code: RunErrorCode, error: string): RunOutcome => ({
    kind: "error",
    code,
    error: redact(error),
  });
  const pending: PiMessage[] = [...(spec.pendingEntries ?? [])];
  const flush = async () => {
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    await spec.persist(batch);
    spec.compactor?.record(batch);
  };
  /** Early exits still persist what the engine already handed over. */
  const exitEarly = async (outcome: RunOutcome): Promise<RunOutcome> => {
    pending.push(...spec.inputs);
    try {
      await flush();
    } catch (error) {
      return fail(
        "unknown",
        error instanceof Error ? error.message : String(error),
      );
    }
    return outcome;
  };

  const problem = budgetProblem(spec.maxTurns, spec.deadline);
  if (problem) return exitEarly(fail("invalid_request", problem));
  if (spec.signal.aborted) return exitEarly({ kind: "aborted" });
  if (spec.deadline && spec.deadline.getTime() <= Date.now())
    return exitEarly({ kind: "budget", limit: "deadline", finalText: "" });

  const controller = new AbortController();
  const signal = controller.signal;
  let deadlineHit = false;
  let budgetHit = false;
  let turns = 0;
  const forwardAbort = () => controller.abort(spec.signal.reason);
  spec.signal.addEventListener("abort", forwardAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  if (spec.deadline)
    timer = setTimeout(
      () => {
        deadlineHit = true;
        controller.abort(new Error("deadline"));
      },
      Math.min(spec.deadline.getTime() - Date.now(), MAX_TIMER_MS),
    );

  const produced: AgentMessage[] = [];
  /** Set when compaction is on; an earlier compaction's summary leads the context either way. */
  const compactor = spec.compactor?.settings.enabled
    ? spec.compactor
    : undefined;
  /** The loop's context as of the latest request or turn, for overflow recovery. */
  let latestContext: AgentContext | undefined;
  /** A threshold compaction whose summary failed is not tried again this run. */
  let thresholdOff = false;
  /** An overflow was compacted and retried, and no response has succeeded since. */
  let overflowRetried = false;
  /** Why compaction cannot help on this model, when its window turned it off. */
  const compactionOff =
    spec.compactor && !spec.compactor.settings.enabled
      ? compactionOffNote(resolved.model.contextWindow)
      : undefined;
  /** Set when the response in flight was cut for lack of room with compaction off. */
  let cutWarning: string | undefined;
  const calls = new Map<string, { tool: string; summary: string }>();
  const answered = new Set<string>();
  /** Calls waiting for the user's approval: they never run and are never answered. */
  const held = new Set<string>();
  /** Calls the review refused, with their error result. */
  const refused = new Map<string, string>();
  /** The assistant message whose calls are running. */
  let batch: AssistantMessage | undefined;
  /** Results persisted as their tools finished, by call. */
  const stored = new Map<string, ToolResultMessage>();
  /** The latest turn was answered without tool calls: the model ended its turn. */
  let turnEnded = false;
  /** Set when `reviewTurn` ended the run: the text that answers each call of that turn. */
  let turnEnd: { text: string; calls: Set<string> } | undefined;
  const collabByName = new Map(
    spec.collabTools.map((tool) => [tool.name, tool]),
  );
  const mcpByName = new Map(
    (spec.mcpTools ?? []).map((binding) => [binding.tool.exposedName, binding]),
  );

  // After the run returns, late events (a tool killed after a hook failed) write nothing.
  let closed = false;
  const emit = async (event: AgentEvent) => {
    if (closed) return;
    switch (event.type) {
      case "message_end": {
        const message = event.message;
        // A refused call never happened: no event, nothing produced.
        if (isRefusedAnswer(message)) return;
        produced.push(message);
        if (
          message.role === "assistant" &&
          message.stopReason !== "error" &&
          message.stopReason !== "aborted"
        )
          overflowRetried = false;
        if (message.role === "toolResult") {
          // Already persisted when the tool finished.
          if (answered.has(message.toolCallId)) return;
          answered.add(message.toolCallId);
        }
        if (persistable(message)) pending.push(message);
        if (message.role === "assistant") {
          const text = scrub(assistantText(message));
          const failed = message.stopReason === "error";
          const warning = cutWarning;
          cutWarning = undefined;
          await spec.onEvent({
            type: "model.finished",
            model: ref,
            stopReason: message.stopReason,
            usage: toContractUsage(message.usage, resolved.model),
            ...(text ? { text: clip(text, 2000) } : {}),
            ...(failed && message.errorMessage
              ? { error: redact(message.errorMessage) }
              : {}),
            ...(failed
              ? {
                  errorCode: classifyModelError(
                    message,
                    resolved.model.contextWindow,
                  ),
                }
              : {}),
            ...(warning ? { warning } : {}),
          });
          // The call must be durable before its tools run.
          if (persistable(message) && hasToolCalls(message)) {
            batch = message;
            await flush();
            // pi refuses every call of a response cut at the output limit.
            if (spec.reviewTurn && message.stopReason !== "length") {
              const turnCalls = toolCallsOf(message);
              const text = await spec.reviewTurn(
                turnCalls.map((call) => ({
                  toolCallId: call.id,
                  tool: call.name,
                })),
              );
              if (text !== undefined)
                turnEnd = {
                  text,
                  calls: new Set(turnCalls.map((call) => call.id)),
                };
            }
          }
        }
        return;
      }
      case "tool_execution_start": {
        const args = (event.args ?? {}) as Record<string, unknown>;
        const summary = summarizeCall(
          event.toolName,
          args,
          collabByName.get(event.toolName),
          scrub,
          mcpByName.get(event.toolName),
        );
        calls.set(event.toolCallId, { tool: event.toolName, summary });
        // pi refuses every call of a response cut at the output limit (its
        // arguments may be cut off), so such a call is never held; nor is a
        // call of a turn `reviewTurn` ended, which never runs.
        if (
          spec.reviewToolCall &&
          event.toolCallId !== spec.approved?.call.id &&
          batch?.stopReason !== "length" &&
          !turnEnd?.calls.has(event.toolCallId)
        ) {
          const call: ToolCall = {
            type: "toolCall",
            id: event.toolCallId,
            name: event.toolName,
            arguments: args as ToolCall["arguments"],
          };
          // A call pi will refuse (unknown tool, invalid arguments) is not reviewed.
          const valid = validatedArgs(spec.tools, call);
          if (valid) {
            const verdict = await spec.reviewToolCall({
              toolCallId: event.toolCallId,
              tool: event.toolName,
              args: valid,
              summary,
              text: batch ? clip(scrub(assistantText(batch)), 2000) : "",
            });
            if (verdict === "hold") {
              held.add(event.toolCallId);
              answered.add(event.toolCallId);
              return;
            }
            if (typeof verdict === "object")
              refused.set(event.toolCallId, verdict.refuse);
          }
        }
        await spec.onEvent({
          type: "tool.started",
          toolCallId: event.toolCallId,
          tool: event.toolName,
          summary,
        });
        return;
      }
      case "tool_execution_end": {
        // A held call did not run: no result, no event.
        if (held.has(event.toolCallId)) return;
        const call = calls.get(event.toolCallId) ?? {
          tool: event.toolName,
          summary: event.toolName,
        };
        const result = (event.result ?? {}) as {
          content?: (TextContent | ImageContent)[];
          details?: Partial<ToolCallDetails>;
        };
        // Durable as soon as it finishes: a crash later in the batch must not
        // turn a finished command into "outcome unknown".
        if (!answered.has(event.toolCallId)) {
          answered.add(event.toolCallId);
          const message: ToolResultMessage = {
            role: "toolResult",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            content: result.content ?? [],
            details: (result.details ?? {}) as never,
            isError: event.isError,
            ...(event.durationMs !== undefined
              ? { durationMs: event.durationMs }
              : {}),
            timestamp: Date.now(),
          };
          stored.set(event.toolCallId, message);
          pending.push(message);
          await flush();
        }
        const details = result.details ?? {};
        const output = scrub(
          (result.content ?? [])
            .filter((block): block is TextContent => block.type === "text")
            .map((block) => block.text)
            .join("\n"),
        );
        await spec.onEvent({
          type: "tool.finished",
          toolCallId: event.toolCallId,
          tool: call.tool,
          summary: call.summary,
          ok: !event.isError,
          ...(details.exitCode !== undefined
            ? { exitCode: details.exitCode }
            : {}),
          ...(details.interrupted ? { interrupted: details.interrupted } : {}),
          output: output.slice(0, TOOL_OUTPUT_PREVIEW_LIMIT),
          truncated: details.truncated === true,
          ...(details.artifactId ? { artifactId: details.artifactId } : {}),
        });
        return;
      }
      case "turn_end": {
        const message = event.message;
        // Stopped mid-batch: calls that never started get a result saying so.
        if (
          signal.aborted &&
          message.role === "assistant" &&
          persistable(message)
        )
          for (const call of toolCallsOf(message))
            if (!answered.has(call.id)) {
              answered.add(call.id);
              pending.push({
                role: "toolResult",
                toolCallId: call.id,
                toolName: call.name,
                content: [{ type: "text", text: NOT_STARTED_TEXT }],
                details: { truncated: false, notStarted: true },
                isError: true,
                timestamp: Date.now(),
              });
            }
        await flush();
        return;
      }
      default:
        return;
    }
  };

  const config: AgentLoopConfig = {
    model: resolved.model,
    ...(spec.sessionId ? { sessionId: spec.sessionId } : {}),
    // Don't attribute requests to the pi CLI.
    identity: { attribution: null },
    // Retries happen once, in retryingStreamFn, for every provider alike.
    maxRetries: 0,
    convertToLlm: (messages) =>
      messages.filter(
        (message): message is Message =>
          message.role === "system" ||
          message.role === "user" ||
          message.role === "assistant" ||
          message.role === "toolResult",
      ),
    // Keys come from the registry's env, per call; pi's own env lookup is never relied on.
    getApiKey: () => resolved.getApiKey(),
    toolExecution: "parallel",
    // Decided before the call runs: a turn `reviewTurn` ended runs none of
    // its calls (each is answered with its text); otherwise the review at
    // tool_execution_start decided.
    beforeToolCall: async ({ toolCall }) => {
      if (turnEnd?.calls.has(toolCall.id))
        return { block: true, reason: turnEnd.text };
      if (held.has(toolCall.id)) return { block: true, reason: HELD_TEXT };
      const refusal = refused.get(toolCall.id);
      return refusal === undefined
        ? undefined
        : { block: true, reason: refusal };
    },
    prepareRequest: async (request) => {
      await flush();
      latestContext = request.context;
      let update: { context: AgentContext } | undefined;
      if (
        compactor &&
        !thresholdOff &&
        compactor.overThreshold(request.context.messages)
      ) {
        const result = await compactor.compact(
          request.context.messages,
          signal,
        );
        if (result.ok) {
          latestContext = { ...request.context, messages: result.messages };
          update = { context: latestContext };
        } else if (result.reason === "summary_failed") thresholdOff = true;
      }
      // Asked last, so a compaction's own call counts before this one starts.
      if (spec.gate && !(await spec.gate.admit())) {
        controller.abort(new Error("model call refused"));
        return update;
      }
      turns++;
      await spec.onEvent({ type: "model.started", model: ref });
      return update;
    },
    finishTurn: async (turn) => {
      latestContext = turn.context;
      turnEnded = persistable(turn.message) && !hasToolCalls(turn.message);
      if (signal.aborted) return { action: "end" };
      if (turnEnd) return { action: "end" };
      // A call waits for the user: the run ends after this batch.
      if (held.size > 0) return { action: "end" };
      const wantsMore =
        hasToolCalls(turn.message) && turn.toolResults.length > 0;
      if (spec.endRequested()) return { action: "end" };
      if (spec.deadline && Date.now() >= spec.deadline.getTime()) {
        if (wantsMore) deadlineHit = true;
        return { action: "end" };
      }
      if (turns >= spec.maxTurns) {
        if (wantsMore) budgetHit = true;
        return { action: "end" };
      }
      return undefined;
    },
    getSteeringMessages: async () =>
      signal.aborted ? [] : spec.getSteering(turnEnded),
  };

  const tools = spec.tools;
  const system = createInitialSystemMessage(
    spec.systemPrompt,
    tools.map(toToolDeclaration),
  );
  const summary = spec.compactor?.summaryMessage;
  const lead = [...(system ? [system] : []), ...(summary ? [summary] : [])];
  const context: AgentContext = {
    messages: [...lead, ...spec.transcript],
    tools,
  };
  /**
   * Runs the approved call as the model's own calls run (same events, its
   * result persisted as soon as it finishes), unless an earlier run claimed
   * it: that one may have started it, so it is answered as interrupted.
   */
  const runApproved = async ({ call, assistant, claim }: ApprovedCall) => {
    let result: ToolResultMessage;
    if (assistant.stopReason === "length") {
      // A call of a response cut at the output limit may be cut off: never run it.
      result = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: TRUNCATED_CALL_TEXT }],
        details: { truncated: false, refused: true },
        isError: true,
        timestamp: Date.now(),
      };
      answered.add(call.id);
      pending.push(result);
      await flush();
    } else if (!(await claim())) {
      result = interruptedResult(call, Date.now());
      answered.add(call.id);
      pending.push(result);
      await flush();
    } else {
      await emit({
        type: "tool_execution_start",
        toolCallId: call.id,
        toolName: call.name,
        args: call.arguments,
      });
      const outcome = await runToolCall(call, {
        tools,
        assistantMessage: assistant,
        context,
        signal,
      });
      // pi refused it without running it (an unknown tool, invalid arguments).
      const refused = outcome.durationMs === undefined;
      await emit({
        type: "tool_execution_end",
        toolCallId: call.id,
        toolName: call.name,
        result: refused
          ? {
              ...outcome.result,
              details: { ...(outcome.result.details ?? {}), refused: true },
            }
          : outcome.result,
        isError: outcome.isError,
        ...(outcome.durationMs !== undefined
          ? { durationMs: outcome.durationMs }
          : {}),
      });
      result = stored.get(call.id) as ToolResultMessage;
    }
    // Results go back in call order.
    context.messages = [
      ...lead,
      ...repairTranscript([...spec.transcript, result]),
    ];
  };
  const providerStream = retryingStreamFn(spec.streamFn, spec.retry);
  // A call the gate refused is answered here, so it never reaches the provider.
  const retrying: StreamFn = async (model, request, options) =>
    spec.gate?.refusal !== undefined
      ? streamOf(refusedAnswer(resolved.model))
      : providerStream(model, request, options);
  // With compaction on, a response the provider cut short for lack of room
  // is an overflow: it is not persisted, its calls never run, and it is
  // compacted and retried below. With compaction off for the model's window
  // it stays a length stop, and its event warns that nothing compacts.
  const streamFn: StreamFn =
    compactor || compactionOff
      ? async (model, request, options) => {
          const message = await (
            await retrying(model, request, options)
          ).result();
          if (!cutByContext(message, model, request, options?.maxTokens))
            return streamOf(message);
          const cut = `${OUTPUT_CUT_BY_CONTEXT} (stop reason length after ${message.usage.output} output tokens).`;
          if (compactor)
            return streamOf({
              ...message,
              stopReason: "error",
              errorMessage: cut,
            });
          cutWarning = `${cut} ${compactionOff}`;
          return streamOf(message);
        }
      : retrying;
  const overflowed = (message: AssistantMessage) =>
    message.stopReason === "error" &&
    classifyModelError(message, resolved.model.contextWindow) ===
      "context_overflow";
  /** Why an overflow could not be recovered, added to the error. */
  let overflowNote: string | undefined;

  let loopError: unknown;
  try {
    if (spec.approved) await runApproved(spec.approved);
    let resume: AgentContext | undefined;
    // Stopped while the approved call ran: the inputs are kept for the next run.
    if (signal.aborted) {
      pending.push(...spec.inputs);
      await flush();
    } else
      for (;;) {
        if (resume)
          await runAgentLoopContinue(resume, config, emit, signal, streamFn);
        else if (spec.inputs.length > 0)
          await runAgentLoop(
            spec.inputs,
            context,
            config,
            emit,
            signal,
            streamFn,
          );
        else
          await runAgentLoopContinue(context, config, emit, signal, streamFn);
        await flush();
        const failed = produced.at(-1);
        if (
          !compactor ||
          signal.aborted ||
          failed?.role !== "assistant" ||
          !overflowed(failed)
        )
          break;
        if (overflowRetried) {
          overflowNote =
            "The context still exceeded the model's context window after it was compacted.";
          break;
        }
        // Compact and retry the overflowed call once; it does not count as a turn.
        overflowRetried = true;
        const result = await compactor.compact(
          latestContext?.messages ?? [],
          signal,
        );
        if (!result.ok) {
          overflowNote =
            result.reason === "nothing_to_summarize"
              ? "Compacting the context could not make room: there was nothing older to summarise."
              : `Compacting the context failed: ${result.error ?? "unknown error"}`;
          break;
        }
        turns = Math.max(0, turns - 1);
        resume = { ...(latestContext ?? context), messages: result.messages };
        latestContext = resume;
      }
  } catch (error) {
    loopError = error;
  } finally {
    closed = true;
    if (timer) clearTimeout(timer);
    spec.signal.removeEventListener("abort", forwardAbort);
    // Nothing should still be running; make sure of it.
    if (!signal.aborted) controller.abort(new Error("run finished"));
  }

  const assistants = produced.filter(
    (message): message is AssistantMessage => message.role === "assistant",
  );
  const last = assistants.at(-1);
  const completed = assistants.filter(
    (message) =>
      message.stopReason !== "error" && message.stopReason !== "aborted",
  );
  const finalText =
    completed.length > 0
      ? assistantText(completed.at(-1) as AssistantMessage)
      : "";
  if (spec.signal.aborted) return { kind: "aborted" };
  if (spec.gate?.refusal !== undefined)
    return {
      kind: "budget",
      limit: "spend",
      reason: spec.gate.refusal,
      finalText,
    };
  // Before the turn budget and the deadline: the next run, after the user's answer, gets fresh ones.
  if (held.size > 0 && loopError === undefined) return { kind: "held" };
  if (deadlineHit || budgetHit)
    return {
      kind: "budget",
      limit: deadlineHit ? "deadline" : "turns",
      finalText,
    };
  if (isSandboxReleased(loopError))
    return { kind: "aborted", reason: "sandbox_released" };
  if (loopError !== undefined) {
    const message =
      loopError instanceof Error ? loopError.message : String(loopError);
    return fail(classifyErrorText(message), message);
  }
  if (last?.stopReason === "error" || last?.stopReason === "aborted") {
    const error =
      last.errorMessage || `The model call ended with ${last.stopReason}.`;
    const code = classifyModelError(last, resolved.model.contextWindow);
    const note =
      overflowNote ?? (code === "context_overflow" ? compactionOff : undefined);
    return fail(code, note ? `${error} ${note}` : error);
  }
  // A turn `reviewTurn` ended was not an answer: its text is not the run's.
  return { kind: "ended", finalText: turnEnd ? "" : finalText };
}
