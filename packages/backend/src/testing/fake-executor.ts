// A deterministic RunExecutor for engine tests. It behaves like the pi runtime
// at the port: it repairs dangling tool calls, persists inputs, tool calls and
// results through onTurnComplete, drains the inbox at turn boundaries, runs
// bash and file tools on the real sandbox, calls the engine's collaboration
// tools, honours endRun and abort, and spills oversized output. What the
// "model" says each turn comes from a per-bot brain: a pure function of the
// conversation so far.
import type { Usage } from "@jj/contracts";
import type {
  CollabTool,
  ExecutorEvent,
  RunExecutor,
  RunInput,
  RunOutcome,
} from "../ports";

export type FakeMessage =
  | { role: "user"; text: string }
  /** Text in pi's content-block shape, as the engine reads it on recovery. */
  | {
      role: "assistant";
      content: { type: "text"; text: string }[];
      calls: FakeCall[];
    }
  | {
      role: "tool";
      callId: string;
      name: string;
      text: string;
      isError: boolean;
    };

export interface FakeCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface FakeTurn {
  text?: string;
  calls?: { name: string; args: Record<string, unknown> }[];
}

export interface BrainView {
  bot: string;
  role: "coordinator" | "worker";
  systemPrompt: string;
  messages: FakeMessage[];
  tools: readonly CollabTool[];
  input: RunInput;
}

export type Brain = (view: BrainView) => FakeTurn | Promise<FakeTurn>;

export const FAKE_MODEL = "fake/model";
export const FAKE_USAGE: Usage = {
  modelCalls: 1,
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.25,
};
export const INTERRUPTED_RESULT =
  "Interrupted by a restart; the outcome is unknown. Check the workspace before retrying.";
const SPILL_BYTES = 64 * 1024;

export interface Gate {
  /** Resolves when a run reaches the gate. */
  reached: Promise<void>;
  open(): void;
}

interface GateState {
  reached: Promise<void>;
  markReached: () => void;
  opened: Promise<void>;
  open: () => void;
}

/** Bot name from the engine's session prompt ("You are <name>, … a bot on a JJ Bot team."). */
export function promptBot(systemPrompt: string): string {
  const match = /^You are (.+?)(?:, [^\n]*)?, a bot on a JJ Bot team\./.exec(
    systemPrompt,
  );
  return match?.[1] ?? "unknown";
}

export class FakeExecutor implements RunExecutor {
  readonly brains = new Map<string, Brain>();
  /** Every bash command actually executed, in order. */
  readonly executed: { bot: string; command: string }[] = [];
  /** Every run input, for prompt assertions. */
  readonly inputs: RunInput[] = [];
  private readonly gates = new Map<string, GateState>();
  private calls = 0;

  brain(bot: string, brain: Brain): this {
    this.brains.set(bot, brain);
    return this;
  }

  gate(name: string): Gate {
    const state = this.gateState(name);
    return { reached: state.reached, open: state.open };
  }

  private gateState(name: string): GateState {
    let state = this.gates.get(name);
    if (!state) {
      let markReached = () => {};
      let open = () => {};
      const reached = new Promise<void>((resolve) => {
        markReached = resolve;
      });
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      state = { reached, markReached, opened, open };
      this.gates.set(name, state);
    }
    return state;
  }

  async run(input: RunInput): Promise<RunOutcome> {
    this.inputs.push(input);
    if (input.signal.aborted) return { kind: "aborted", reason: "signal" };
    const bot = promptBot(input.systemPrompt);
    const brain = this.brains.get(bot);
    if (!brain) return { kind: "error", error: `No brain for ${bot}.` };
    const { hooks } = input;
    const messages = [...(input.transcript as FakeMessage[])];

    // Repair: a tool call without a result was cut off by a crash.
    const answered = new Set(
      messages.flatMap((message) =>
        message.role === "tool" ? [message.callId] : [],
      ),
    );
    const repairs: FakeMessage[] = [];
    for (const message of messages)
      if (message.role === "assistant")
        for (const call of message.calls)
          if (!answered.has(call.id))
            repairs.push({
              role: "tool",
              callId: call.id,
              name: call.name,
              text: INTERRUPTED_RESULT,
              isError: true,
            });
    if (repairs.length > 0) {
      await hooks.onTurnComplete(repairs);
      messages.push(...repairs);
    }

    let inputs = input.inputs.map(
      (text): FakeMessage => ({ role: "user", text }),
    );
    const tail = messages.at(-1);
    if (inputs.length === 0 && (!tail || tail.role === "assistant")) {
      inputs = (await hooks.drainInbox()).map((text) => ({
        role: "user",
        text,
      }));
      if (inputs.length === 0) return { kind: "idle" };
    }
    if (inputs.length > 0) {
      await hooks.onTurnComplete(inputs);
      messages.push(...inputs);
    }

    let lastText = "";
    for (let turn = 0; turn < input.budgets.maxTurns; turn += 1) {
      if (input.signal.aborted) return { kind: "aborted", reason: "signal" };
      await hooks.onEvent({ type: "model.started", model: FAKE_MODEL });
      const decision = await brain({
        bot,
        role: input.collaborationTools.some(
          (tool) => tool.name === "complete_task",
        )
          ? "coordinator"
          : "worker",
        systemPrompt: input.systemPrompt,
        messages,
        tools: input.collaborationTools,
        input,
      });
      if (input.signal.aborted) return { kind: "aborted", reason: "signal" };
      const calls = (decision.calls ?? []).map((call) => ({
        ...call,
        id: `call_${(this.calls += 1)}`,
      }));
      const text = decision.text ?? "";
      const assistant: FakeMessage = {
        role: "assistant",
        content: text ? [{ type: "text", text }] : [],
        calls,
      };
      lastText = text;
      await hooks.onEvent({
        type: "model.finished",
        model: FAKE_MODEL,
        stopReason: calls.length > 0 ? "toolUse" : "stop",
        usage: FAKE_USAGE,
        ...(text ? { text } : {}),
      });
      messages.push(assistant);
      if (calls.length === 0) {
        await hooks.onTurnComplete([assistant]);
        const steering = await this.drain(input, messages);
        if (steering) continue;
        return { kind: "ended", finalText: text };
      }
      await hooks.onTurnComplete([assistant]);
      const results: FakeMessage[] = [];
      let endRun = false;
      for (const call of calls) {
        const result = await this.runTool(bot, input, call);
        if (input.signal.aborted) return { kind: "aborted", reason: "signal" };
        results.push({
          role: "tool",
          callId: call.id,
          name: call.name,
          text: result.text,
          isError: result.isError ?? false,
        });
        if (result.endRun) endRun = true;
      }
      await hooks.onTurnComplete(results);
      messages.push(...results);
      if (endRun) return { kind: "ended", finalText: text };
      await this.drain(input, messages);
    }
    return { kind: "budget", finalText: lastText };
  }

  private async drain(input: RunInput, messages: FakeMessage[]) {
    const steering = (await input.hooks.drainInbox()).map(
      (text): FakeMessage => ({ role: "user", text }),
    );
    if (steering.length === 0) return false;
    await input.hooks.onTurnComplete(steering);
    messages.push(...steering);
    return true;
  }

  private async runTool(
    bot: string,
    input: RunInput,
    call: FakeCall,
  ): Promise<{ text: string; isError?: boolean; endRun?: boolean }> {
    const { hooks, sandbox, signal } = input;
    const collab = input.collaborationTools.find(
      (tool) => tool.name === call.name,
    );
    const summary = collab
      ? (collab.summarize?.(call.args) ?? call.name)
      : String(call.args.command ?? call.args.path ?? call.args.name ?? "");
    await hooks.onEvent({
      type: "tool.started",
      toolCallId: call.id,
      tool: call.name,
      summary,
    });
    const finish = async (
      event: Omit<
        Extract<ExecutorEvent, { type: "tool.finished" }>,
        "type" | "toolCallId" | "tool" | "summary"
      >,
    ) => {
      await hooks.onEvent({
        type: "tool.finished",
        toolCallId: call.id,
        tool: call.name,
        summary,
        ...event,
      });
    };
    if (collab) {
      const result = await collab.execute(call.args, {
        toolCallId: call.id,
        signal,
      });
      await finish({
        ok: !result.isError,
        output: result.text,
        truncated: false,
      });
      return result;
    }
    switch (call.name) {
      case "bash": {
        const command = String(call.args.command);
        this.executed.push({ bot, command });
        const result = await sandbox.exec(command, { signal });
        let output = `${result.stdout}${result.stderr}`;
        let artifactId: string | undefined;
        let truncated = result.truncated;
        if (Buffer.byteLength(output) > SPILL_BYTES) {
          artifactId = await hooks.spillOutput(
            output,
            `bash output: ${command}`,
          );
          output = output.slice(0, 1000);
          truncated = true;
        }
        await finish({
          ok: result.exitCode === 0,
          exitCode: result.exitCode,
          interrupted: result.interrupted,
          output,
          truncated,
          ...(artifactId ? { artifactId } : {}),
        });
        return { text: output || `exit ${result.exitCode}` };
      }
      case "raw_output": {
        // Reports oversized output without spilling: the engine must cap it.
        const output = "y".repeat(Number(call.args.bytes));
        await finish({ ok: true, exitCode: 0, output, truncated: false });
        return { text: "done" };
      }
      case "write": {
        await sandbox.fs.write(
          String(call.args.path),
          String(call.args.content),
        );
        await finish({ ok: true, truncated: false });
        return { text: `Wrote ${String(call.args.path)}` };
      }
      case "read": {
        const content = await sandbox.fs
          .read(String(call.args.path))
          .then((buffer) => buffer.toString("utf8"))
          .catch((error: unknown) => `Error: ${String(error)}`);
        await finish({ ok: true, output: content, truncated: false });
        return { text: content };
      }
      case "gate": {
        const gate = this.gateState(String(call.args.name));
        gate.markReached();
        const aborted = new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        await Promise.race([gate.opened, aborted]);
        if (signal.aborted) {
          await finish({ ok: false, interrupted: "yes", truncated: false });
          return { text: "interrupted", isError: true };
        }
        await finish({ ok: true, truncated: false });
        return { text: `passed ${String(call.args.name)}` };
      }
      default:
        await finish({ ok: false, output: "unknown tool", truncated: false });
        return { text: `Unknown tool ${call.name}`, isError: true };
    }
  }
}

/** Helpers for writing brains. */
export const said = {
  /** User-role texts so far (brief, results, steering). */
  inputs: (view: BrainView) =>
    view.messages.flatMap((message) =>
      message.role === "user" ? [message.text] : [],
    ),
  /** Tool results so far. */
  results: (view: BrainView) =>
    view.messages.filter(
      (message): message is Extract<FakeMessage, { role: "tool" }> =>
        message.role === "tool",
    ),
  /** How many assistant turns this session has taken. */
  turns: (view: BrainView) =>
    view.messages.filter((message) => message.role === "assistant").length,
  /** Whether any input contains the text. */
  heard: (view: BrainView, text: string) =>
    view.messages.some(
      (message) => message.role === "user" && message.text.includes(text),
    ),
};
