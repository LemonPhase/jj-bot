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
  type Message,
  type Usage as PiUsage,
  toToolDeclaration,
  type UserMessage,
} from "@earendil-works/pi-ai";
import {
  type ModelRef,
  TOOL_OUTPUT_PREVIEW_LIMIT,
  type Usage,
} from "@jj/contracts";
import type { ResolvedModel } from "./models";
import {
  finalizeResult,
  isSandboxReleased,
  type OutputPolicy,
  type ToolCallDetails,
} from "./tools";
import type { CollabTool, ExecutorEvent, PiMessage, RunOutcome } from "./types";

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
  return clip(summary.replace(/\s+/g, " ").trim() || tool, 300);
}

export interface LoopSpec {
  resolved: ResolvedModel;
  streamFn: StreamFn;
  sessionId?: string;
  systemPrompt: string;
  tools: AgentTool[];
  collabTools: readonly CollabTool[];
  transcript: PiMessage[];
  /** Entries to persist before the first model call (inputs are added by the loop). */
  pendingEntries?: PiMessage[];
  inputs: UserMessage[];
  maxTurns: number;
  deadline?: Date;
  signal: AbortSignal;
  /** True once a tool asked to end the run. */
  endRequested(): boolean;
  getSteering(): Promise<UserMessage[]>;
  persist(entries: PiMessage[]): Promise<void>;
  onEvent(event: ExecutorEvent): Promise<void>;
}

const persistable = (message: AgentMessage): message is PiMessage =>
  message.role === "user" ||
  message.role === "toolResult" ||
  (message.role === "assistant" &&
    message.stopReason !== "error" &&
    message.stopReason !== "aborted");

const hasToolCalls = (message: AssistantMessage) =>
  message.content.some((block) => block.type === "toolCall");

/**
 * Runs pi's low-level agent loop over a transcript we own: no pi session
 * files, no settings, no context files. Persistence, steering, budgets and
 * abort are wired through the loop's hooks.
 */
export async function runLoop(spec: LoopSpec): Promise<RunOutcome> {
  const { resolved } = spec;
  const ref: ModelRef = resolved.ref;
  const controller = new AbortController();
  const signal = controller.signal;
  let deadlineHit = false;
  let budgetHit = false;
  let turns = 0;
  const forwardAbort = () => controller.abort(spec.signal.reason);
  if (spec.signal.aborted) return { kind: "aborted" };
  spec.signal.addEventListener("abort", forwardAbort, { once: true });
  let timer: NodeJS.Timeout | undefined;
  if (spec.deadline) {
    const remaining = spec.deadline.getTime() - Date.now();
    if (remaining <= 0) {
      spec.signal.removeEventListener("abort", forwardAbort);
      return { kind: "budget", finalText: "" };
    }
    timer = setTimeout(
      () => {
        deadlineHit = true;
        controller.abort(new Error("deadline"));
      },
      Math.min(remaining, MAX_TIMER_MS),
    );
  }

  const pending: PiMessage[] = [...(spec.pendingEntries ?? [])];
  const flush = async () => {
    if (pending.length === 0) return;
    const batch = pending.splice(0, pending.length);
    await spec.persist(batch);
  };
  const produced: AgentMessage[] = [];
  const calls = new Map<string, { tool: string; summary: string }>();
  const collabByName = new Map(
    spec.collabTools.map((tool) => [tool.name, tool]),
  );

  const emit = async (event: AgentEvent) => {
    switch (event.type) {
      case "message_end": {
        const message = event.message;
        produced.push(message);
        if (persistable(message)) pending.push(message);
        if (message.role === "assistant") {
          const text = assistantText(message);
          await spec.onEvent({
            type: "model.finished",
            model: ref,
            stopReason: message.stopReason,
            usage: toContractUsage(message.usage),
            ...(text ? { text: clip(text, 2000) } : {}),
            ...(message.stopReason === "error" && message.errorMessage
              ? { error: message.errorMessage }
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
        const result = event.result as {
          content?: { type: string; text?: string }[];
          details?: Partial<ToolCallDetails>;
        };
        const details = result?.details ?? {};
        const output = (result?.content ?? [])
          .filter((block) => block.type === "text")
          .map((block) => block.text ?? "")
          .join("\n");
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
      case "turn_end":
        await flush();
        return;
      default:
        return;
    }
  };

  const config: AgentLoopConfig = {
    model: resolved.model,
    ...(spec.sessionId ? { sessionId: spec.sessionId } : {}),
    // Don't attribute requests to the pi CLI.
    identity: { attribution: null },
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
    prepareRequest: async () => {
      await flush();
      turns++;
      await spec.onEvent({ type: "model.started", model: ref });
      return undefined;
    },
    finishTurn: async (turn) => {
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
  const context: AgentContext = {
    messages: [
      ...(() => {
        const system = createInitialSystemMessage(
          spec.systemPrompt,
          tools.map(toToolDeclaration),
        );
        return system ? [system] : [];
      })(),
      ...spec.transcript,
    ],
    tools,
  };

  let loopError: unknown;
  try {
    if (spec.inputs.length > 0)
      await runAgentLoop(
        spec.inputs,
        context,
        config,
        emit,
        signal,
        spec.streamFn,
      );
    else
      await runAgentLoopContinue(context, config, emit, signal, spec.streamFn);
    await flush();
  } catch (error) {
    loopError = error;
  } finally {
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
  if (loopError !== undefined)
    return {
      kind: "error",
      error: loopError instanceof Error ? loopError.message : String(loopError),
    };
  if (last?.stopReason === "error" || last?.stopReason === "aborted")
    return {
      kind: "error",
      error:
        last.errorMessage || `The model call ended with ${last.stopReason}.`,
    };
  return { kind: "ended", finalText };
}
