import type { AssistantMessage, RetryPolicy } from "@earendil-works/pi-ai";
import { addUsage, emptyUsage, type ModelRef, type Usage } from "@jj/contracts";
import { type RetryOptions, type RunErrorCode, retryPolicy } from "./errors";
import { resolveOutputCap } from "./executor";
import { budgetProblem, collabAgentTool, runLoop, userMessage } from "./loop";
import {
  type ModelRegistry,
  ModelResolutionError,
  type ResolvedModel,
} from "./models";
import type { CollabTool, PiMessage } from "./types";

/** Most model calls one chat reply may take. */
export const CHAT_MAX_TURNS = 6;
const CHAT_DEFAULT_TURNS = 4;
const CHAT_DEFAULT_TIMEOUT_MS = 120_000;

export interface ChatHistoryEntry {
  role: "user" | "assistant";
  text: string;
}

export interface ChatReplyInput {
  /** The bot's persona, memory, active tasks and roster. */
  systemPrompt: string;
  /** Oldest first; the last entry is the user message being answered. */
  history: readonly ChatHistoryEntry[];
  model: ModelRef | null;
  /** create_task and send_to_task, supplied by the engine. */
  tools: readonly CollabTool[];
  budgets?: { maxTurns?: number; deadline?: Date };
  signal: AbortSignal;
}

export interface ChatReply {
  text: string;
  model: ModelRef;
  usage: Usage;
}

/**
 * Why a reply failed: cancelled, out of budget, or a model or request error
 * classified like a run's (`auth`, `rate_limit`, `context_overflow`,
 * `network`, `provider`, `invalid_request`, `unknown`). Messages are redacted.
 */
export class ChatReplyError extends Error {
  constructor(
    message: string,
    readonly code: "aborted" | "budget" | RunErrorCode,
  ) {
    super(message);
    this.name = "ChatReplyError";
  }
}

export interface ChatResponderOptions {
  models: ModelRegistry;
  outputCapBytes?: number;
  /** Retries of transient provider failures (default: 3, from 1 s, at most 30 s apart). */
  retry?: RetryOptions;
}

/**
 * Answers a direct message with a short pi loop: the bot's persona and model,
 * the engine's chat tools, no sandbox and no coding tools.
 */
export class ChatResponder {
  private readonly models: ModelRegistry;
  private readonly capBytes: number;
  private readonly retry: RetryPolicy;

  constructor(options: ChatResponderOptions) {
    this.models = options.models;
    this.capBytes = resolveOutputCap(options.outputCapBytes);
    this.retry = retryPolicy(options.retry);
  }

  async reply(input: ChatReplyInput): Promise<ChatReply> {
    const last = input.history.at(-1);
    if (!last || last.role !== "user" || last.text.trim() === "")
      throw new ChatReplyError(
        "The conversation does not end with a user message.",
        "invalid_request",
      );
    const requestedTurns = input.budgets?.maxTurns ?? CHAT_DEFAULT_TURNS;
    const problem = budgetProblem(requestedTurns, input.budgets?.deadline);
    if (problem) throw new ChatReplyError(problem, "invalid_request");
    let resolved: ResolvedModel;
    try {
      resolved = this.models.resolve(input.model);
    } catch (error) {
      if (!(error instanceof ModelResolutionError)) throw error;
      throw new ChatReplyError(
        error.message,
        error.code === "unconfigured" || error.code === "no_model"
          ? "auth"
          : "invalid_request",
      );
    }
    const transcript = input.history.map((entry) =>
      entry.role === "user"
        ? userMessage(entry.text)
        : pastReply(entry.text, resolved),
    );
    let usage = emptyUsage();
    let toolText = "";
    const tools = input.tools.map((tool) =>
      collabAgentTool(
        {
          ...tool,
          execute: async (args, context) => {
            const result = await tool.execute(args, context);
            if (!result.isError) toolText = result.text;
            return result;
          },
        },
        {
          capBytes: this.capBytes,
          spill: async () => {
            throw new Error("Chat replies have no artifact store.");
          },
        },
        () => {},
      ),
    );
    const maxTurns = Math.min(CHAT_MAX_TURNS, Math.floor(requestedTurns));
    const outcome = await runLoop({
      resolved,
      streamFn: this.models.streamFn,
      systemPrompt: input.systemPrompt,
      tools,
      collabTools: input.tools,
      transcript: transcript as PiMessage[],
      inputs: [],
      maxTurns,
      deadline:
        input.budgets?.deadline ??
        new Date(Date.now() + CHAT_DEFAULT_TIMEOUT_MS),
      signal: input.signal,
      retry: this.retry,
      endRequested: () => false,
      getSteering: async () => [],
      persist: async () => {},
      onEvent: async (event) => {
        if (event.type === "model.finished")
          usage = addUsage(usage, event.usage);
      },
    });
    switch (outcome.kind) {
      case "aborted":
        throw new ChatReplyError("The reply was cancelled.", "aborted");
      case "error":
        throw new ChatReplyError(outcome.error, outcome.code);
      case "idle":
        throw new ChatReplyError("Nothing to reply to.", "invalid_request");
      case "budget":
        // A tool that succeeded (create_task) is the reply: a retry must not repeat it.
        if (!outcome.finalText && toolText)
          return { text: toolText, model: resolved.ref, usage };
        if (!outcome.finalText)
          throw new ChatReplyError(
            `The reply did not finish within ${maxTurns} model calls.`,
            "budget",
          );
        return { text: outcome.finalText, model: resolved.ref, usage };
      case "ended": {
        const text = outcome.finalText || toolText;
        if (!text)
          throw new ChatReplyError(
            "The model returned an empty reply.",
            "provider",
          );
        return { text, model: resolved.ref, usage };
      }
    }
  }
}

/** An earlier reply as an assistant message of the model now answering. */
function pastReply(text: string, resolved: ResolvedModel): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: resolved.model.api,
    provider: resolved.model.provider,
    model: resolved.model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}
