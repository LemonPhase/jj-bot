import {
  type AssistantMessage,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
  getSystemMessageText,
  type Message,
  type Model,
  normalizeContext,
  type ToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { clampMaxTokensToContext } from "@earendil-works/pi-ai/api/simple-options";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { CODING_TOOLS } from "@jj/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  compactionSettings,
  cutByContext,
  isCompaction,
  MIN_COMPACTION_WINDOW,
  MIN_RESERVE_TOKENS,
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

/**
 * faux-1's 20000-token window compacts past 10000 tokens (the reserve is
 * half the window) and keeps about 5000; faux-big never reaches its
 * threshold in these tests, only a provider's overflow. faux-small's window
 * and faux-unknown's missing one turn compaction off.
 */
const FAUX_MODELS = [
  { id: "faux-1", contextWindow: 20_000 },
  { id: "faux-big", contextWindow: 100_000 },
  { id: "faux-small", contextWindow: 12_000 },
  { id: "faux-unknown", contextWindow: 0 },
];
/** For faux-big: compact on an overflow, keeping about 1000 tokens. */
const ON_OVERFLOW = { keepRecentTokens: 1000 };

beforeEach(async () => {
  faux = fauxProvider({ models: FAUX_MODELS });
  registry = new ModelRegistry({ env: {}, extraProviders: [faux.provider] });
  workspace = await localSandbox();
});

afterEach(async () => {
  await workspace.cleanup();
});

const executor = () => new PiSessionExecutor({ models: registry });

function input(
  overrides: Partial<RunInput> & Pick<RunInput, "hooks">,
): RunInput {
  return {
    // No session id: with one, the faux core caches prompts and counts uncached
    // tokens both as input and as cache writes, doubling the usage it reports.
    sessionId: "",
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

/** A brief and `turns` commands with `chars` / 4 tokens of output each (2000 by default). */
function longTranscript(turns: number, chars = 8000): PiMessage[] {
  const messages: PiMessage[] = [
    user("Count the files, one command at a time."),
  ];
  for (let i = 1; i <= turns; i++)
    messages.push(
      call(`c${i}`, `echo c${i}`),
      result(`c${i}`, `c${i}:${"x".repeat(chars)}`),
    );
  return messages;
}

/** Usage a provider reported for a response. */
const usageOf = (totalTokens: number) => ({
  input: totalTokens,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

const isSummaryRequest = (context: TranscriptContext) => {
  const system = context.messages[0];
  return (
    system?.role === "system" &&
    getSystemMessageText(system).includes("context summarization assistant")
  );
};

/** A reply, or one built from the request it answers. */
type Reply =
  | AssistantMessage
  | ((context: TranscriptContext, model: Model<string>) => AssistantMessage);

/**
 * Faux steps that answer summary requests with numbered summaries and every
 * other request with the next reply, recording each request.
 */
function respond(replies: Reply[]) {
  const requests: TranscriptContext[] = [];
  const summaries: TranscriptContext[] = [];
  const step = (
    context: TranscriptContext,
    _options: unknown,
    _state: unknown,
    model: Model<string>,
  ) => {
    if (isSummaryRequest(context)) {
      summaries.push(context);
      return say(`Summary ${summaries.length}: counted the files so far.`);
    }
    requests.push(context);
    const reply = replies.shift() ?? say("No more replies.");
    return typeof reply === "function" ? reply(context, model) : reply;
  };
  faux.setResponses(Array.from({ length: 30 }, () => step));
  return { requests, summaries };
}

/** The output cap pi-ai's providers set for a request. */
const capOf = (context: TranscriptContext, model: Model<string>) =>
  clampMaxTokensToContext(model, context, model.maxTokens);

/**
 * A reply stopped with stop reason length after `tokens(cap)` output tokens
 * (the faux provider counts four characters a token), with a bash call it
 * never finished unless `call` is false.
 */
const cutReply =
  (tokens: (cap: number) => number, call = true) =>
  (context: TranscriptContext, model: Model<string>) => {
    const calls = call
      ? [fauxToolCall("bash", { command: "echo cut" }, { id: "cut" })]
      : [];
    const callChars = calls
      .map((c) => `\n${c.name}:${JSON.stringify(c.arguments)}`)
      .join("").length;
    const text = "Running the next".padEnd(
      tokens(capOf(context, model)) * 4 - callChars,
      ".",
    );
    return fauxAssistantMessage([fauxText(text), ...calls], {
      stopReason: "length",
    });
  };

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
  it("uses pi's defaults on a large window and fits them to a small one", () => {
    expect(compactionSettings(128_000)).toEqual({
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 20_000,
    });
    expect(compactionSettings(32_768)).toEqual({
      enabled: true,
      reserveTokens: 16_384,
      keepRecentTokens: 8_192,
    });
    expect(compactionSettings(20_000)).toEqual({
      enabled: true,
      reserveTokens: 10_000,
      keepRecentTokens: 5_000,
    });
    // The reserve always leaves pi-ai's 4096-token margin plus room to answer.
    expect(
      compactionSettings(128_000, { reserveTokens: 0 }).reserveTokens,
    ).toBe(MIN_RESERVE_TOKENS);
    expect(compactionSettings(MIN_COMPACTION_WINDOW)).toEqual({
      enabled: true,
      reserveTokens: 8_192,
      keepRecentTokens: 4_096,
    });
    expect(compactionSettings(MIN_COMPACTION_WINDOW - 1).enabled).toBe(false);
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
    expect(entry?.tokensBefore).toBeGreaterThan(10_000);
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
      compaction: ON_OVERFLOW,
      retry: { baseDelayMs: 5 },
    }).run(
      input({
        hooks: recorded.hooks,
        model: "faux/faux-big",
        transcript: longTranscript(6, 2000),
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
      compaction: ON_OVERFLOW,
      retry: { baseDelayMs: 5 },
    }).run(
      input({
        hooks: recorded.hooks,
        model: "faux/faux-big",
        transcript: longTranscript(6, 2000),
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

  it.each([
    [
      "an empty answer",
      fauxAssistantMessage([], { stopReason: "stop" }),
      "the answer was empty",
    ],
    [
      "an answer cut at the output limit",
      fauxAssistantMessage(fauxText("## Goal\nCount the"), {
        stopReason: "length",
      }),
      "the summary was cut at the output limit",
    ],
    [
      "a refused call",
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "401 Incorrect API key provided",
      }),
      "401 Incorrect API key provided",
    ],
  ])(
    "keeps no summary from %s, says so, and does not retry it in the run",
    async (_, answer, reason) => {
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
          return answer;
        }),
      );
      const outcome = await new PiSessionExecutor({
        models: registry,
        retry: { baseDelayMs: 5 },
      }).run(
        input({
          hooks: recorded.hooks,
          transcript: stored,
          inputs: ["Go on."],
        }),
      );
      expect(outcome).toEqual({
        kind: "ended",
        finalText: "Done without compacting.",
      });
      expect(summaries).toHaveLength(1);
      expect(compactions(recorded.entries)).toHaveLength(0);
      const reported = recorded.events.find(
        (event) => event.type === "model.finished",
      );
      expect(reported).toMatchObject({
        stopReason: answer.stopReason,
        warning: `Context compaction failed: ${reason}`,
      });
      expect(reported?.type === "model.finished" && reported.text).toMatch(
        new RegExp(
          `^Context compaction failed \\(about \\d+ tokens\\): ${reason}\\. Nothing was compacted\\.$`,
        ),
      );
    },
  );

  it("does not compact again on resume from usage that predates the checkpoint", async () => {
    // The checkpoint kept c4 to c6 (about 6000 tokens, under the threshold);
    // the last kept call reports usage from before it, far past the threshold.
    const transcript = longTranscript(6);
    const last = transcript.findIndex(
      (message) =>
        message.role === "assistant" && toolCallIds([message])[0] === "c6",
    );
    transcript[last] = {
      ...(transcript[last] as PiMessage),
      usage: usageOf(50_000),
    } as PiMessage;
    const stored: TranscriptEntry[] = [
      ...transcript,
      {
        role: "compaction",
        summary: "Counted c1 to c3.",
        keptEntries: 6,
        tokensBefore: 50_000,
        readFiles: [],
        modifiedFiles: [],
        timestamp: 4,
      },
    ];
    const recorded = recordingHooks();
    const { requests, summaries } = respond([say("Next one.")]);
    const outcome = await executor().run(
      input({ hooks: recorded.hooks, transcript: stored, inputs: ["Go on."] }),
    );
    expect(outcome).toEqual({ kind: "ended", finalText: "Next one." });
    expect(summaries).toHaveLength(0);
    expect(compactions(recorded.entries)).toHaveLength(0);
    const seen = conversationOf(requests[0] as TranscriptContext);
    expect(textOf(seen[0])).toContain("Counted c1 to c3.");
    expect(toolCallIds(seen)).toEqual(["c4", "c5", "c6"]);
    expect(textOf(seen.at(-1))).toBe("Go on.");
  });

  it("scales the kept part when the provider counts more tokens than pi's estimate", async () => {
    // pi's estimate puts the conversation under the kept part, so an unscaled
    // cut would keep everything and summarise nothing; the provider's usage
    // puts it past the threshold.
    const stored = [
      ...longTranscript(3, 4000),
      { ...call("c4", "echo c4"), usage: usageOf(12_000) },
      result("c4", `c4:${"x".repeat(4000)}`),
    ];
    const recorded = recordingHooks();
    const { requests, summaries } = respond([say("Compacted and done.")]);
    const outcome = await executor().run(
      input({ hooks: recorded.hooks, transcript: stored, inputs: ["Go on."] }),
    );
    expect(outcome).toEqual({
      kind: "ended",
      finalText: "Compacted and done.",
    });
    expect(summaries.length).toBeGreaterThan(0);
    const [entry] = compactions(recorded.entries);
    expect(entry?.tokensBefore).toBeGreaterThan(12_000);
    const seen = conversationOf(requests[0] as TranscriptContext);
    expect(textOf(seen[0])).toContain("<summary>");
    expect(seen.length).toBeLessThan(stored.length);
    expectValid(seen);
  });

  it.each([
    ["at the cap", (cap: number) => cap],
    ["1% under the cap, as providers count", (cap: number) => cap * 0.99],
  ])(
    "compacts and retries once when a full context cuts the answer short %s",
    async (_, tokens) => {
      // The provider capped the output for lack of room: stop reason length.
      const recorded = recordingHooks();
      const { requests, summaries } = respond([
        cutReply((cap) => Math.floor(tokens(cap))),
        say("Fits now."),
      ]);
      const outcome = await executor().run(
        input({
          hooks: recorded.hooks,
          transcript: longTranscript(4),
          inputs: ["Report."],
        }),
      );
      expect(outcome).toEqual({ kind: "ended", finalText: "Fits now." });
      expect(summaries.length).toBeGreaterThan(0);
      expect(requests).toHaveLength(2);
      expect(compactions(recorded.entries)).toHaveLength(1);
      // The cut answer is reported as an overflow, never persisted, and its call never ran.
      const finished = recorded.events.filter(
        (event): event is Extract<ExecutorEvent, { type: "model.finished" }> =>
          event.type === "model.finished",
      );
      expect(finished[0]).toMatchObject({
        stopReason: "error",
        errorCode: "context_overflow",
        error: expect.stringContaining("left it no room"),
      });
      expect(
        recorded.events.filter((event) => event.type === "tool.started"),
      ).toEqual([]);
      expect(
        recorded.entries.filter(
          (entry) =>
            entry.role === "assistant" && textOf(entry).includes("Running"),
        ),
      ).toEqual([]);
    },
  );

  it("keeps a length stop short of the output cap an ordinary length stop", async () => {
    // Cut by something else, such as a provider-side limit below the
    // catalog's: it is persisted and pi answers its unfinished call as
    // truncated. One turn, so no later call compacts past the threshold.
    const recorded = recordingHooks();
    const { requests, summaries } = respond([
      cutReply((cap) => Math.floor(cap * 0.98)),
      say("Not asked for."),
    ]);
    const outcome = await executor().run(
      input({
        hooks: recorded.hooks,
        transcript: longTranscript(4),
        inputs: ["Report."],
        budgets: budgets(1),
      }),
    );
    expect(outcome).toMatchObject({
      kind: "budget",
      finalText: expect.stringMatching(/^Running the next\.+$/),
    });
    expect(summaries).toHaveLength(0);
    expect(requests).toHaveLength(1);
    expect(compactions(recorded.entries)).toHaveLength(0);
    const finished = recorded.events.filter(
      (event): event is Extract<ExecutorEvent, { type: "model.finished" }> =>
        event.type === "model.finished",
    );
    expect(finished[0]).toMatchObject({ stopReason: "length" });
    expect(finished[0]).not.toHaveProperty("error");
    expect(finished[0]).not.toHaveProperty("warning");
    expect(
      recorded.events.find((event) => event.type === "tool.finished"),
    ).toMatchObject({
      ok: false,
      output: expect.stringContaining("truncated"),
    });
    expect(
      recorded.entries.filter(
        (entry) =>
          entry.role === "assistant" &&
          entry.stopReason === "length" &&
          textOf(entry).includes("Running"),
      ),
    ).toHaveLength(1);
  });

  it("does not count the overflowed call against the turn budget", async () => {
    const overflow = fauxAssistantMessage([], {
      stopReason: "error",
      errorMessage: "400 Your input exceeds the context window of this model.",
    });
    const recorded = recordingHooks();
    respond([
      fauxAssistantMessage(fauxToolCall("bash", { command: "echo one" }), {
        stopReason: "toolUse",
      }),
      overflow,
      fauxAssistantMessage(fauxToolCall("bash", { command: "echo two" }), {
        stopReason: "toolUse",
      }),
      say("Both done."),
    ]);
    // Three calls are allowed: the overflowed one is replaced by its retry.
    const outcome = await new PiSessionExecutor({
      models: registry,
      compaction: ON_OVERFLOW,
    }).run(
      input({
        hooks: recorded.hooks,
        model: "faux/faux-big",
        transcript: longTranscript(6, 2000),
        inputs: ["Report."],
        budgets: budgets(3),
      }),
    );
    expect(outcome).toEqual({ kind: "ended", finalText: "Both done." });
    expect(compactions(recorded.entries)).toHaveLength(1);
  });

  it("recovers a later overflow again once a response has succeeded", async () => {
    const overflow = () =>
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage:
          "400 Your input exceeds the context window of this model.",
      });
    const recorded = recordingHooks();
    const { summaries } = respond([
      overflow(),
      fauxAssistantMessage(fauxToolCall("bash", { command: "seq 1 1500" }), {
        stopReason: "toolUse",
      }),
      overflow(),
      say("Done after two compactions."),
    ]);
    const outcome = await new PiSessionExecutor({
      models: registry,
      compaction: ON_OVERFLOW,
    }).run(
      input({
        hooks: recorded.hooks,
        model: "faux/faux-big",
        transcript: longTranscript(6, 2000),
        inputs: ["Report."],
      }),
    );
    expect(outcome).toEqual({
      kind: "ended",
      finalText: "Done after two compactions.",
    });
    expect(compactions(recorded.entries)).toHaveLength(2);
    expect(summaries.length).toBeGreaterThanOrEqual(2);
  });

  it("does not compact with compaction turned off", async () => {
    const recorded = recordingHooks();
    const { summaries } = respond([say("Done.")]);
    await new PiSessionExecutor({
      models: registry,
      compaction: { enabled: false },
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

  it.each([
    [
      "faux-small",
      {},
      " Context compaction is off for models with a context window under 16384 tokens.",
    ],
    [
      "faux-unknown",
      {},
      " Context compaction is off for models with no known context window.",
    ],
    ["faux-big", { enabled: false }, ""],
  ])(
    "says when %s's window turned compaction off for an overflow",
    async (model, compaction, note) => {
      const overflow =
        "400 Your input exceeds the context window of this model.";
      const { summaries } = respond([
        fauxAssistantMessage([], {
          stopReason: "error",
          errorMessage: overflow,
        }),
      ]);
      const outcome = await new PiSessionExecutor({
        models: registry,
        compaction,
      }).run(
        input({
          hooks: recordingHooks().hooks,
          model: `faux/${model}`,
          transcript: longTranscript(2),
          inputs: ["Report."],
        }),
      );
      expect(outcome).toEqual({
        kind: "error",
        code: "context_overflow",
        error: `${overflow}${note}`,
      });
      expect(summaries).toHaveLength(0);
    },
  );

  it("warns on an answer cut for lack of room when the window turns compaction off", async () => {
    const run = async (reply: Reply) => {
      const recorded = recordingHooks();
      const { summaries } = respond([reply]);
      const outcome = await executor().run(
        input({
          hooks: recorded.hooks,
          model: "faux/faux-small",
          transcript: longTranscript(1),
          inputs: ["Report."],
        }),
      );
      // An ordinary length stop either way: the run ends with its text.
      expect(outcome).toMatchObject({ kind: "ended" });
      expect(summaries).toHaveLength(0);
      return recorded.events.find((event) => event.type === "model.finished");
    };
    expect(await run(cutReply((cap) => cap, false))).toMatchObject({
      stopReason: "length",
      warning: expect.stringMatching(
        /^The model's output was cut short because the context left it no room \(stop reason length after \d+ output tokens\)\. Context compaction is off for models with a context window under 16384 tokens\.$/,
      ),
    });
    const short = await run(cutReply((cap) => Math.floor(cap / 2), false));
    expect(short).toMatchObject({ stopReason: "length" });
    expect(short).not.toHaveProperty("warning");
  });
});

describe("cutByContext", () => {
  // pi-ai estimates 35000 characters as 10000 tokens, so on faux-1's 20000
  // window its providers cap the output at 20000 - 10000 - 4096 = 5904.
  const context = normalizeContext({
    messages: [user("x".repeat(35_000)) as Message],
  });
  const stopped = (
    output: number,
    stopReason: "length" | "stop" = "length",
  ) => {
    const message = fauxAssistantMessage(fauxText("..."), { stopReason });
    return { ...message, usage: { ...message.usage, output } };
  };
  const model = (id: string) => faux.getModel(id) as Model<string>;

  it("takes a length stop at the context's output cap for a cut", () => {
    expect(capOf(context, model("faux-1"))).toBe(5904);
    expect(cutByContext(stopped(5904), model("faux-1"), context)).toBe(true);
    // Within 1% of the cap (60 tokens), for providers that count differently.
    expect(cutByContext(stopped(5844), model("faux-1"), context)).toBe(true);
  });

  it("leaves a stop short of the cap, or a cap that did not bite, alone", () => {
    expect(cutByContext(stopped(5843), model("faux-1"), context)).toBe(false);
    expect(cutByContext(stopped(3000), model("faux-1"), context)).toBe(false);
    expect(cutByContext(stopped(5904, "stop"), model("faux-1"), context)).toBe(
      false,
    );
    // On faux-big the cap is the model's own 16384-token limit.
    expect(cutByContext(stopped(16_000), model("faux-big"), context)).toBe(
      false,
    );
    expect(cutByContext(stopped(5904), model("faux-unknown"), context)).toBe(
      false,
    );
  });
});

describe("the scripted model with a small context window", () => {
  it("runs a long session across several compactions and completes", async () => {
    const window = 24_000;
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
    // Each checkpoint was taken past the threshold (half this window), and
    // no answer was ever cut short for lack of room.
    for (const entry of entries)
      expect(entry.tokensBefore).toBeGreaterThan(window / 2);
    expect(
      recorded.events.filter(
        (event) =>
          event.type === "model.finished" && event.stopReason === "length",
      ),
    ).toHaveLength(0);
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

  it("caps its answer the way providers do, and a cut answer is an overflow to the runtime", async () => {
    const scripted = new ModelRegistry({
      env: {},
      extraProviders: [createScriptedProvider({ contextWindow: 20_000 })],
    });
    // A 15000-token brief leaves no room for the notes that quote it.
    const brief = `Write notes-big.md: ${"y".repeat(60_000)}`;
    const capped = recordingHooks();
    await new PiSessionExecutor({
      models: scripted,
      compaction: { enabled: false },
    }).run(
      input({
        hooks: capped.hooks,
        model: "scripted/team",
        inputs: [brief],
        budgets: budgets(1),
      }),
    );
    expect(
      capped.events.find((event) => event.type === "model.finished"),
    ).toMatchObject({ stopReason: "length" });
    expect(capped.events.filter((e) => e.type === "tool.started")).toEqual([]);

    const compacting = recordingHooks();
    const outcome = await new PiSessionExecutor({ models: scripted }).run(
      input({
        hooks: compacting.hooks,
        model: "scripted/team",
        inputs: [brief],
      }),
    );
    expect(outcome).toMatchObject({ kind: "error", code: "context_overflow" });
    expect(outcome.kind === "error" && outcome.error).toContain(
      "nothing older to summarise",
    );
  });
});
