import type {
  AssistantMessage,
  ToolResultMessage,
  TSchema,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { ModelRef, ToolName, Usage } from "@jj/contracts";
import type { Interrupted, Sandbox, SandboxLimits } from "@jj/sandbox";
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
  /** TypeBox schema (`Type` from `@earendil-works/pi-ai`) or plain JSON Schema. */
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

/** One tool call of a model response, as `RunHooks.reviewTurn` sees it. */
export interface TurnCall {
  toolCallId: string;
  tool: string;
}

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
   * `turnEnded` is true at the boundary after a model turn that called no
   * tools, where the model ended its turn: anything returned there makes it
   * take another, so the engine returns only input that continues a run.
   */
  drainInbox(turnEnded?: boolean): Promise<string[]>;
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
   * Asked once for each model response that calls tools, with all of its
   * calls, after the response is persisted and before any of them runs
   * (absent: they all run). Returns text to end the run at this turn, or
   * undefined to go on. With text, none of the calls runs: each is answered
   * with the text as its error result (its tool events reported as usual),
   * and the run ends `ended` with empty `finalText` once the batch is
   * answered, without draining the inbox again. Not asked for a response cut
   * at the output limit, whose calls pi refuses itself. A rejection ends the
   * run with an error outcome, like `onEvent`'s.
   */
  reviewTurn?(calls: readonly TurnCall[]): Promise<string | undefined>;
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
}

export type RunOutcome =
  /**
   * The model ended its turn, or a tool or `reviewTurn` ended the run;
   * `finalText` is its last text (empty when `reviewTurn` ended it).
   */
  | { kind: "ended"; finalText: string }
  /** Woken with no inputs and an empty inbox: nothing was run. */
  | { kind: "idle" }
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
