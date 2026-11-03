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

/** A tool the engine supplies: a session's collaboration tools, or direct chat's task tools. */
export interface CollabTool {
  name: string;
  description: string;
  parameters: JsonSchema;
  /** Activity summary for `tool.started`, such as the delegate's bot name. Default: the tool name. */
  summarize?(args: Record<string, unknown>): string;
  /**
   * The tool only reads. A chat reply cut short by its budget never answers
   * with such a tool's output.
   */
  readOnly?: boolean;
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

/** A tool call about to run, as the approval policy sees it. */
export interface PendingToolCall {
  toolCallId: string;
  tool: string;
  /** The validated arguments, unredacted: redact what is stored. */
  args: Record<string, unknown>;
  /** Its activity summary (redacted). */
  summary: string;
  /** The text of the assistant message that made it (redacted), or "". */
  text: string;
}

/**
 * `run`; `hold` (an approval was recorded: the call does not run, reports
 * no tool events and stays unanswered, and the run ends `held` after its
 * batch); or `{ refuse }` (it does not run; the text is its error result).
 */
export type ToolCallVerdict = "run" | "hold" | { refuse: string };

/** The user's answer to a call an earlier run of the session held. */
export type HeldCallDecision =
  | { toolCallId: string; approved: true }
  | { toolCallId: string; approved: false; text: string };

/** One tool call of a model response, as `RunHooks.reviewTurn` sees it. */
export interface TurnCall {
  toolCallId: string;
  tool: string;
}

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
  /**
   * Undelivered inbox items, injected as user messages at the next turn
   * boundary. `turnEnded`: the model just ended its turn (a turn that called
   * no tools), so what this returns makes it take another; the engine then
   * returns nothing unless a brief, result or steering is waiting.
   */
  drainInbox(turnEnded?: boolean): Promise<string[]>;
  /** Stores tool output over the cap as an `output` artifact; returns its id. */
  spillOutput(text: string, label: string): Promise<string>;
  /**
   * Asked before every model call, compaction summaries included: why the
   * call may not start (a spend cap), or undefined. A refused call is never
   * sent; the run ends with `budget` and `limit: "spend"`.
   */
  admitModelCall?(): Promise<string | undefined>;
  /** Asked before each tool call runs (absent: every call runs). A rejection ends the run. */
  reviewToolCall?(call: PendingToolCall): Promise<ToolCallVerdict>;
  /**
   * Claims the approved call of `RunInput.decision` right before it runs.
   * False when an earlier run claimed it: it is then answered as
   * interrupted with an unknown outcome, never run again.
   */
  claimApprovedCall?(toolCallId: string): Promise<boolean>;
  /**
   * Asked once for each model response that calls tools, with all of its
   * calls, before any of them runs or is reviewed: text ends the run at this
   * turn (none of the calls runs or goes to `reviewToolCall`, so none is
   * held; each gets the text as its error result, and the run ends `ended`
   * with empty `finalText` without draining the inbox again), undefined
   * lets them go on. Not asked for a response cut at the output limit. A
   * rejection ends the run.
   */
  reviewTurn?(calls: readonly TurnCall[]): Promise<string | undefined>;
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
  /**
   * The user's answer to the call an earlier run held, applied before the
   * first model call while the call is unanswered in the transcript: an
   * approved call runs once (after `claimApprovedCall`) with its stored
   * arguments; a denied one gets `text` as its error result.
   */
  decision?: HeldCallDecision;
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
  /** `finalText` is empty when `reviewTurn` ended the run. */
  | { kind: "ended"; finalText: string }
  /**
   * No inputs and an empty inbox: nothing ran. On a recovery run this means
   * the transcript's last turn had already ended before the restart.
   */
  | { kind: "idle" }
  /** A call waits for the user's approval; the run ended after its batch. */
  | { kind: "held" }
  /** `sandbox_released`: the sandbox went away under the run; never a completion. */
  | { kind: "aborted"; reason?: "signal" | "sandbox_released" }
  /** `limit: "spend"`: a model call was refused at a spend cap; `reason` says which. */
  | {
      kind: "budget";
      finalText: string;
      limit?: "turns" | "deadline" | "spend";
      reason?: string;
    }
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
  /** Persona, memory, the count of unfinished tasks and roster. */
  systemPrompt: string;
  /**
   * Oldest first; ends with the input being answered: the user's message, or
   * a task update (user-role text from the engine, never stored).
   */
  history: readonly ChatHistoryEntry[];
  model: ModelRef | null;
  /** The chat task tools; only the read tools for a task update. */
  tools: readonly CollabTool[];
  budgets?: { maxTurns?: number; deadline?: Date };
  signal: AbortSignal;
  /** Asked before each model call; a refusal (a spend cap) fails the reply with code `spend_cap`. */
  admitModelCall?(): Promise<string | undefined>;
  /** Each model call's usage as it finishes, failed replies included. */
  onUsage?(usage: Usage, model: ModelRef): Promise<void>;
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
