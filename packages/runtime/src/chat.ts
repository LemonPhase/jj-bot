import type { AssistantMessage } from "@earendil-works/pi-ai";
import { addUsage, emptyUsage, type ModelRef, type Usage } from "@jj/contracts";
import { resolveOutputCap } from "./executor";
import { collabAgentTool, runLoop, userMessage } from "./loop";
import type { ModelRegistry, ResolvedModel } from "./models";
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

export class ChatReplyError extends Error {
  constructor(
    message: string,
    readonly code: "aborted" | "budget" | "model" | "invalid",
  ) {
    super(message);
    this.name = "ChatReplyError";
  }
}

export interface ChatResponderOptions {
  models: ModelRegistry;
  outputCapBytes?: number;
}

/**
 * Answers a direct message with a short pi loop: the bot's persona and model,
 * the engine's chat tools, no sandbox and no coding tools.
 */
export class ChatResponder {
  private readonly models: ModelRegistry;
  private readonly capBytes: number;

  constructor(options: ChatResponderOptions) {
    this.models = options.models;
    this.capBytes = resolveOutputCap(options.outputCapBytes);
  }

  async reply(input: ChatReplyInput): Promise<ChatReply> {
    const last = input.history.at(-1);
    if (!last || last.role !== "user" || last.text.trim() === "")
      throw new ChatReplyError(
        "The conversation does not end with a user message.",
        "invalid",
      );
    let resolved: ResolvedModel;
    try {
      resolved = this.models.resolve(input.model);
    } catch (error) {
      throw new ChatReplyError(
        error instanceof Error ? error.message : String(error),
        "model",
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
    const maxTurns = Math.min(
      CHAT_MAX_TURNS,
      Math.max(1, Math.floor(input.budgets?.maxTurns ?? CHAT_DEFAULT_TURNS)),
    );
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
        throw new ChatReplyError(outcome.error, "model");
      case "budget":
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
            "model",
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
