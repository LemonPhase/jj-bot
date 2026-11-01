import {
  type AgentContext,
  type AgentEvent,
  type AgentLoopConfig,
  type AgentMessage,
  type AgentTool,
  runAgentLoop,
  runAgentLoopContinue,
  type StreamFn,
} from "@earendil-works/pi-agent-core";
import {
  type AssistantMessage,
  createInitialSystemMessage,
  type ImageContent,
  type Message,
  type Usage as PiUsage,
  type RetryPolicy,
  type TextContent,
  type ToolCall,
  toToolDeclaration,
  type UserMessage,
} from "@earendil-works/pi-ai";
import {
  type ModelRef,
  TOOL_OUTPUT_PREVIEW_LIMIT,
  type Usage,
} from "@jj/contracts";
import type { ContextCompactor } from "./compaction";
import {
  classifyErrorText,
  classifyModelError,
  type RunErrorCode,
  redactSecrets,
  retryingStreamFn,
} from "./errors";
import type { ResolvedModel } from "./models";
import {
  finalizeResult,
  isSandboxReleased,
  type OutputPolicy,
  type ToolCallDetails,
} from "./tools";
import type {
  CollabTool,
  ExecutorEvent,
  PiMessage,
  RunOutcome,
  TranscriptEntry,
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

export function toContractUsage(usage: PiUsage): Usage {
  return {
    modelCalls: 1,
    inputTokens: count(usage.input),
    outputTokens: count(usage.output),
    cacheReadTokens: count(usage.cacheRead),
    cacheWriteTokens: count(usage.cacheWrite),
    costUsd: Math.max(0, usage.cost?.total || 0),
  };
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
): string {
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

export interface LoopSpec {
  resolved: ResolvedModel;
  streamFn: StreamFn;
  sessionId?: string;
  systemPrompt: string;
  tools: AgentTool[];
  collabTools: readonly CollabTool[];
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
  signal: AbortSignal;
  /** Retries of transient provider failures. */
  retry: RetryPolicy;
  /** True once a tool asked to end the run. */
  endRequested(): boolean;
  getSteering(): Promise<UserMessage[]>;
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
const hasToolCalls = (message: AssistantMessage) =>
  toolCallsOf(message).length > 0;

/** The result recorded for a call the run stopped before it started. */
export const NOT_STARTED_TEXT = "Not started: the run was stopped.";

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
    return exitEarly({ kind: "budget", finalText: "" });

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
  const { compactor } = spec;
  const compacting = compactor?.settings.enabled === true;
  /** The loop's context as of the latest request or turn, for overflow recovery. */
  let latestContext: AgentContext | undefined;
  /** A threshold compaction whose summary failed is not tried again this run. */
  let thresholdOff = false;
  /** An overflow was compacted and retried, and no response has succeeded since. */
  let overflowRetried = false;
  const calls = new Map<string, { tool: string; summary: string }>();
  const answered = new Set<string>();
  const collabByName = new Map(
    spec.collabTools.map((tool) => [tool.name, tool]),
  );

  // After the run returns, late events (a tool killed after a hook failed) write nothing.
  let closed = false;
  const emit = async (event: AgentEvent) => {
    if (closed) return;
    switch (event.type) {
      case "message_end": {
        const message = event.message;
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
          await spec.onEvent({
            type: "model.finished",
            model: ref,
            stopReason: message.stopReason,
            usage: toContractUsage(message.usage),
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
          });
          // The call must be durable before its tools run.
          if (persistable(message) && hasToolCalls(message)) await flush();
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
        );
        calls.set(event.toolCallId, { tool: event.toolName, summary });
        await spec.onEvent({
          type: "tool.started",
          toolCallId: event.toolCallId,
          tool: event.toolName,
          summary,
        });
        return;
      }
      case "tool_execution_end": {
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
          pending.push({
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
          });
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
    prepareRequest: async (request) => {
      await flush();
      latestContext = request.context;
      let update: { context: AgentContext } | undefined;
      if (
        compactor &&
        compacting &&
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
      turns++;
      await spec.onEvent({ type: "model.started", model: ref });
      return update;
    },
    finishTurn: async (turn) => {
      latestContext = turn.context;
      if (signal.aborted) return { action: "end" };
      const wantsMore =
        hasToolCalls(turn.message) && turn.toolResults.length > 0;
      if (spec.endRequested()) return { action: "end" };
      if (spec.deadline && Date.now() >= spec.deadline.getTime()) {
        if (wantsMore) budgetHit = true;
        return { action: "end" };
      }
      if (turns >= spec.maxTurns) {
        if (wantsMore) budgetHit = true;
        return { action: "end" };
      }
      return undefined;
    },
    getSteeringMessages: async () => (signal.aborted ? [] : spec.getSteering()),
  };

  const tools = spec.tools;
  const system = createInitialSystemMessage(
    spec.systemPrompt,
    tools.map(toToolDeclaration),
  );
  const summary = compactor?.summaryMessage;
  const context: AgentContext = {
    messages: [
      ...(system ? [system] : []),
      ...(summary ? [summary] : []),
      ...spec.transcript,
    ],
    tools,
  };
  const streamFn = retryingStreamFn(spec.streamFn, spec.retry);
  const overflowed = (message: AssistantMessage) =>
    message.stopReason === "error" &&
    classifyModelError(message, resolved.model.contextWindow) ===
      "context_overflow";
  /** Why an overflow could not be recovered, added to the error. */
  let overflowNote: string | undefined;

  let loopError: unknown;
  try {
    let resume: AgentContext | undefined;
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
      else await runAgentLoopContinue(context, config, emit, signal, streamFn);
      await flush();
      const failed = produced.at(-1);
      if (
        !compactor ||
        !compacting ||
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
  if (deadlineHit || budgetHit) return { kind: "budget", finalText };
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
    return fail(
      classifyModelError(last, resolved.model.contextWindow),
      overflowNote ? `${error} ${overflowNote}` : error,
    );
  }
  return { kind: "ended", finalText };
}
