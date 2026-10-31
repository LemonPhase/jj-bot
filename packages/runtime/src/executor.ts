import { TOOL_OUTPUT_PREVIEW_LIMIT } from "@jj/contracts";
import { assistantText, collabAgentTool, runLoop, userMessage } from "./loop";
import {
  type ModelRegistry,
  ModelResolutionError,
  type ResolvedModel,
} from "./models";
import { createSandboxTools, type OutputPolicy } from "./tools";
import { appendedRepairs, repairTranscript } from "./transcript";
import type { RunExecutor, RunInput, RunOutcome } from "./types";

export interface PiSessionExecutorOptions {
  models: ModelRegistry;
  /**
   * UTF-8 bytes of tool output the model and events see (`JJ_OUTPUT_CAP_BYTES`).
   * Clamped to `TOOL_OUTPUT_PREVIEW_LIMIT`; larger output is spilled.
   */
  outputCapBytes?: number;
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

  constructor(options: PiSessionExecutorOptions) {
    this.models = options.models;
    this.capBytes = resolveOutputCap(options.outputCapBytes);
  }

  async run(input: RunInput): Promise<RunOutcome> {
    if (input.signal.aborted) return { kind: "aborted" };
    let resolved: ResolvedModel;
    try {
      resolved = this.models.resolve(input.model);
    } catch (error) {
      if (error instanceof ModelResolutionError)
        return { kind: "error", error: error.message };
      throw error;
    }
    const { hooks } = input;
    const policy: OutputPolicy = {
      capBytes: this.capBytes,
      spill: (text, label) => hooks.spillOutput(text, label),
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
    ];
    const transcript = repairTranscript(input.transcript);
    const repairs = appendedRepairs(input.transcript, transcript);
    const drain = async () =>
      (await hooks.drainInbox())
        .filter((text) => text.trim().length > 0)
        .map((text) => userMessage(text));

    let inputs = input.inputs
      .filter((text) => text.trim().length > 0)
      .map((text) => userMessage(text));
    const tail = transcript.at(-1);
    if (inputs.length === 0 && (!tail || tail.role === "assistant")) {
      // Nothing to answer yet: take what is in the inbox, else there is no work.
      inputs = await drain();
      if (inputs.length === 0) {
        if (repairs.length > 0) await hooks.onTurnComplete(repairs);
        return tail?.role === "assistant"
          ? { kind: "ended", finalText: assistantText(tail) }
          : {
              kind: "error",
              error: "Nothing to run: no transcript and no inputs.",
            };
      }
    }

    const outcome = await runLoop({
      resolved,
      streamFn: this.models.streamFn,
      sessionId: input.sessionId,
      systemPrompt: input.systemPrompt,
      tools,
      collabTools: input.collaborationTools,
      transcript,
      pendingEntries: repairs,
      inputs,
      maxTurns: Math.max(1, Math.floor(input.budgets.maxTurns)),
      deadline: input.budgets.deadline,
      signal,
      endRequested: () => endRequested,
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
