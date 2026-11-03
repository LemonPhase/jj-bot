import type {
  AssistantMessage,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { ModelRef, ToolName, Usage } from "@jj/contracts";
import type { Interrupted, Sandbox, SandboxLimits } from "@jj/sandbox";
import type { TSchema } from "typebox";
import type { RunErrorCode } from "./errors";

/**
 * A pi message as persisted in `session_entries` (as JSON). System messages
 * are never persisted; the system prompt is rebuilt for every run.
 */
export type PiMessage = UserMessage | AssistantMessage | ToolResultMessage;

/**
 * A persisted context checkpoint. The `keptEntries` stored entries right
 * before it stay in the model's context as they are; everything earlier is
 * replaced by `summary`, which also folds in any earlier summary.
 */
export interface CompactionEntry {
  role: "compaction";
  summary: string;
  /** Stored entries immediately before this one that the context keeps. */
  keptEntries: number;
  /** Estimated context tokens when it was compacted. */
  tokensBefore: number;
  /** Files the summarised part read (and did not change), carried into later summaries. */
  readFiles: string[];
  /** Files the summarised part wrote or edited. */
  modifiedFiles: string[];
  timestamp: number;
}

/** One stored transcript entry: a pi message or a compaction checkpoint. */
export type TranscriptEntry = PiMessage | CompactionEntry;

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

/** A tool supplied by the engine: a session's collaboration tools, or direct chat's task tools. */
export interface CollabTool {
  name: string;
  description: string;
  /** TypeBox schema (`Type` from `typebox`) or plain JSON Schema. */
  parameters: TSchema;
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

/**
 * Activity reported while a run executes. Payloads match the contract's task
 * event payloads (`model.finished`, `tool.started`, `tool.finished`).
 */
export type ExecutorEvent =
  | { type: "model.started"; model: ModelRef }
  | {
      type: "model.finished";
      model: ModelRef;
      stopReason: string;
      usage: Usage;
      /** Preview of the assistant text, at most 2000 characters. */
      text?: string;
      /** Provider error text when `stopReason` is "error", redacted. */
      error?: string;
      /** Its classification when `stopReason` is "error". */
      errorCode?: RunErrorCode;
      /** Something the operator should know, such as a compaction that failed; the engine logs it. */
      warning?: string;
    }
  | {
      type: "tool.started";
      toolCallId: string;
      tool: string;
      /** At most 300 characters: the command for bash, the path for file tools. */
      summary: string;
    }
  | {
      type: "tool.finished";
      toolCallId: string;
      tool: string;
      summary: string;
      ok: boolean;
      exitCode?: number | null;
      interrupted?: Interrupted;
      /** What the model saw, at most the output cap. */
      output?: string;
      /** The full output was over the cap; `artifactId` holds it when it was stored. */
      truncated: boolean;
      artifactId?: string;
    };

/** A tool call about to run, as the engine's approval policy sees it. */
export interface PendingToolCall {
  toolCallId: string;
  tool: string;
  /** The arguments as the tool will receive them (validated), unredacted. */
  args: Record<string, unknown>;
  /** The call's activity summary, as `tool.started` would carry it (redacted). */
  summary: string;
  /** The text of the assistant message that made the call (redacted); empty when it had none. */
  text: string;
}

/**
 * What happens to a call before it runs:
 * - `run`: it runs.
 * - `hold`: it waits for the user's approval, which the engine recorded. It
 *   does not run and reports no tool events, and its result is never
 *   persisted, so the transcript keeps it unanswered. The rest of its batch
 *   runs, then the run ends `held`.
 * - `{ refuse }`: it does not run; `refuse` is its error result.
 */
export type ToolCallVerdict = "run" | "hold" | { refuse: string };

/** The user's answer to a call that an earlier run of the session held. */
export type HeldCallDecision =
  | { toolCallId: string; approved: true }
  | { toolCallId: string; approved: false; text: string };

export interface RunHooks {
  onEvent(event: ExecutorEvent): void | Promise<void>;
  /**
   * Persist these entries, in order, before the run goes on. Called with the
   * run's inputs and any injected steering before the model call that sees
   * them, with an assistant message that calls tools before those tools run
   * (so a crash mid-tool leaves a call for `repairTranscript`), and with each
   * turn's tool results or final message when the turn completes; and with a
   * compaction entry, alone, once everything before it is persisted. A
   * rejection ends the run with an error outcome.
   */
  onTurnComplete(entries: TranscriptEntry[]): void | Promise<void>;
  /**
   * New inbox items (results, steering, messages). Called before the first
   * model call and at every turn boundary while the run continues; returned
   * texts are injected as user messages before the next model call.
   */
  drainInbox(): Promise<string[]>;
  /** Stores output over the cap in full. Returns the artifact id. */
  spillOutput(text: string, label: string): Promise<string>;
  /**
   * Asked before every model call of the run, compaction summaries and
   * overflow retries included. Returns why the call may not start (a spend
   * cap was reached), or undefined to let it go. A refused call is never sent
   * and reports no events; the run ends with `budget` (`limit: "spend"`).
   */
  admitModelCall?(): Promise<string | undefined>;
  /**
   * Asked before each tool call runs, after its arguments are validated
   * (absent: every call runs). See `ToolCallVerdict`. A rejection ends the
   * run with an error outcome, like `onEvent`'s.
   */
  reviewToolCall?(call: PendingToolCall): Promise<ToolCallVerdict>;
  /**
   * Claims the approved call of `RunInput.decision` right before it runs
   * (absent: always claimed). False when an earlier run claimed it: that run
   * may have started it, so it is answered as interrupted with an unknown
   * outcome and never run again.
   */
  claimApprovedCall?(toolCallId: string): Promise<boolean>;
}

export interface RunBudgets {
  /** Most model calls in this run. */
  maxTurns: number;
  /** The run stops (outcome `budget`) when this passes, interrupting what is in flight. */
  deadline: Date;
}

/** Which budget ended a run: model calls, the deadline, or a spend cap. */
export type BudgetLimit = "turns" | "deadline" | "spend";

export interface RunInput {
  sessionId: string;
  runId: string;
  systemPrompt: string;
  /**
   * Persisted entries, oldest first. The context is rebuilt from the latest
   * compaction entry, and dangling tool calls are repaired before use.
   */
  transcript: TranscriptEntry[];
  /** New user-role messages for this run: the brief first, then results, steering and messages on wake. */
  inputs: string[];
  /** The bot's model; null uses the registry default. */
  model: ModelRef | null;
  sandbox: Sandbox;
  /**
   * The profile's sandbox limits. A model-chosen bash timeout is clamped to
   * `execTimeoutMs` with `resolveExecTimeoutMs` (drivers apply the same rule),
   * and bash keeps at most `maxOutputBytes` of a command's output.
   */
  sandboxLimits: Pick<SandboxLimits, "execTimeoutMs" | "maxOutputBytes">;
  /** Coding tools the profile grants. */
  codingTools: readonly ToolName[];
  collaborationTools: readonly CollabTool[];
  budgets: RunBudgets;
  /** Aborting stops the model call and the in-flight sandbox command. Outcome `aborted`. */
  signal: AbortSignal;
  hooks: RunHooks;
  /**
   * Replaces the server's secret values. The runtime applies it to tool
   * output, tool summaries and model text before any cap, clip or spill, so
   * a cut never leaves part of a secret; the engine redacts again on write.
   */
  redact?: (text: string) => string;
  /**
   * The user's answer to the call an earlier run held. Applied before the
   * first model call while the call is still unanswered in the transcript
   * (otherwise ignored): an approved call runs once, after
   * `claimApprovedCall`, with its arguments as stored; a denied one gets
   * `text` as its error result. The run then goes on like any other.
   */
  decision?: HeldCallDecision;
}

export type RunOutcome =
  /** The model ended its turn (or a tool ended the run); `finalText` is its last text. */
  | { kind: "ended"; finalText: string }
  /** Woken with no inputs and an empty inbox: nothing was run. */
  | { kind: "idle" }
  /** A call waits for the user's approval (`reviewToolCall` held it); the run ended after its batch. */
  | { kind: "held" }
  /**
   * The signal was aborted, or the sandbox was released under the run
   * (`reason: "sandbox_released"`): what was in flight was stopped.
   */
  | { kind: "aborted"; reason?: "sandbox_released" }
  /**
   * Stopped at `maxTurns` or the deadline while the model still wanted to go
   * on, or before a model call `admitModelCall` refused (`limit: "spend"`,
   * `reason` its refusal).
   */
  | {
      kind: "budget";
      finalText: string;
      limit: BudgetLimit;
      reason?: string;
    }
  /** `error` is redacted: no provider key or key-shaped text. */
  | { kind: "error"; code: RunErrorCode; error: string };

/** What the engine calls to run a session. */
export interface RunExecutor {
  run(input: RunInput): Promise<RunOutcome>;
}
