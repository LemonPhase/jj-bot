// Calls that wait for the user's approval: a held call never runs, an
// approved one runs once (never again after a claim), a denied one reaches
// the model as an error result.
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { CODING_TOOLS } from "@jj/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiSessionExecutor } from "./executor";
import { ModelRegistry } from "./models";
import {
  budgets,
  conversation,
  expecting,
  lastMessage,
  localSandbox,
  recordingHooks,
  say,
  textOf,
} from "./test-support";
import {
  INTERRUPTED_BY_RESTART,
  parseTranscript,
  repairTranscript,
  serializeEntry,
} from "./transcript";
import type {
  ExecutorEvent,
  PendingToolCall,
  PiMessage,
  RunHooks,
  RunInput,
  ToolCallVerdict,
  TranscriptEntry,
} from "./types";

type Faux = ReturnType<typeof fauxProvider>;

let faux: Faux;
let registry: ModelRegistry;
let workspace: Awaited<ReturnType<typeof localSandbox>>;

beforeEach(async () => {
  faux = fauxProvider();
  registry = new ModelRegistry({ env: {}, extraProviders: [faux.provider] });
  workspace = await localSandbox();
});

afterEach(async () => {
  await workspace.cleanup();
});

/** Each run of it appends a line, so the line count is how often it ran. */
const PUSH = "echo ran >> pushed.txt; wc -l < pushed.txt # git push";

function input(
  overrides: Partial<RunInput> & Pick<RunInput, "hooks">,
): RunInput {
  return {
    sessionId: "session-1",
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

/** Holds bash commands that mention `git push`, records what it was asked. */
function reviewing(hooks: RunHooks) {
  const asked: PendingToolCall[] = [];
  const review = async (call: PendingToolCall): Promise<ToolCallVerdict> => {
    asked.push(call);
    return call.tool === "bash" &&
      String(call.args.command).includes("git push")
      ? "hold"
      : "run";
  };
  return { hooks: { ...hooks, reviewToolCall: review }, asked };
}

const toolEvents = (events: ExecutorEvent[], toolCallId: string) =>
  events.filter(
    (event) =>
      (event.type === "tool.started" || event.type === "tool.finished") &&
      event.toolCallId === toolCallId,
  );

/** The result of one call in what the model received. */
const resultOf = (
  context: Parameters<Parameters<typeof expecting>[0]>[0],
  id: string,
) =>
  conversation(context).find(
    (message) => message.role === "toolResult" && message.toolCallId === id,
  );

const results = (entries: readonly TranscriptEntry[]) =>
  entries.filter(
    (entry): entry is ToolResultMessage => entry.role === "toolResult",
  );

const pushes = async () => {
  const stat = await workspace.sandbox.fs.stat("pushed.txt");
  if (!stat) return 0;
  return (await workspace.sandbox.fs.read("pushed.txt"))
    .toString()
    .split("\n")
    .filter(Boolean).length;
};

/** A first run that holds the push and runs the other call of its batch. */
async function heldRun() {
  faux.setResponses([
    fauxAssistantMessage(
      [
        fauxText("Pushing now."),
        fauxToolCall("bash", { command: PUSH }, { id: "push" }),
        fauxToolCall(
          "bash",
          { command: "echo other > other.txt" },
          { id: "other" },
        ),
      ],
      { stopReason: "toolUse" },
    ),
  ]);
  const recorded = recordingHooks();
  const review = reviewing(recorded.hooks);
  const outcome = await new PiSessionExecutor({ models: registry }).run(
    input({ hooks: review.hooks }),
  );
  // Stored and read back, as a restart would.
  const stored = parseTranscript(
    JSON.parse(JSON.stringify(recorded.entries.map(serializeEntry))),
  );
  return { outcome, recorded, review, stored };
}

describe("approval holds", () => {
  it("holds a call without running it, runs the rest of its batch and ends held", async () => {
    const { outcome, recorded, review } = await heldRun();

    expect(outcome).toEqual({ kind: "held" });
    expect(await pushes()).toBe(0);
    expect(await workspace.sandbox.fs.stat("other.txt")).toBeDefined();
    // The held call reports nothing; the other one runs as usual.
    expect(toolEvents(recorded.events, "push")).toEqual([]);
    expect(toolEvents(recorded.events, "other").map((e) => e.type)).toEqual([
      "tool.started",
      "tool.finished",
    ]);
    // No model call after the batch.
    expect(
      recorded.events.filter((event) => event.type === "model.started"),
    ).toHaveLength(1);
    // The transcript keeps the held call unanswered.
    expect(recorded.entries.map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
    expect(results(recorded.entries).map((r) => r.toolCallId)).toEqual([
      "other",
    ]);
    // The review saw the validated arguments, the summary and the bot's text.
    expect(review.asked.find((call) => call.toolCallId === "push")).toEqual({
      toolCallId: "push",
      tool: "bash",
      args: { command: PUSH },
      summary: PUSH,
      text: "Pushing now.",
    });
  });

  it("holds before the turn budget: the run ends held, not at the budget", async () => {
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("bash", { command: PUSH }), {
        stopReason: "toolUse",
      }),
    ]);
    const recorded = recordingHooks();
    const outcome = await new PiSessionExecutor({ models: registry }).run(
      input({ hooks: reviewing(recorded.hooks).hooks, budgets: budgets(1) }),
    );
    expect(outcome).toEqual({ kind: "held" });
    expect(await pushes()).toBe(0);
  });

  it("runs an approved call exactly once, in a fresh executor, then continues", async () => {
    const { stored } = await heldRun();

    const nextFaux = fauxProvider();
    const nextRegistry = new ModelRegistry({
      env: {},
      extraProviders: [nextFaux.provider],
    });
    nextFaux.setResponses([
      expecting((context) => {
        expect(textOf(resultOf(context, "push"))).toBe("1");
      }, say("Pushed.")),
    ]);
    const recorded = recordingHooks();
    const review = reviewing(recorded.hooks);
    const claims: string[] = [];
    const outcome = await new PiSessionExecutor({ models: nextRegistry }).run(
      input({
        hooks: {
          ...review.hooks,
          claimApprovedCall: async (id) => {
            claims.push(id);
            return true;
          },
        },
        transcript: stored,
        inputs: [],
        decision: { toolCallId: "push", approved: true },
      }),
    );

    expect(outcome).toEqual({ kind: "ended", finalText: "Pushed." });
    expect(await pushes()).toBe(1);
    expect(claims).toEqual(["push"]);
    // Not reviewed again: the user approved it.
    expect(review.asked).toEqual([]);
    expect(toolEvents(recorded.events, "push")).toMatchObject([
      { type: "tool.started", tool: "bash", summary: PUSH },
      { type: "tool.finished", ok: true, exitCode: 0, output: "1" },
    ]);
    expect(recorded.entries.map((entry) => entry.role)).toEqual([
      "toolResult",
      "assistant",
    ]);
    // Stored results go back in call order.
    const transcript = [...stored, ...recorded.entries] as PiMessage[];
    expect(
      repairTranscript(transcript)
        .filter((m) => m.role === "toolResult")
        .map((m) => (m as ToolResultMessage).toolCallId),
    ).toEqual(["push", "other"]);

    // The same decision again: the call has its result, so nothing runs.
    const again = recordingHooks();
    const replay = await new PiSessionExecutor({ models: nextRegistry }).run(
      input({
        hooks: { ...again.hooks, claimApprovedCall: async () => true },
        transcript,
        inputs: [],
        decision: { toolCallId: "push", approved: true },
      }),
    );
    expect(replay).toEqual({ kind: "idle" });
    expect(await pushes()).toBe(1);
  });

  it("never re-runs an approved call an earlier run claimed", async () => {
    const { stored } = await heldRun();
    faux.setResponses([
      expecting((context) => {
        expect(textOf(resultOf(context, "push"))).toBe(INTERRUPTED_BY_RESTART);
      }, say("I will check the workspace.")),
    ]);
    const recorded = recordingHooks();
    const outcome = await new PiSessionExecutor({ models: registry }).run(
      input({
        hooks: { ...recorded.hooks, claimApprovedCall: async () => false },
        transcript: stored,
        inputs: [],
        decision: { toolCallId: "push", approved: true },
      }),
    );
    expect(outcome.kind).toBe("ended");
    expect(await pushes()).toBe(0);
    expect(toolEvents(recorded.events, "push")).toEqual([]);
    expect(results(recorded.entries)[0]).toMatchObject({
      toolCallId: "push",
      isError: true,
      details: { interrupted: "unknown" },
    });
  });

  it("returns a denial to the model as an error result carrying the reason", async () => {
    const { stored } = await heldRun();
    const reason =
      "Not run: the user denied this call. Their reason: push to a branch instead.";
    faux.setResponses([
      expecting((context) => {
        const result = resultOf(context, "push");
        expect(result).toMatchObject({ role: "toolResult", isError: true });
        expect(textOf(result)).toBe(reason);
        expect(textOf(lastMessage(context))).toBe(
          "Message from the user:\nUse a branch.",
        );
      }, say("Understood.")),
    ]);
    const recorded = recordingHooks();
    const outcome = await new PiSessionExecutor({ models: registry }).run(
      input({
        hooks: {
          ...recorded.hooks,
          claimApprovedCall: async () => {
            throw new Error("a denied call is never claimed");
          },
        },
        transcript: stored,
        inputs: ["Message from the user:\nUse a branch."],
        decision: { toolCallId: "push", approved: false, text: reason },
      }),
    );
    expect(outcome).toEqual({ kind: "ended", finalText: "Understood." });
    expect(await pushes()).toBe(0);
    expect(toolEvents(recorded.events, "push")).toEqual([]);
    // The denial is stored first, before the input the run brought.
    expect(recorded.entries.map((entry) => entry.role)).toEqual([
      "toolResult",
      "user",
      "assistant",
    ]);
  });

  it("answers a refused call with the review's error and goes on", async () => {
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("bash", { command: PUSH }, { id: "push" }),
        {
          stopReason: "toolUse",
        },
      ),
      expecting((context) => {
        expect(textOf(lastMessage(context))).toBe("Not run: one at a time.");
      }, say("Noted.")),
    ]);
    const recorded = recordingHooks();
    const outcome = await new PiSessionExecutor({ models: registry }).run(
      input({
        hooks: {
          ...recorded.hooks,
          reviewToolCall: async () => ({ refuse: "Not run: one at a time." }),
        },
      }),
    );
    expect(outcome).toEqual({ kind: "ended", finalText: "Noted." });
    expect(await pushes()).toBe(0);
    expect(toolEvents(recorded.events, "push")).toMatchObject([
      { type: "tool.started" },
      { type: "tool.finished", ok: false },
    ]);
  });

  it("keeps the inputs when a stop interrupts the approved call", async () => {
    const controller = new AbortController();
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall(
          "bash",
          { command: "sleep 30 # git push" },
          { id: "slow" },
        ),
        { stopReason: "toolUse" },
      ),
    ]);
    const first = recordingHooks();
    expect(
      await new PiSessionExecutor({ models: registry }).run(
        input({ hooks: reviewing(first.hooks).hooks }),
      ),
    ).toEqual({ kind: "held" });

    const recorded = recordingHooks();
    const outcome = await new PiSessionExecutor({ models: registry }).run(
      input({
        hooks: {
          ...recorded.hooks,
          onEvent: (event) => {
            recorded.hooks.onEvent(event);
            if (event.type === "tool.started")
              setTimeout(() => controller.abort(), 200);
          },
        },
        signal: controller.signal,
        transcript: first.entries,
        inputs: ["Message from the user:\nHurry up."],
        decision: { toolCallId: "slow", approved: true },
      }),
    );
    expect(outcome).toEqual({ kind: "aborted" });
    expect(recorded.entries.map((entry) => entry.role)).toEqual([
      "toolResult",
      "user",
    ]);
    expect(results(recorded.entries)[0]?.details).toMatchObject({
      interrupted: expect.not.stringMatching(/^no$/),
    });
  });

  it("leaves open calls unanswered when repairing", () => {
    const assistant = fauxAssistantMessage(
      [
        fauxToolCall("bash", { command: "a" }, { id: "a" }),
        fauxToolCall("bash", { command: "b" }, { id: "b" }),
      ],
      { stopReason: "toolUse" },
    );
    const repaired = repairTranscript([assistant], new Set(["a"]));
    expect(
      repaired.map((message) =>
        message.role === "toolResult" ? message.toolCallId : message.role,
      ),
    ).toEqual(["assistant", "b"]);
  });
});
