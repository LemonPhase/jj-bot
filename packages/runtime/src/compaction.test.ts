import {
  type AssistantMessage,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  getSystemMessageText,
  type Message,
  type ToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { CODING_TOOLS } from "@jj/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  compactionSettings,
  isCompaction,
  summaryMessage,
  viewTranscript,
} from "./compaction";
import { PiSessionExecutor } from "./executor";
import { ModelRegistry } from "./models";
import { createScriptedProvider, scriptedCommands } from "./scripted";
import {
  budgets,
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
  CompactionEntry,
  ExecutorEvent,
  PiMessage,
  RunInput,
  TranscriptEntry,
} from "./types";

type Faux = ReturnType<typeof fauxProvider>;

let faux: Faux;
let registry: ModelRegistry;
let workspace: Awaited<ReturnType<typeof localSandbox>>;

/** A 4000-token window: compaction past 3000 tokens, keeping about 1000. */
const SMALL = { reserveTokens: 1000, keepRecentTokens: 1000 };
/** faux-1 has that window; faux-big never reaches the threshold, only a provider's overflow. */
const FAUX_MODELS = [
  { id: "faux-1", contextWindow: 4000 },
  { id: "faux-big", contextWindow: 100_000 },
];

beforeEach(async () => {
  faux = fauxProvider({ models: FAUX_MODELS });
  registry = new ModelRegistry({ env: {}, extraProviders: [faux.provider] });
  workspace = await localSandbox();
});

afterEach(async () => {
  await workspace.cleanup();
});

const executor = () =>
  new PiSessionExecutor({ models: registry, compaction: SMALL });

function input(
  overrides: Partial<RunInput> & Pick<RunInput, "hooks">,
): RunInput {
  return {
    sessionId: "session-1",
    runId: "run-1",
    systemPrompt: "You are a careful engineer.",
    transcript: [],
    inputs: [],
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

const user = (text: string, timestamp = 1): PiMessage => ({
  role: "user",
  content: [{ type: "text", text }],
  timestamp,
});
const call = (id: string, command: string): PiMessage =>
  fauxAssistantMessage(fauxToolCall("bash", { command }, { id }), {
    stopReason: "toolUse",
    timestamp: 2,
  });
const result = (id: string, text: string): PiMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "bash",
  content: [{ type: "text", text }],
  isError: false,
  timestamp: 3,
});

/** A brief and `turns` commands with about 500 tokens of output each. */
function longTranscript(turns: number, prefix = "c"): PiMessage[] {
  const messages: PiMessage[] = [
    user("Count the files, one command at a time."),
  ];
  for (let i = 1; i <= turns; i++)
    messages.push(
      call(`${prefix}${i}`, `echo ${prefix}${i}`),
      result(`${prefix}${i}`, `${prefix}${i}:${"x".repeat(2000)}`),
    );
  return messages;
}

const isSummaryRequest = (context: TranscriptContext) => {
  const system = context.messages[0];
  return (
    system?.role === "system" &&
    getSystemMessageText(system).includes("context summarization assistant")
  );
};

/**
 * Faux steps that answer summary requests with numbered summaries and every
 * other request with the next reply, recording each request.
 */
function respond(replies: AssistantMessage[]) {
  const requests: TranscriptContext[] = [];
  const summaries: TranscriptContext[] = [];
  const step = (context: TranscriptContext) => {
    if (isSummaryRequest(context)) {
      summaries.push(context);
      return say(`Summary ${summaries.length}: counted the files so far.`);
    }
    requests.push(context);
    return replies.shift() ?? say("No more replies.");
  };
  faux.setResponses(Array.from({ length: 30 }, () => step));
  return { requests, summaries };
}

const conversationOf = (context: TranscriptContext) =>
  context.messages.filter((message) => message.role !== "system");

const toolCallIds = (messages: readonly Message[]) =>
  messages.flatMap((message) =>
    message.role === "assistant"
      ? message.content.flatMap((block) =>
          block.type === "toolCall" ? [(block as ToolCall).id] : [],
        )
      : [],
  );
const resultIds = (messages: readonly Message[]) =>
  messages.flatMap((message) =>
    message.role === "toolResult" ? [message.toolCallId] : [],
  );

/** Every call answered exactly once, right after its own message. */
function expectValid(messages: readonly Message[]) {
  const calls = toolCallIds(messages);
  expect(new Set(calls).size).toBe(calls.length);
  expect(resultIds(messages)).toEqual(calls);
  messages.forEach((message, index) => {
    if (message.role !== "assistant") return;
    const ids = toolCallIds([message]);
    expect(
      resultIds(messages.slice(index + 1, index + 1 + ids.length)),
    ).toEqual(ids);
  });
}

const compactions = (entries: readonly TranscriptEntry[]) =>
  entries.filter(isCompaction);

const modelEvents = (events: ExecutorEvent[]) =>
  events.filter(
    (event) =>
      event.type === "model.started" || event.type === "model.finished",
  );

describe("viewTranscript", () => {
  it("leads with the latest summary, then the kept entries and everything after", () => {
    const first: CompactionEntry = {
      role: "compaction",
      summary: "one",
      keptEntries: 2,
      tokensBefore: 10,
      readFiles: [],
      modifiedFiles: [],
      timestamp: 5,
    };
    const second: CompactionEntry = {
      ...first,
      summary: "two",
      keptEntries: 3,
    };
    const stored: TranscriptEntry[] = [
      user("a"),
      call("1", "one"),
      result("1", "1"),
      user("b"),
      first,
      call("2", "two"),
      result("2", "2"),
    ];
    expect(viewTranscript(stored)).toEqual({
      compaction: first,
      messages: [
        result("1", "1"),
        user("b"),
        call("2", "two"),
        result("2", "2"),
      ],
      kept: 2,
    });
    // A later compaction's kept range may hold an earlier one; it is skipped.
    expect(viewTranscript([...stored, second, user("c")])).toEqual({
      compaction: second,
      messages: [call("2", "two"), result("2", "2"), user("c")],
      kept: 2,
    });
    expect(viewTranscript([user("a")])).toEqual({
      messages: [user("a")],
      kept: 0,
    });
  });

  it("round-trips compaction entries through storage and refuses malformed ones", () => {
    const entry: CompactionEntry = {
      role: "compaction",
      summary: "s",
      keptEntries: 1,
      tokensBefore: 3,
      readFiles: ["a.txt"],
      modifiedFiles: ["b.txt"],
      timestamp: 9,
    };
    const stored = JSON.parse(
      JSON.stringify([user("a"), entry].map(serializeEntry)),
    ) as unknown[];
    expect(parseTranscript(stored)).toEqual([user("a"), entry]);
    expect(() => parseTranscript([{ ...entry, keptEntries: -1 }])).toThrow(
      /entry 0/,
    );
  });

  it("words the summary in context exactly as pi does", () => {
    const entry: CompactionEntry = {
      role: "compaction",
      summary: "## Goal\nShip it.",
      keptEntries: 1,
      tokensBefore: 3,
      readFiles: [],
      modifiedFiles: [],
      timestamp: 9,
    };
    expect(
      convertToLlm([
        {
          role: "compactionSummary",
          summary: entry.summary,
          tokensBefore: entry.tokensBefore,
          timestamp: entry.timestamp,
        },
      ]),
    ).toEqual([summaryMessage(entry)]);
  });
});

describe("compactionSettings", () => {
  it("uses pi's defaults on a large window and clamps them on a small one", () => {
    expect(compactionSettings(128_000)).toEqual({
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
    });
    expect(compactionSettings(8_000)).toEqual({
      enabled: true,
      reserveTokens: 2_000,
      keepRecentTokens: 3_000,
    });
    expect(compactionSettings(0).enabled).toBe(false);
    expect(compactionSettings(128_000, { enabled: false }).enabled).toBe(false);
  });
});

describe("context compaction", () => {
  it("compacts a transcript past the threshold before the model call and persists the checkpoint", async () => {
    const stored = longTranscript(6);
    const recorded = recordingHooks();
    const { requests, summaries } = respond([say("All counted.")]);
    const outcome = await executor().run(
      input({
        hooks: recorded.hooks,
        transcript: stored,
        inputs: ["Now report the count."],
      }),
    );
    expect(outcome).toEqual({ kind: "ended", finalText: "All counted." });
    expect(summaries.length).toBeGreaterThan(0);

    // The input is persisted first, then the checkpoint alone, then the answer.
    expect(
      recorded.persistCalls.map((batch) => batch.map((e) => e.role)),
    ).toEqual([["user"], ["compaction"], ["assistant"]]);
    const [entry] = compactions(recorded.entries);
    expect(entry).toBeDefined();
    expect(entry?.tokensBefore).toBeGreaterThan(3000);
    expect(entry?.summary).toContain("Summary");

    // The model saw [summary] + exactly the kept entries, which end with the input.
    const [request] = requests;
    const seen = conversationOf(request as TranscriptContext);
    expect(textOf(seen[0])).toContain("<summary>");
    expect(textOf(seen[0])).toContain(entry?.summary);
    const all = [...stored, ...recorded.entries];
    const view = viewTranscript(all);
    expect(view.compaction).toEqual(entry);
    expect(seen.slice(1)).toEqual(
      repairTranscript(view.messages).slice(0, seen.length - 1),
    );
    expect(textOf(seen.at(-1))).toBe("Now report the count.");
    expect(seen.length).toBeLessThan(stored.length);
    expectValid(seen);

    // The summary call is reported like any model call, with its usage.
    const reported = modelEvents(recorded.events);
    expect(reported.map((event) => event.type)).toEqual([
      ...summaries.flatMap(() => ["model.started", "model.finished"]),
      "model.started",
      "model.finished",
    ]);
    const summaryFinished = reported[1];
    expect(summaryFinished).toMatchObject({
      type: "model.finished",
      model: "faux/faux-1",
      stopReason: "stop",
    });
    expect(
      summaryFinished?.type === "model.finished" && summaryFinished.text,
    ).toMatch(/^Context compaction \(about \d+ tokens\): Summary 1/);
    expect(
      summaryFinished?.type === "model.finished" &&
        summaryFinished.usage.inputTokens,
    ).toBeGreaterThan(0);
  });

  it("leaves a transcript under the threshold alone", async () => {
    const recorded = recordingHooks();
    const { summaries } = respond([say("Done.")]);
    await executor().run(
      input({
        hooks: recorded.hooks,
        transcript: longTranscript(2),
        inputs: ["Report."],
      }),
    );
    expect(summaries).toHaveLength(0);
    expect(compactions(recorded.entries)).toHaveLength(0);
  });

  it("resumes from the checkpoint in a fresh executor without duplicating or losing tool calls", async () => {
    const first = recordingHooks();
    respond([say("Counted.")]);
    await executor().run(
      input({
        hooks: first.hooks,
        transcript: longTranscript(6),
        inputs: ["Report."],
      }),
    );
    const stored = parseTranscript(
      JSON.parse(
        JSON.stringify(
          [...longTranscript(6), ...first.entries].map(serializeEntry),
        ),
      ) as unknown[],
    );
    const entry = compactions(stored).at(-1) as CompactionEntry;

    // A new process: fresh faux provider, registry and executor.
    faux = fauxProvider({ models: FAUX_MODELS });
    registry = new ModelRegistry({ env: {}, extraProviders: [faux.provider] });
    const second = recordingHooks();
    const { requests, summaries } = respond([
      fauxAssistantMessage(
        fauxToolCall("bash", { command: "echo again" }, { id: "again" }),
        {
          stopReason: "toolUse",
        },
      ),
      say("Again done."),
    ]);
    const outcome = await executor().run(
      input({
        hooks: second.hooks,
        transcript: stored,
        inputs: ["Once more."],
      }),
    );
    expect(outcome).toEqual({ kind: "ended", finalText: "Again done." });
    expect(summaries).toHaveLength(0);
    const seen = conversationOf(requests[0] as TranscriptContext);
    expect(textOf(seen[0])).toContain(entry.summary);
    expect(textOf(seen.at(-2))).toBe("Counted.");
    expect(textOf(seen.at(-1))).toBe("Once more.");
    expectValid(seen);
    const after = conversationOf(requests[1] as TranscriptContext);
    expectValid(after);
    expect(toolCallIds(after).filter((id) => id === "again")).toHaveLength(1);
  });

  it("repairs a crash after a checkpoint on the compacted view, once", async () => {
    // Stored: a checkpoint, then a tool call whose result a crash lost.
    const first = recordingHooks();
    respond([
      fauxAssistantMessage(
        [
          fauxToolCall("bash", { command: "sleep 30" }, { id: "lost" }),
          fauxToolCall("bash", { command: "echo kept" }, { id: "kept" }),
        ],
        { stopReason: "toolUse" },
      ),
    ]);
    const crashing = {
      ...first.hooks,
      onEvent: (event: ExecutorEvent) => {
        first.hooks.onEvent(event);
        if (event.type === "tool.finished" && event.toolCallId === "kept")
          throw new Error("worker crashed");
      },
    };
    const crashed = await executor().run(
      input({
        hooks: crashing,
        transcript: longTranscript(6),
        inputs: ["Check twice."],
      }),
    );
    expect(crashed).toMatchObject({ kind: "error", error: "worker crashed" });
    const stored = [...longTranscript(6), ...first.entries];
    expect(stored.at(-3)?.role).toBe("compaction");
    expect(
      resultIds(stored.filter((e): e is PiMessage => !isCompaction(e))),
    ).not.toContain("lost");

    const recovered = recordingHooks();
    const { requests, summaries } = respond([say("Recovered.")]);
    const outcome = await executor().run(
      input({ hooks: recovered.hooks, transcript: stored, inputs: [] }),
    );
    expect(outcome).toEqual({ kind: "ended", finalText: "Recovered." });
    expect(summaries).toHaveLength(0);
    const seen = conversationOf(requests[0] as TranscriptContext);
    expectValid(seen);
    expect(resultIds(seen).slice(-2)).toEqual(["lost", "kept"]);
    expect(textOf(seen.at(-2))).toBe(INTERRUPTED_BY_RESTART);
    // The repair is appended once; reloading builds the same valid view.
    expect(recovered.entries.map((entry) => entry.role)).toEqual([
      "toolResult",
      "assistant",
    ]);
    const reloaded = repairTranscript(
      viewTranscript([...stored, ...recovered.entries]).messages,
    );
    expectValid(reloaded);
    expect(resultIds(reloaded).filter((id) => id === "lost")).toHaveLength(1);
  });

  it("redoes a compaction a crash kept from being persisted", async () => {
    const stored = longTranscript(6);
    const crashedHooks = recordingHooks();
    const failing = {
      ...crashedHooks.hooks,
      onTurnComplete: (entries: TranscriptEntry[]) => {
        if (entries.some(isCompaction)) throw new Error("worker crashed");
        return crashedHooks.hooks.onTurnComplete(entries);
      },
    };
    const first = respond([say("never reached")]);
    const lost = await executor().run(
      input({ hooks: failing, transcript: stored, inputs: ["Report."] }),
    );
    expect(lost).toMatchObject({ kind: "error", error: "worker crashed" });
    expect(first.summaries.length).toBeGreaterThan(0);
    expect(first.requests).toHaveLength(0);
    expect(compactions(crashedHooks.entries)).toHaveLength(0);
    // The summary call's usage was reported before the crash.
    expect(
      crashedHooks.events.filter((event) => event.type === "model.finished"),
    ).toHaveLength(first.summaries.length);

    const retried = recordingHooks();
    const second = respond([say("Reported.")]);
    const outcome = await executor().run(
      input({
        hooks: retried.hooks,
        transcript: [...stored, ...crashedHooks.entries],
        inputs: [],
      }),
    );
    expect(outcome).toEqual({ kind: "ended", finalText: "Reported." });
    expect(second.summaries.length).toBeGreaterThan(0);
    expect(compactions(retried.entries)).toHaveLength(1);
    expect(
      textOf(conversationOf(second.requests[0] as TranscriptContext).at(-1)),
    ).toBe("Report.");
  });

  it("compacts and retries once when the provider reports a context overflow", async () => {
    const overflow = fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: "400 Your input exceeds the context window of this model.",
    });
    const recorded = recordingHooks();
    const { requests, summaries } = respond([overflow, say("Fits now.")]);
    const outcome = await new PiSessionExecutor({
      models: registry,
      compaction: { reserveTokens: 0, keepRecentTokens: 1000 },
      retry: { baseDelayMs: 5 },
    }).run(
      input({
        hooks: recorded.hooks,
        model: "faux/faux-big",
        transcript: longTranscript(6),
        inputs: ["Report."],
        budgets: budgets(1),
      }),
    );
    expect(outcome).toEqual({ kind: "ended", finalText: "Fits now." });
    expect(summaries.length).toBeGreaterThan(0);
    expect(requests).toHaveLength(2);
    expect(
      conversationOf(requests[1] as TranscriptContext).length,
    ).toBeLessThan(conversationOf(requests[0] as TranscriptContext).length);
    expect(compactions(recorded.entries)).toHaveLength(1);
    // The failed attempt is reported, never persisted.
    const finished = recorded.events.filter(
      (event): event is Extract<ExecutorEvent, { type: "model.finished" }> =>
        event.type === "model.finished",
    );
    expect(finished[0]).toMatchObject({
      stopReason: "error",
      errorCode: "context_overflow",
    });
    expect(finished.at(-1)).toMatchObject({ stopReason: "stop" });
    expect(
      recorded.entries.filter(
        (entry) => entry.role === "assistant" && entry.stopReason === "error",
      ),
    ).toHaveLength(0);
  });

  it("fails clearly when the context still overflows after compacting", async () => {
    const overflow = () =>
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage:
          "400 Your input exceeds the context window of this model.",
      });
    const recorded = recordingHooks();
    const { requests, summaries } = respond([overflow(), overflow(), say("x")]);
    const outcome = await new PiSessionExecutor({
      models: registry,
      compaction: { reserveTokens: 0, keepRecentTokens: 1000 },
      retry: { baseDelayMs: 5 },
    }).run(
      input({
        hooks: recorded.hooks,
        model: "faux/faux-big",
        transcript: longTranscript(6),
        inputs: ["Report."],
      }),
    );
    expect(outcome).toMatchObject({ kind: "error", code: "context_overflow" });
    expect(outcome.kind === "error" && outcome.error).toContain(
      "still exceeded the model's context window after it was compacted",
    );
    expect(requests).toHaveLength(2);
    expect(compactions(recorded.entries)).toHaveLength(1);
    expect(summaries.length).toBeGreaterThan(0);
  });

  it("keeps no summary the model did not write and does not retry it in the run", async () => {
    const recorded = recordingHooks();
    const summaries: TranscriptContext[] = [];
    const replies = [
      fauxAssistantMessage(
        fauxToolCall("bash", { command: "echo more" }, { id: "more" }),
        { stopReason: "toolUse" },
      ),
      say("Done without compacting."),
    ];
    // Files were read and changed, so pi would append its file lists to an empty summary.
    const stored = [
      ...longTranscript(6),
      fauxAssistantMessage(
        [
          fauxToolCall("read", { path: "a.txt" }, { id: "r" }),
          fauxToolCall("write", { path: "b.txt", content: "b" }, { id: "w" }),
        ],
        { stopReason: "toolUse" },
      ),
      result("r", "a"),
      result("w", "ok"),
    ];
    faux.setResponses(
      Array.from({ length: 10 }, () => (context: TranscriptContext) => {
        if (!isSummaryRequest(context)) return replies.shift() ?? say("x");
        summaries.push(context);
        return fauxAssistantMessage([], { stopReason: "stop" });
      }),
    );
    const outcome = await executor().run(
      input({ hooks: recorded.hooks, transcript: stored, inputs: ["Go on."] }),
    );
    expect(outcome).toEqual({
      kind: "ended",
      finalText: "Done without compacting.",
    });
    expect(summaries).toHaveLength(1);
    expect(compactions(recorded.entries)).toHaveLength(0);
    expect(
      recorded.events.find((event) => event.type === "model.finished"),
    ).toMatchObject({
      stopReason: "stop",
      text: expect.stringMatching(/: no summary$/),
    });
  });

  it("does not compact with compaction turned off", async () => {
    const recorded = recordingHooks();
    const { summaries } = respond([say("Done.")]);
    await new PiSessionExecutor({
      models: registry,
      compaction: { ...SMALL, enabled: false },
    }).run(
      input({
        hooks: recorded.hooks,
        transcript: longTranscript(6),
        inputs: ["Report."],
      }),
    );
    expect(summaries).toHaveLength(0);
    expect(compactions(recorded.entries)).toHaveLength(0);
  });
});

describe("the scripted model with a small context window", () => {
  it("runs a long session across several compactions and completes", async () => {
    const window = 16_000;
    const scripted = new ModelRegistry({
      env: {},
      extraProviders: [createScriptedProvider({ contextWindow: window })],
    });
    const commands = Array.from(
      { length: 20 },
      (_, i) => `seq ${i * 800 + 1} ${(i + 1) * 800}`,
    );
    const brief = `Tally the numbers into notes-tally.md: ${commands.map((command) => `run \`${command}\``).join(", ")}.`;
    expect(scriptedCommands(brief)).toEqual(commands);
    const recorded = recordingHooks();
    const outcome = await new PiSessionExecutor({ models: scripted }).run(
      input({
        hooks: recorded.hooks,
        model: "scripted/team",
        inputs: [brief],
        budgets: budgets(40),
      }),
    );
    expect(outcome).toMatchObject({ kind: "ended" });
    expect(outcome.kind === "ended" && outcome.finalText).toMatch(
      /^Done: I wrote notes-tally\.md/,
    );
    const entries = compactions(recorded.entries);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    // Every command ran exactly once, and no call was ever refused for size.
    const bash = recorded.events.flatMap((event) =>
      event.type === "tool.started" && event.tool === "bash"
        ? [event.summary]
        : [],
    );
    expect(bash).toEqual([...commands, "ls -la"]);
    expect(
      recorded.events.filter(
        (event) =>
          event.type === "model.finished" && event.stopReason === "error",
      ),
    ).toHaveLength(0);
    // Each checkpoint was taken past the threshold (the window less a quarter).
    for (const entry of entries)
      expect(entry.tokensBefore).toBeGreaterThan(window - window / 4);
    // The stored transcript reloads into a valid, compacted context ...
    const view = viewTranscript(recorded.entries);
    expectValid(repairTranscript(view.messages));
    expect(view.messages.length).toBeLessThan(recorded.entries.length / 2);
    // ... that the model resumes from without redoing any of the work.
    const again = recordingHooks();
    const next = await new PiSessionExecutor({ models: scripted }).run(
      input({
        hooks: again.hooks,
        model: "scripted/team",
        transcript: recorded.entries,
        inputs: ["Thanks, that is all."],
      }),
    );
    expect(next).toEqual({
      kind: "ended",
      finalText: "Acknowledged: Thanks, that is all.",
    });
    expect(
      again.events.filter((event) => event.type === "tool.started"),
    ).toEqual([]);
  });

  it("refuses a prompt over its context window like a provider", async () => {
    const scripted = new ModelRegistry({
      env: {},
      extraProviders: [createScriptedProvider({ contextWindow: 500 })],
    });
    const outcome = await new PiSessionExecutor({
      models: scripted,
      compaction: { enabled: false },
    }).run(
      input({
        hooks: recordingHooks().hooks,
        model: "scripted/team",
        inputs: ["x".repeat(4000)],
      }),
    );
    expect(outcome).toMatchObject({ kind: "error", code: "context_overflow" });
  });
});
