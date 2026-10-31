import type { RetryPolicy } from "@earendil-works/pi-ai";
import { TOOL_OUTPUT_PREVIEW_LIMIT } from "@jj/contracts";
import { type RetryOptions, redactSecrets, retryPolicy } from "./errors";
import { budgetProblem, collabAgentTool, runLoop, userMessage } from "./loop";
import {
  type ModelRegistry,
  ModelResolutionError,
  type ResolvedModel,
} from "./models";
import { createSandboxTools } from "./sandbox-tools";
import type { OutputPolicy } from "./tools";
import { appendedRepairs, repairTranscript } from "./transcript";
import type { RunExecutor, RunInput, RunOutcome } from "./types";

export interface PiSessionExecutorOptions {
  models: ModelRegistry;
  /**
   * UTF-8 bytes of tool output the model and events see (`JJ_OUTPUT_CAP_BYTES`).
   * Clamped to `TOOL_OUTPUT_PREVIEW_LIMIT`; larger output is spilled.
   */
  outputCapBytes?: number;
  /** Retries of transient provider failures (default: 3, from 1 s, at most 30 s apart). */
  retry?: RetryOptions;
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
  private readonly retry: RetryPolicy;

  constructor(options: PiSessionExecutorOptions) {
    this.models = options.models;
    this.capBytes = resolveOutputCap(options.outputCapBytes);
    this.retry = retryPolicy(options.retry);
  }

  async run(input: RunInput): Promise<RunOutcome> {
    const { hooks } = input;
    const transcript = repairTranscript(input.transcript);
    const repairs = appendedRepairs(input.transcript, transcript);
    let inputs = input.inputs
      .filter((text) => text.trim().length > 0)
      .map((text) => userMessage(text));
    // Whatever the engine handed over is persisted even when the run stops early.
    const exitEarly = async (outcome: RunOutcome): Promise<RunOutcome> => {
      const entries = [...repairs, ...inputs];
      try {
        if (entries.length > 0) await hooks.onTurnComplete(entries);
      } catch (error) {
        return {
          kind: "error",
          code: "unknown",
          error: redactSecrets(
            error instanceof Error ? error.message : String(error),
          ),
        };
      }
      return outcome;
    };

    let resolved: ResolvedModel;
    try {
      resolved = this.models.resolve(input.model);
    } catch (error) {
      if (!(error instanceof ModelResolutionError)) throw error;
      return exitEarly({
        kind: "error",
        code:
          error.code === "unconfigured" || error.code === "no_model"
            ? "auth"
            : "invalid_request",
        error: error.message,
      });
    }
    const problem = budgetProblem(
      input.budgets.maxTurns,
      input.budgets.deadline,
    );
    if (problem)
      return exitEarly({
        kind: "error",
        code: "invalid_request",
        error: problem,
      });
    // Checked before draining, so an inbox item is never taken by a run that cannot use it.
    if (input.signal.aborted) return exitEarly({ kind: "aborted" });
    if (input.budgets.deadline.getTime() <= Date.now())
      return exitEarly({ kind: "budget", finalText: "" });

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
    const drain = async () =>
      (await hooks.drainInbox())
        .filter((text) => text.trim().length > 0)
        .map((text) => userMessage(text));

    const tail = transcript.at(-1);
    if (inputs.length === 0 && (!tail || tail.role === "assistant")) {
      // A wake with nothing new: take what is in the inbox, else there is nothing to do.
      try {
        inputs = await drain();
      } catch (error) {
        return exitEarly({
          kind: "error",
          code: "unknown",
          error: redactSecrets(
            error instanceof Error ? error.message : String(error),
          ),
        });
      }
      if (inputs.length === 0) {
        if (repairs.length > 0) await hooks.onTurnComplete(repairs);
        return { kind: "idle" };
      }
    }

    // From here runLoop persists repairs and inputs on every path, early exits included.
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
      maxTurns: input.budgets.maxTurns,
      deadline: input.budgets.deadline,
      signal,
      retry: this.retry,
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
