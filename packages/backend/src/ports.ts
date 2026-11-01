// The engine's ports: what it needs from the agent runtime, the model registry
// and the sandbox drivers. The engine depends on these shapes only, never on
// `@jj/runtime` or a concrete driver, so `apps/api` passes the runtime objects
// (`PiSessionExecutor`, `ChatResponder`, `ModelRegistry`) straight in.
import type {
  ModelRef,
  ModelsView,
  ProviderInfo,
  SandboxDriverInfo,
  ToolName,
  Usage,
} from "@jj/contracts";
import type {
  Interrupted,
  Sandbox,
  SandboxDriver,
  SandboxLimits,
} from "@jj/sandbox/contract";

/**
 * One persisted transcript entry, opaque to the engine: a pi message, or a
 * compaction checkpoint (`role: "compaction"`) the runtime appends when it
 * compacts the context. It is stored as JSON in `session_entries` and handed
 * back unchanged, every entry in order.
 */
export type PiMessage = object;

/** A JSON Schema object (TypeBox schemas are JSON Schema too). */
export type JsonSchema = object;

export interface CollabToolContext {
  toolCallId: string;
  /** Aborted when the run is stopped. */
  signal: AbortSignal;
}

export interface CollabToolResult {
  /** What the model sees as the tool result. */
  text: string;
  /** Reported to the model as a failed call; the run continues. */
  isError?: boolean;
  /** Ends the run once the current tool batch finishes (complete_task). */
  endRun?: boolean;
}

/** A tool the engine supplies: delegate, message, complete_task, create_task, send_to_task. */
export interface CollabTool {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Activity summary for `tool.started`, such as the delegate's bot name. Default: the tool name. */
  summarize?(args: Record<string, unknown>): string;
  execute(
    args: Record<string, unknown>,
    context: CollabToolContext,
  ): Promise<CollabToolResult>;
}

/** Activity reported while a run executes; the engine maps the contract fields to task events. */
export type ExecutorEvent =
  | { type: "model.started"; model?: ModelRef }
  | {
      type: "model.finished";
      model: ModelRef;
      stopReason: string;
      usage: Usage;
      text?: string;
      error?: string;
      /** Something the operator should know, such as a compaction that failed; logged as a warning. */
      warning?: string;
    }
  | { type: "tool.started"; toolCallId: string; tool: string; summary: string }
  | {
      type: "tool.finished";
      toolCallId: string;
      tool: string;
      summary: string;
      ok: boolean;
      exitCode?: number | null;
      interrupted?: Interrupted;
      output?: string;
      truncated: boolean;
      artifactId?: string;
    };

export interface RunHooks {
  /** Awaited: the event is durable before the run goes on. */
  onEvent(event: ExecutorEvent): void | Promise<void>;
  /**
   * Persists entries in order as session_entries. Called for inputs and steering
   * before the model sees them, for an assistant tool call before the tool runs,
   * for each turn's results, and for a compaction checkpoint alone (one write,
   * so it is stored whole or not at all). A rejection (for example a lost
   * lease) ends the run.
   */
  onTurnComplete(entries: PiMessage[]): void | Promise<void>;
  /** Undelivered inbox items, injected as user messages at the next turn boundary. */
  drainInbox(): Promise<string[]>;
  /** Stores tool output over the cap as an `output` artifact; returns its id. */
  spillOutput(text: string, label: string): Promise<string>;
}

export interface RunBudgets {
  /** Most model calls in this executor call. */
  maxTurns: number;
  /** The run stops (outcome `budget`) when this passes. */
  deadline: Date;
}

export interface RunInput {
  sessionId: string;
  runId: string;
  systemPrompt: string;
  /**
   * Every persisted entry, oldest first. The executor rebuilds the context
   * from the latest compaction checkpoint and repairs dangling tool calls.
   */
  transcript: PiMessage[];
  /**
   * New user-role messages: the brief on the first run, results, steering and
   * messages on a wake. Empty on recovery: the executor continues from the
   * transcript, and returns `ended` with the last text when it already ended.
   */
  inputs: string[];
  /** The bot's model; null uses the registry default. */
  model: ModelRef | null;
  sandbox: Sandbox;
  /** The task sandbox spec's limits; the runtime clamps model-chosen bash timeouts to them. */
  sandboxLimits: SandboxLimits;
  codingTools: readonly ToolName[];
  collaborationTools: readonly CollabTool[];
  budgets: RunBudgets;
  /** Aborting stops the model call and the in-flight sandbox command; outcome `aborted`. */
  signal: AbortSignal;
  hooks: RunHooks;
  /**
   * Replaces the server's secret values. The runtime applies it to tool
   * output, tool summaries and model text before any cap, clip or spill, so
   * a cut never leaves part of a secret; the engine redacts again on write.
   */
  redact?: (text: string) => string;
}

/** Why a model call failed, when the runtime knows. */
export type RunErrorCode =
  | "auth"
  | "rate_limit"
  | "context_overflow"
  | "network"
  | "provider"
  | "invalid_request"
  | "unknown";

export type RunOutcome =
  | { kind: "ended"; finalText: string }
  /**
   * No inputs and an empty inbox: nothing ran. On a recovery run this means
   * the transcript's last turn had already ended before the restart.
   */
  | { kind: "idle" }
  /** `sandbox_released`: the sandbox went away under the run; never a completion. */
  | { kind: "aborted"; reason?: "signal" | "sandbox_released" }
  | { kind: "budget"; finalText: string }
  | { kind: "error"; error: string; code?: RunErrorCode };

/** Runs one execution session (the brief's `SessionExecutor`). */
export interface RunExecutor {
  run(input: RunInput): Promise<RunOutcome>;
}
export type SessionExecutor = RunExecutor;

export interface ChatHistoryEntry {
  role: "user" | "assistant";
  text: string;
}

export interface ChatReplyInput {
  /** Persona, memory, active tasks and roster. */
  systemPrompt: string;
  /** Oldest first; ends with the user message being answered. */
  history: readonly ChatHistoryEntry[];
  model: ModelRef | null;
  /** create_task and send_to_task. */
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
 * Answers a direct message without a sandbox. A thrown error becomes the
 * conversation's `lastReplyError`; its `code` (as on `ChatReplyError`) is shown with it.
 */
export interface ChatResponder {
  reply(input: ChatReplyInput): Promise<ChatReply>;
}

/** The provider and model registry. */
export interface ModelCatalog {
  providers(): ProviderInfo[];
  view(): ModelsView;
  defaultModel(): ModelRef | null;
  /**
   * Resolves a model reference (null: the default). Throws when it cannot run:
   * an invalid or unknown ref, an unconfigured provider, or no default. The
   * engine reports that as MODEL_NOT_CONFIGURED.
   */
  resolve(ref: ModelRef | null): unknown;
}

/**
 * A driver as the engine uses it. The worker calls the optional `reapOrphans`
 * once at start (docker removes containers a crashed worker left).
 */
export type EngineDriver = SandboxDriver & {
  reapOrphans?: SandboxDriver["reapOrphans"];
};

export interface DriverRegistry {
  get(id: string): EngineDriver | undefined;
  all(): readonly EngineDriver[];
  /** Every driver with its probe result and the JSON Schema of its spec. */
  list(): Promise<SandboxDriverInfo[]>;
}
