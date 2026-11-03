import type {
  AssistantMessage,
  RetryPolicy,
  ToolCall,
  ToolResultMessage,
} from "@earendil-works/pi-ai";
import { TOOL_OUTPUT_PREVIEW_LIMIT } from "@jj/contracts";
import {
  type CompactionOptions,
  ContextCompactor,
  compactionSettings,
  viewTranscript,
} from "./compaction";
import { type RetryOptions, redactSecrets, retryPolicy } from "./errors";
import { ModelCallGate } from "./gate";
import {
  type ApprovedCall,
  budgetProblem,
  collabAgentTool,
  hasToolCalls,
  runLoop,
  userMessage,
} from "./loop";
import { createMcpTools } from "./mcp/adapter";
import {
  type ModelRegistry,
  ModelResolutionError,
  type ResolvedModel,
} from "./models";
import { createSandboxTools } from "./sandbox-tools";
import type { OutputPolicy } from "./tools";
import { appendedRepairs, repairTranscript } from "./transcript";
import type {
  HeldCallDecision,
  PiMessage,
  RunExecutor,
  RunInput,
  RunOutcome,
} from "./types";

export interface PiSessionExecutorOptions {
  models: ModelRegistry;
  /**
   * UTF-8 bytes of tool output the model and events see (`JJ_OUTPUT_CAP_BYTES`).
   * Clamped to `TOOL_OUTPUT_PREVIEW_LIMIT`; larger output is spilled.
   */
  outputCapBytes?: number;
  /** Retries of transient provider failures (default: 3, from 1 s, at most 30 s apart). */
  retry?: RetryOptions;
  /**
   * Context compaction (default on, with pi's reserve and keep-recent
   * tokens, clamped to the model's context window).
   */
  compaction?: CompactionOptions;
}

/**
 * The held call a decision answers, when it is still unanswered: the call
 * and the assistant message that made it. Undefined when the transcript has
 * no such call or already holds its result.
 */
function heldCall(
  messages: readonly PiMessage[],
  decision: HeldCallDecision | undefined,
): { call: ToolCall; assistant: AssistantMessage } | undefined {
  if (!decision) return undefined;
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index] as PiMessage;
    if (
      message.role === "toolResult" &&
      message.toolCallId === decision.toolCallId
    )
      return undefined;
    if (message.role !== "assistant") continue;
    const call = message.content.find(
      (block): block is ToolCall =>
        block.type === "toolCall" && block.id === decision.toolCallId,
    );
    if (call) return { call, assistant: message };
  }
  return undefined;
}

/** The error result of a held call the user did not approve. */
function deniedResult(call: ToolCall, text: string): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text }],
    details: { truncated: false, notApproved: true },
    isError: true,
    timestamp: Date.now(),
  };
}

/** Clamps a configured output cap to the contract's preview limit. */
export function resolveOutputCap(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0)
    return TOOL_OUTPUT_PREVIEW_LIMIT;
  return Math.max(
    1024,
    Math.min(Math.floor(requested), TOOL_OUTPUT_PREVIEW_LIMIT),
  );
}

/**
 * Runs one execution session on pi's agent loop. The loop stays in this
 * process: model calls use keys from the registry's env, and every coding tool
 * acts through the run's `Sandbox`. Stateless between runs: everything a later
 * run needs is in the transcript the engine persists through `onTurnComplete`.
 */
export class PiSessionExecutor implements RunExecutor {
  private readonly models: ModelRegistry;
  private readonly capBytes: number;
  private readonly retry: RetryPolicy;
  private readonly compaction: CompactionOptions;

  constructor(options: PiSessionExecutorOptions) {
    this.models = options.models;
    this.capBytes = resolveOutputCap(options.outputCapBytes);
    this.retry = retryPolicy(options.retry);
    this.compaction = options.compaction ?? {};
  }

  async run(input: RunInput): Promise<RunOutcome> {
    const { hooks } = input;
    // The context: the latest compaction's summary, then what it kept and
    // everything after it, repaired. A denied held call gets its error
    // result first; an approved one stays open until it runs.
    const view = viewTranscript(input.transcript);
    const decided = heldCall(view.messages, input.decision);
    const decision = decided ? input.decision : undefined;
    const denial =
      decided && decision && !decision.approved
        ? deniedResult(decided.call, decision.text)
        : undefined;
    const messages = denial ? [...view.messages, denial] : view.messages;
    const open = new Set(decision?.approved ? [decision.toolCallId] : []);
    const transcript = repairTranscript(messages, open);
    const repairs = [
      ...(denial ? [denial] : []),
      ...appendedRepairs(messages, transcript),
    ];
    const approved: ApprovedCall | undefined =
      decided && decision?.approved
        ? {
            ...decided,
            claim: async () =>
              (await hooks.claimApprovedCall?.(decided.call.id)) ?? true,
          }
        : undefined;
    let inputs = input.inputs
      .filter((text) => text.trim().length > 0)
      .map((text) => userMessage(text));
    // Whatever the engine handed over is persisted even when the run stops early.
    const exitEarly = async (outcome: RunOutcome): Promise<RunOutcome> => {
      const entries = [...repairs, ...inputs];
      try {
        if (entries.length > 0) await hooks.onTurnComplete(entries);
      } catch (error) {
        return {
          kind: "error",
          code: "unknown",
          error: redactSecrets(
            error instanceof Error ? error.message : String(error),
          ),
        };
      }
      return outcome;
    };

    let resolved: ResolvedModel;
    try {
      resolved = this.models.resolve(input.model);
    } catch (error) {
      if (!(error instanceof ModelResolutionError)) throw error;
      return exitEarly({
        kind: "error",
        code:
          error.code === "unconfigured" || error.code === "no_model"
            ? "auth"
            : "invalid_request",
        error: error.message,
      });
    }
    const problem = budgetProblem(
      input.budgets.maxTurns,
      input.budgets.deadline,
    );
    if (problem)
      return exitEarly({
        kind: "error",
        code: "invalid_request",
        error: problem,
      });
    // Checked before draining, so an inbox item is never taken by a run that cannot use it.
    if (input.signal.aborted) return exitEarly({ kind: "aborted" });
    if (input.budgets.deadline.getTime() <= Date.now())
      return exitEarly({ kind: "budget", limit: "deadline", finalText: "" });

    const policy: OutputPolicy = {
      capBytes: this.capBytes,
      spill: (text, label) => hooks.spillOutput(text, label),
      ...(input.redact ? { redact: input.redact } : {}),
    };
    let endRequested = false;
    // A sandbox released under the run (stop, idle release) stops it like an abort.
    const released = new AbortController();
    const signal = AbortSignal.any([input.signal, released.signal]);
    const tools = [
      ...createSandboxTools(input.sandbox, input.codingTools, policy, {
        limits: input.sandboxLimits,
        onReleased: () => released.abort(new Error("sandbox released")),
      }),
      ...input.collaborationTools.map((tool) =>
        collabAgentTool(tool, policy, () => {
          endRequested = true;
        }),
      ),
      ...createMcpTools(input.mcpTools ?? [], policy),
    ];
    const drain = async (turnEnded = false) =>
      (await hooks.drainInbox(turnEnded))
        .filter((text) => text.trim().length > 0)
        .map((text) => userMessage(text));

    const tail = transcript.at(-1);
    if (
      inputs.length === 0 &&
      !approved &&
      (!tail || tail.role === "assistant")
    ) {
      // A wake with nothing new: take what is in the inbox, else there is
      // nothing to do. A transcript that ends with the model's answer is
      // where it ended its turn, so the drain says so.
      try {
        inputs = await drain(tail?.role === "assistant" && !hasToolCalls(tail));
      } catch (error) {
        return exitEarly({
          kind: "error",
          code: "unknown",
          error: redactSecrets(
            error instanceof Error ? error.message : String(error),
          ),
        });
      }
      if (inputs.length === 0) {
        if (repairs.length > 0) await hooks.onTurnComplete(repairs);
        return { kind: "idle" };
      }
    }

    // One gate for the run's calls and its compaction's, so a refusal holds for both.
    const gate = new ModelCallGate(hooks.admitModelCall?.bind(hooks));
    const compactor = new ContextCompactor(input.transcript, view, {
      model: resolved.model,
      ref: resolved.ref,
      getApiKey: () => resolved.getApiKey(),
      streamFn: this.models.streamFn,
      retry: this.retry,
      sessionId: input.sessionId,
      settings: compactionSettings(
        resolved.model.contextWindow,
        this.compaction,
      ),
      persist: async (entries) => {
        await hooks.onTurnComplete(entries);
      },
      onEvent: async (event) => {
        await hooks.onEvent(event);
      },
      scrub: input.redact ?? ((text) => text),
      redactError: (text) => redactSecrets(text, [resolved.getApiKey()]),
      gate,
    });

    // From here runLoop persists repairs and inputs on every path, early exits included.
    const outcome = await runLoop({
      resolved,
      streamFn: this.models.streamFn,
      sessionId: input.sessionId,
      systemPrompt: input.systemPrompt,
      tools,
      collabTools: input.collaborationTools,
      ...(input.mcpTools ? { mcpTools: input.mcpTools } : {}),
      transcript,
      compactor,
      pendingEntries: repairs,
      inputs,
      maxTurns: input.budgets.maxTurns,
      deadline: input.budgets.deadline,
      gate,
      signal,
      retry: this.retry,
      endRequested: () => endRequested,
      ...(hooks.reviewToolCall
        ? { reviewToolCall: hooks.reviewToolCall.bind(hooks) }
        : {}),
      ...(approved ? { approved } : {}),
      ...(hooks.reviewTurn ? { reviewTurn: hooks.reviewTurn.bind(hooks) } : {}),
      ...(input.redact ? { redact: input.redact } : {}),
      getSteering: drain,
      persist: async (entries) => {
        await hooks.onTurnComplete(entries);
      },
      onEvent: async (event) => {
        await hooks.onEvent(event);
      },
    });
    if (released.signal.aborted && !input.signal.aborted)
      return { kind: "aborted", reason: "sandbox_released" };
    return outcome;
  }
}
