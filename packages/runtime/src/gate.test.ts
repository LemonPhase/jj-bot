// The model call gate: a call the engine refuses (a spend cap) never reaches
// the provider, in session runs, their compaction calls and chat replies.
import {
  type AssistantMessage,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getSystemMessageText,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { CODING_TOOLS } from "@jj/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChatReplyError, ChatResponder } from "./chat";
import { PiSessionExecutor } from "./executor";
import { hasListedPrice, toContractUsage } from "./loop";
import { ModelRegistry } from "./models";
import { SCRIPTED_MODEL_REF, SCRIPTED_PRICED_MODEL_REF } from "./scripted";
import {
  budgets,
  callTool,
  localSandbox,
  recordingHooks,
  say,
} from "./test-support";
import type { ExecutorEvent, PiMessage, RunInput } from "./types";

type Faux = ReturnType<typeof fauxProvider>;

let faux: Faux;
let registry: ModelRegistry;
let workspace: Awaited<ReturnType<typeof localSandbox>>;

beforeEach(async () => {
  // faux-1 compacts past 10000 tokens of its 20000-token window.
  faux = fauxProvider({ models: [{ id: "faux-1", contextWindow: 20_000 }] });
  registry = new ModelRegistry({ env: {}, extraProviders: [faux.provider] });
  workspace = await localSandbox();
});

afterEach(async () => {
  await workspace.cleanup();
});

const REFUSAL = "The task reached its spend cap: $0.05 of $0.05.";

/** A gate that allows the first `allowed` calls and refuses every later one. */
function gate(allowed: number) {
  let asked = 0;
  return {
    get asked() {
      return asked;
    },
    admitModelCall: async () => {
      asked++;
      return asked > allowed ? REFUSAL : undefined;
    },
  };
}

/** A gate that allows the first `allowed` calls and holds every later one. */
function holding(allowed: number) {
  let asked = 0;
  return {
    get asked() {
      return asked;
    },
    admitModelCall: async () => {
      asked++;
      return asked > allowed
        ? { hold: "Waiting for the user's approval to spend past 80%." }
        : undefined;
    },
  };
}

function input(
  overrides: Partial<RunInput> & Pick<RunInput, "hooks">,
): RunInput {
  return {
    sessionId: "",
    runId: "run-1",
    systemPrompt: "You are a careful engineer.",
    transcript: [],
    inputs: ["Do the work."],
    model: "faux/faux-1",
    sandbox: workspace.sandbox,
    sandboxLimits: workspace.limits,
    codingTools: [...CODING_TOOLS],
    collaborationTools: [],
    budgets: budgets(),
    signal: new AbortController().signal,
    ...overrides,
  };
}

const modelEvents = (events: ExecutorEvent[]) =>
  events.filter(
    (event) =>
      event.type === "model.started" || event.type === "model.finished",
  );

const isSummaryRequest = (context: TranscriptContext) => {
  const system = context.messages[0];
  return (
    system?.role === "system" &&
    getSystemMessageText(system).includes("context summarization assistant")
  );
};

/** Answers summary requests and everything else separately, counting both. */
function respond(reply: AssistantMessage) {
  const requests: TranscriptContext[] = [];
  const summaries: TranscriptContext[] = [];
  const step = (context: TranscriptContext) => {
    if (isSummaryRequest(context)) {
      summaries.push(context);
      return say("Summary: counted the files so far.");
    }
    requests.push(context);
    return reply;
  };
  faux.setResponses(Array.from({ length: 10 }, () => step));
  return { requests, summaries };
}

/** A brief and `turns` commands with about 2000 tokens of output each. */
function longTranscript(turns: number): PiMessage[] {
  const messages: PiMessage[] = [
    {
      role: "user",
      content: [{ type: "text", text: "Count the files." }],
      timestamp: 1,
    },
  ];
  for (let i = 1; i <= turns; i++)
    messages.push(
      fauxAssistantMessage(
        fauxToolCall("bash", { command: `echo c${i}` }, { id: `c${i}` }),
        { stopReason: "toolUse", timestamp: 2 },
      ),
      {
        role: "toolResult",
        toolCallId: `c${i}`,
        toolName: "bash",
        content: [{ type: "text", text: `c${i}:${"x".repeat(8000)}` }],
        isError: false,
        timestamp: 3,
      },
    );
  return messages;
}

describe("the model call gate in a session run", () => {
  it("never sends a refused first call and ends the run at the spend limit", async () => {
    const recorded = recordingHooks();
    const admission = gate(0);
    faux.setResponses([say("Should never be asked.")]);
    const outcome = await new PiSessionExecutor({ models: registry }).run(
      input({
        hooks: { ...recorded.hooks, admitModelCall: admission.admitModelCall },
      }),
    );
    expect(outcome).toEqual({
      kind: "budget",
      limit: "spend",
      reason: REFUSAL,
      finalText: "",
    });
    expect(faux.getPendingResponseCount()).toBe(1);
    expect(admission.asked).toBe(1);
    expect(modelEvents(recorded.events)).toEqual([]);
    // The input is persisted, so the next run sees it; nothing else is.
    expect(recorded.entries.map((entry) => entry.role)).toEqual(["user"]);
  });

  it("stops before the next call once one is refused, keeping the earlier work", async () => {
    const recorded = recordingHooks();
    const admission = gate(1);
    faux.setResponses([
      callTool("bash", { command: "echo first" }),
      say("Never sent."),
    ]);
    const outcome = await new PiSessionExecutor({ models: registry }).run(
      input({
        hooks: { ...recorded.hooks, admitModelCall: admission.admitModelCall },
      }),
    );
    expect(outcome).toMatchObject({
      kind: "budget",
      limit: "spend",
      reason: REFUSAL,
    });
    expect(faux.getPendingResponseCount()).toBe(1);
    expect(modelEvents(recorded.events).map((event) => event.type)).toEqual([
      "model.started",
      "model.finished",
    ]);
    expect(
      recorded.events.filter((event) => event.type === "tool.finished"),
    ).toHaveLength(1);
    // The call, its result and nothing for the refused call.
    expect(recorded.entries.map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
  });

  it("asks before a compaction's summary call and never sends a refused one", async () => {
    const recorded = recordingHooks();
    const admission = gate(0);
    const { requests, summaries } = respond(say("All counted."));
    const outcome = await new PiSessionExecutor({ models: registry }).run(
      input({
        hooks: { ...recorded.hooks, admitModelCall: admission.admitModelCall },
        transcript: longTranscript(6),
        inputs: ["Now report the count."],
      }),
    );
    expect(outcome).toMatchObject({ kind: "budget", limit: "spend" });
    expect(summaries).toHaveLength(0);
    expect(requests).toHaveLength(0);
    expect(modelEvents(recorded.events)).toEqual([]);
    expect(
      recorded.entries.filter((entry) => entry.role === "compaction"),
    ).toHaveLength(0);
  });

  it("counts a compaction's call before the call it makes room for", async () => {
    const recorded = recordingHooks();
    const admission = gate(1);
    const { requests, summaries } = respond(say("All counted."));
    const outcome = await new PiSessionExecutor({ models: registry }).run(
      input({
        hooks: { ...recorded.hooks, admitModelCall: admission.admitModelCall },
        transcript: longTranscript(6),
        inputs: ["Now report the count."],
      }),
    );
    expect(outcome).toMatchObject({ kind: "budget", limit: "spend" });
    expect(summaries).toHaveLength(1);
    expect(requests).toHaveLength(0);
    expect(admission.asked).toBe(2);
  });

  it("never sends a held call: the run ends held and stores only its input", async () => {
    const recorded = recordingHooks();
    const admission = holding(0);
    faux.setResponses([say("Should never be asked.")]);
    const outcome = await new PiSessionExecutor({ models: registry }).run(
      input({
        hooks: { ...recorded.hooks, admitModelCall: admission.admitModelCall },
      }),
    );
    expect(outcome).toEqual({ kind: "held" });
    expect(faux.getPendingResponseCount()).toBe(1);
    expect(admission.asked).toBe(1);
    expect(modelEvents(recorded.events)).toEqual([]);
    expect(recorded.entries.map((entry) => entry.role)).toEqual(["user"]);
  });

  it("holds after earlier work, and the next run resumes from the stored transcript", async () => {
    const recorded = recordingHooks();
    const admission = holding(1);
    faux.setResponses([
      callTool("bash", { command: "echo first" }),
      say("Resumed and done."),
    ]);
    const executor = new PiSessionExecutor({ models: registry });
    const outcome = await executor.run(
      input({
        hooks: { ...recorded.hooks, admitModelCall: admission.admitModelCall },
      }),
    );
    expect(outcome).toEqual({ kind: "held" });
    expect(faux.getPendingResponseCount()).toBe(1);
    // The call, its result and nothing for the held call.
    expect(recorded.entries.map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);

    // Once answered, a run with no new input makes the held call.
    const resumed = recordingHooks();
    const again = await executor.run(
      input({
        hooks: { ...resumed.hooks, admitModelCall: async () => undefined },
        transcript: recorded.entries as PiMessage[],
        inputs: [],
      }),
    );
    expect(again).toEqual({ kind: "ended", finalText: "Resumed and done." });
    expect(faux.getPendingResponseCount()).toBe(0);
  });

  it("holds a compaction's summary call like any other", async () => {
    const recorded = recordingHooks();
    const admission = holding(0);
    const { requests, summaries } = respond(say("All counted."));
    const outcome = await new PiSessionExecutor({ models: registry }).run(
      input({
        hooks: { ...recorded.hooks, admitModelCall: admission.admitModelCall },
        transcript: longTranscript(6),
        inputs: ["Now report the count."],
      }),
    );
    expect(outcome).toEqual({ kind: "held" });
    expect(summaries).toHaveLength(0);
    expect(requests).toHaveLength(0);
    expect(modelEvents(recorded.events)).toEqual([]);
  });

  it("runs as before without the hook", async () => {
    const recorded = recordingHooks();
    faux.setResponses([say("Done.")]);
    const outcome = await new PiSessionExecutor({ models: registry }).run(
      input({ hooks: recorded.hooks }),
    );
    expect(outcome).toEqual({ kind: "ended", finalText: "Done." });
  });
});

describe("usage pricing", () => {
  const usage = {
    input: 1000,
    output: 100,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 1100,
    cost: {
      input: 0.001,
      output: 0.0004,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0.0014,
    },
  };
  const free = { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const priced = { cost: { input: 1, output: 4, cacheRead: 0, cacheWrite: 0 } };

  it("counts a call on a model with no listed price as unpriced, never as free", () => {
    expect(hasListedPrice(free)).toBe(false);
    expect(toContractUsage(usage, free)).toMatchObject({
      modelCalls: 1,
      costUsd: 0,
      unpricedCalls: 1,
    });
    expect(hasListedPrice(priced)).toBe(true);
    expect(toContractUsage(usage, priced)).toMatchObject({
      costUsd: 0.0014,
      unpricedCalls: 0,
    });
  });

  it("prices the scripted model's fictional-price variant and leaves the other unpriced", async () => {
    const scripted = new ModelRegistry({ env: {}, enableScripted: true });
    const responder = new ChatResponder({ models: scripted });
    const calls: { model: string; costUsd: number; unpriced: number }[] = [];
    for (const model of [SCRIPTED_MODEL_REF, SCRIPTED_PRICED_MODEL_REF])
      await responder.reply({
        systemPrompt: "You are Ada.",
        history: [{ role: "user", text: "Hi" }],
        model,
        tools: [],
        signal: new AbortController().signal,
        onUsage: async (used, ref) => {
          calls.push({
            model: ref,
            costUsd: used.costUsd,
            unpriced: used.unpricedCalls,
          });
        },
      });
    expect(calls).toEqual([
      { model: SCRIPTED_MODEL_REF, costUsd: 0, unpriced: 1 },
      {
        model: SCRIPTED_PRICED_MODEL_REF,
        costUsd: expect.any(Number),
        unpriced: 0,
      },
    ]);
    expect(calls[1]?.costUsd).toBeGreaterThan(0);
  });
});

describe("the model call gate in a chat reply", () => {
  it("never sends a refused call and fails the reply with spend_cap", async () => {
    faux.setResponses([say("Should never be asked.")]);
    const responder = new ChatResponder({ models: registry });
    const reply = responder.reply({
      systemPrompt: "You are Ada.",
      history: [{ role: "user", text: "Hi" }],
      model: "faux/faux-1",
      tools: [],
      signal: new AbortController().signal,
      admitModelCall: async () => REFUSAL,
    });
    await expect(reply).rejects.toMatchObject({
      name: "ChatReplyError",
      code: "spend_cap",
      message: REFUSAL,
    });
    await reply.catch((error) => {
      expect(error).toBeInstanceOf(ChatReplyError);
    });
    expect(faux.getPendingResponseCount()).toBe(1);
  });

  it("reports each call's usage as it finishes", async () => {
    faux.setResponses([say("Hello!")]);
    const used: number[] = [];
    const responder = new ChatResponder({ models: registry });
    const reply = await responder.reply({
      systemPrompt: "You are Ada.",
      history: [{ role: "user", text: "Hi" }],
      model: "faux/faux-1",
      tools: [],
      signal: new AbortController().signal,
      admitModelCall: async () => undefined,
      onUsage: async (usage) => {
        used.push(usage.modelCalls);
      },
    });
    expect(reply.text).toBe("Hello!");
    expect(used).toEqual([1]);
  });
});
