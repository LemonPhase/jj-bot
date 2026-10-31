import type {
  AssistantMessage,
  ToolResultMessage,
  TSchema,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { ModelRef, ToolName, Usage } from "@jj/contracts";
import type { Interrupted, Sandbox, SandboxLimits } from "@jj/sandbox";

/**
 * One persisted transcript entry: a pi message, stored as JSON in
 * `session_entries`. System messages are never persisted; the system prompt is
 * rebuilt for every run.
 */
export type PiMessage = UserMessage | AssistantMessage | ToolResultMessage;

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

/** A tool supplied by the engine: delegate, message, complete_task, create_task, send_to_task. */
export interface CollabTool {
  name: string;
  description: string;
  /** TypeBox schema (`Type` from `@earendil-works/pi-ai`) or plain JSON Schema. */
  parameters: TSchema;
  /** Activity summary for `tool.started`, such as the delegate's bot name. Default: the tool name. */
  summarize?(args: Record<string, unknown>): string;
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
      /** Provider error text when `stopReason` is "error". */
      error?: string;
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

export interface RunHooks {
  onEvent(event: ExecutorEvent): void | Promise<void>;
  /**
   * Persist these entries, in order, before the run goes on. Called with the
   * run's inputs and any injected steering before the model call that sees
   * them, with an assistant message that calls tools before those tools run
   * (so a crash mid-tool leaves a call for `repairTranscript`), and with each
   * turn's tool results or final message when the turn completes. A rejection
   * ends the run with an error outcome.
   */
  onTurnComplete(entries: PiMessage[]): void | Promise<void>;
  /**
   * New inbox items (results, steering, messages). Called before the first
   * model call and at every turn boundary while the run continues; returned
   * texts are injected as user messages before the next model call.
   */
  drainInbox(): Promise<string[]>;
  /** Stores output over the cap in full. Returns the artifact id. */
  spillOutput(text: string, label: string): Promise<string>;
}

export interface RunBudgets {
  /** Most model calls in this run. */
  maxTurns: number;
  /** The run stops (outcome `budget`) when this passes, interrupting what is in flight. */
  deadline: Date;
}

export interface RunInput {
  sessionId: string;
  runId: string;
  systemPrompt: string;
  /** Persisted entries, oldest first. Dangling tool calls are repaired before use. */
  transcript: PiMessage[];
  /** New user-role messages for this run: the brief first, then results, steering and messages on wake. */
  inputs: string[];
  /** The bot's model; null uses the registry default. */
  model: ModelRef | null;
  sandbox: Sandbox;
  /**
   * The profile's sandbox limits. A model-chosen bash timeout is clamped to
   * `execTimeoutMs` with `resolveExecTimeoutMs` (drivers apply the same rule).
   */
  sandboxLimits: Pick<SandboxLimits, "execTimeoutMs">;
  /** Coding tools the profile grants. */
  codingTools: readonly ToolName[];
  collaborationTools: readonly CollabTool[];
  budgets: RunBudgets;
  /** Aborting stops the model call and the in-flight sandbox command. Outcome `aborted`. */
  signal: AbortSignal;
  hooks: RunHooks;
}

export type RunOutcome =
  | { kind: "ended"; finalText: string }
  /**
   * The signal was aborted, or the sandbox was released under the run
   * (`reason: "sandbox_released"`): what was in flight was stopped.
   */
  | { kind: "aborted"; reason?: "sandbox_released" }
  | { kind: "budget"; finalText: string }
  | { kind: "error"; error: string };

/** What the engine calls to run a session. */
export interface RunExecutor {
  run(input: RunInput): Promise<RunOutcome>;
}
