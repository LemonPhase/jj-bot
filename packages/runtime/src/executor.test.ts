import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type ToolResultMessage,
  Type,
} from "@earendil-works/pi-ai";
import { CODING_TOOLS, TOOL_OUTPUT_PREVIEW_LIMIT } from "@jj/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiSessionExecutor } from "./executor";
import { NOT_STARTED_TEXT } from "./loop";
import { ModelRegistry } from "./models";
import {
  budgets,
  callTool,
  conversation,
  expecting,
  lastMessage,
  localSandbox,
  recordingHooks,
  recordingSandbox,
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
  PiMessage,
  RunInput,
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

const finished = (events: ExecutorEvent[], tool: string) =>
  events.filter(
    (event): event is Extract<ExecutorEvent, { type: "tool.finished" }> =>
      event.type === "tool.finished" && event.tool === tool,
  );

const toolResults = (messages: readonly TranscriptEntry[]) =>
  messages.filter(
    (message): message is ToolResultMessage => message.role === "toolResult",
  );

describe("PiSessionExecutor", () => {
  it("runs a real tool cycle through the sandbox and persists each turn", async () => {
    const { sandbox, calls } = recordingSandbox(workspace.sandbox);
    const recorded = recordingHooks();
    const persistedBeforeCall: number[] = [];
    const before = (
      context: Parameters<Parameters<typeof expecting>[0]>[0],
    ) => {
      persistedBeforeCall.push(recorded.entries.length);
      void context;
    };
    faux.setResponses([
      expecting(
        (context) => {
          before(context);
          expect(textOf(lastMessage(context))).toBe("Do the work.");
        },
        callTool("bash", {
          command: "echo hello > hello.txt && cat hello.txt",
        }),
      ),
      expecting(
        before,
        callTool("write", { path: "notes/a.txt", content: "alpha\n" }),
      ),
      expecting(
        before,
        callTool("edit", {
          path: "notes/a.txt",
          edits: [{ oldText: "alpha", newText: "beta" }],
        }),
      ),
      expecting(before, callTool("read", { path: "notes/a.txt" })),
      expecting((context) => {
        before(context);
        expect(textOf(lastMessage(context))).toContain("beta");
      }, say("All done.")),
    ]);

    const outcome = await new PiSessionExecutor({ models: registry }).run(
      input({ sandbox, hooks: recorded.hooks }),
    );

    expect(outcome).toEqual({ kind: "ended", finalText: "All done." });
    // Every effect went through the Sandbox interface.
    expect(calls).toContain("exec echo hello > hello.txt && cat hello.txt");
    const notes = `${workspace.sandbox.workspaceDir}/notes`;
    expect(calls.filter((call) => call.includes(notes))).toEqual([
      // write
      `write ${notes}/a.txt`,
      // edit
      `stat ${notes}/a.txt`,
      `read ${notes}/a.txt`,
      `write ${notes}/a.txt`,
      // read
      `stat ${notes}/a.txt`,
      `read ${notes}/a.txt`,
    ]);
    expect((await workspace.sandbox.fs.read("hello.txt")).toString()).toBe(
      "hello\n",
    );
    expect((await workspace.sandbox.fs.read("notes/a.txt")).toString()).toBe(
      "beta\n",
    );

    const [bash] = finished(recorded.events, "bash");
    expect(bash).toMatchObject({
      ok: true,
      exitCode: 0,
      interrupted: "no",
      output: "hello",
      truncated: false,
      summary: "echo hello > hello.txt && cat hello.txt",
    });
    expect(finished(recorded.events, "write")[0]).toMatchObject({
      ok: true,
      summary: "notes/a.txt",
    });
    expect(
      recorded.events.filter((event) => event.type === "model.started"),
    ).toHaveLength(5);
    const usage = recorded.events.filter(
      (event) => event.type === "model.finished",
    );
    expect(usage).toHaveLength(5);
    expect(usage[0]).toMatchObject({
      model: "faux/faux-1",
      stopReason: "toolUse",
    });

    // The whole transcript was persisted, and each turn before the next model call.
    expect(recorded.entries.map((entry) => entry.role)).toEqual([
      "user",
      ...["assistant", "toolResult"],
      ...["assistant", "toolResult"],
      ...["assistant", "toolResult"],
      ...["assistant", "toolResult"],
      "assistant",
    ]);
    expect(persistedBeforeCall).toEqual([1, 3, 5, 7, 9]);
    // The assistant's tool call is durable before the tool runs.
    expect(recorded.persistCalls[1]?.map((entry) => entry.role)).toEqual([
      "assistant",
    ]);
  });

  // The local driver isolates only the environment. The docker driver will add
  // tests that model keys, host environment variables and host files are
  // unreachable from inside its sandboxes.
  it("keeps model keys and the host environment out of the local sandbox", async () => {
    process.env.JJ_TEST_HOST_SECRET = "host-secret-value";
    process.env.ANTHROPIC_API_KEY = "sk-ant-host-key";
    try {
      registry = new ModelRegistry({
        env: {
          OPENAI_API_KEY: "sk-openai-registry-key",
          ANTHROPIC_API_KEY: "sk-ant-registry-key",
        },
        extraProviders: [faux.provider],
      });
      const recorded = recordingHooks();
      faux.setResponses([callTool("bash", { command: "env" }), say("checked")]);
      const outcome = await new PiSessionExecutor({ models: registry }).run(
        input({ hooks: recorded.hooks }),
      );
      expect(outcome.kind).toBe("ended");
      const [env] = finished(recorded.events, "bash");
      expect(env?.ok).toBe(true);
      expect(env?.output).toContain("PATH=");
      for (const leaked of [
        "sk-openai-registry-key",
        "sk-ant-registry-key",
        "sk-ant-host-key",
        "host-secret-value",
        "OPENAI_API_KEY",
        "ANTHROPIC_API_KEY",
        "JJ_TEST_HOST_SECRET",
      ])
        expect(env?.output).not.toContain(leaked);
    } finally {
      delete process.env.JJ_TEST_HOST_SECRET;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("aborts mid-command: the run is aborted and the command reports interrupted", async () => {
    const controller = new AbortController();
    const recorded = recordingHooks();
    const hooks = {
      ...recorded.hooks,
      onEvent: (event: ExecutorEvent) => {
        recorded.hooks.onEvent(event);
        if (event.type === "tool.started")
          setTimeout(() => controller.abort(), 200);
      },
    };
    faux.setResponses([
      callTool("bash", { command: "sleep 30" }),
      say("never reached"),
    ]);
    const startedAt = Date.now();
    const outcome = await new PiSessionExecutor({ models: registry }).run(
      input({ hooks, signal: controller.signal }),
    );
    expect(outcome).toEqual({ kind: "aborted" });
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    const [sleep] = finished(recorded.events, "bash");
    expect(sleep?.ok).toBe(false);
    expect(sleep?.interrupted).not.toBe("no");
    expect(sleep?.interrupted).toBeDefined();
    expect(faux.getPendingResponseCount()).toBe(1);
    // The interrupted result is persisted; the aborted turn is not.
    expect(recorded.entries.map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
  });

  it("injects steering at a turn boundary into the next model input", async () => {
    const recorded = recordingHooks([
      [],
      ["Change of plan: write two.txt instead."],
    ]);
    faux.setResponses([
      callTool("bash", { command: "echo one" }),
      expecting(
        (context) => {
          const messages = conversation(context);
          expect(messages.at(-2)?.role).toBe("toolResult");
          expect(textOf(messages.at(-1))).toBe(
            "Change of plan: write two.txt instead.",
          );
        },
        callTool("write", { path: "two.txt", content: "2\n" }),
      ),
      say("Wrote two.txt."),
    ]);
    const outcome = await new PiSessionExecutor({ models: registry }).run(
      input({ hooks: recorded.hooks }),
    );
    expect(outcome).toEqual({ kind: "ended", finalText: "Wrote two.txt." });
    expect((await workspace.sandbox.fs.read("two.txt")).toString()).toBe("2\n");
    expect(recorded.entries.map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
    expect(textOf(recorded.entries[3])).toBe(
      "Change of plan: write two.txt instead.",
    );
  });

  it("resumes from a serialized transcript in a fresh executor", async () => {
    const first = recordingHooks();
    faux.setResponses([
      callTool("bash", { command: "echo first | tee state.txt" }),
      say("First part done."),
    ]);
    expect(
      await new PiSessionExecutor({ models: registry }).run(
        input({ hooks: first.hooks }),
      ),
    ).toEqual({
      kind: "ended",
      finalText: "First part done.",
    });
    const stored = JSON.parse(
      JSON.stringify(first.entries.map(serializeEntry)),
    ) as unknown[];

    // A new process: fresh faux provider, registry and executor.
    const nextFaux = fauxProvider();
    const nextRegistry = new ModelRegistry({
      env: {},
      extraProviders: [nextFaux.provider],
    });
    const second = recordingHooks();
    nextFaux.setResponses([
      expecting(
        (context) => {
          const messages = conversation(context);
          expect(messages).toHaveLength(5);
          expect(textOf(messages[2])).toBe("first");
          expect(textOf(messages[3])).toBe("First part done.");
          expect(textOf(messages[4])).toBe("Now add the second part.");
        },
        callTool("bash", {
          command: "echo second >> state.txt && cat state.txt",
        }),
      ),
      say("Both parts done."),
    ]);
    const outcome = await new PiSessionExecutor({ models: nextRegistry }).run(
      input({
        hooks: second.hooks,
        transcript: parseTranscript(stored),
        inputs: ["Now add the second part."],
      }),
    );
    expect(outcome).toEqual({ kind: "ended", finalText: "Both parts done." });
    expect(finished(second.events, "bash")[0]?.output).toBe("first\nsecond");
    expect(second.entries.map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "assistant",
    ]);
  });

  it("recovers a crash mid-tool without re-running the command", async () => {
    // Persisted before the crash: the brief and a tool call that never got a result.
    faux.setResponses([callTool("bash", { command: "echo ran > marker.txt" })]);
    const crashed = recordingHooks();
    const crashing = {
      ...crashed.hooks,
      onEvent: (event: ExecutorEvent) => {
        if (event.type === "tool.started") throw new Error("worker crashed");
      },
    };
    const lost = await new PiSessionExecutor({ models: registry }).run(
      input({ hooks: crashing }),
    );
    expect(lost).toEqual({
      kind: "error",
      code: "unknown",
      error: "worker crashed",
    });
    expect(crashed.entries.map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(await workspace.sandbox.fs.stat("marker.txt")).toBeUndefined();

    const recovered = recordingHooks();
    faux.setResponses([
      expecting((context) => {
        const result = lastMessage(context);
        expect(result?.role).toBe("toolResult");
        expect(textOf(result)).toBe(INTERRUPTED_BY_RESTART);
      }, say("The command was interrupted; I checked the workspace.")),
    ]);
    const outcome = await new PiSessionExecutor({ models: registry }).run(
      input({
        hooks: recovered.hooks,
        transcript: crashed.entries,
        inputs: [],
      }),
    );
    expect(outcome.kind).toBe("ended");
    expect(await workspace.sandbox.fs.stat("marker.txt")).toBeUndefined();
    expect(finished(recovered.events, "bash")).toHaveLength(0);
    expect(recovered.entries.map((entry) => entry.role)).toEqual([
      "toolResult",
      "assistant",
    ]);
    expect(toolResults(recovered.entries)[0]).toMatchObject({
      isError: true,
      details: { interrupted: "unknown" },
    });
  });

  it("spills output over the cap and shows the model a truncated preview", async () => {
    const recorded = recordingHooks();
    faux.setResponses([
      callTool("bash", { command: "seq 1 20000" }),
      expecting((context) => {
        const preview = textOf(lastMessage(context));
        expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(
          TOOL_OUTPUT_PREVIEW_LIMIT,
        );
        expect(preview.startsWith("1\n2\n3\n")).toBe(true);
        expect(preview).toContain("19999\n20000");
        expect(preview).toContain("artifact-1");
      }, say("Seen.")),
    ]);
    const outcome = await new PiSessionExecutor({ models: registry }).run(
      input({ hooks: recorded.hooks }),
    );
    expect(outcome.kind).toBe("ended");
    expect(recorded.spilled).toHaveLength(1);
    const full = recorded.spilled[0]?.text ?? "";
    expect(full.split("\n").slice(0, 3)).toEqual(["1", "2", "3"]);
    expect(full).toContain("\n10000\n");
    expect(recorded.spilled[0]?.label).toBe("bash: seq 1 20000");
    const [seq] = finished(recorded.events, "bash");
    expect(seq).toMatchObject({
      ok: true,
      truncated: true,
      artifactId: "artifact-1",
    });
    expect(seq?.output?.length).toBeLessThanOrEqual(TOOL_OUTPUT_PREVIEW_LIMIT);
    expect(seq?.output).not.toContain("\n10000\n");
  });

  it("ends the run after a collaboration tool asks to", async () => {
    const recorded = recordingHooks([[], ["late steering"]]);
    const completions: unknown[] = [];
    faux.setResponses([
      callTool("complete_task", { result: "Shipped." }),
      say("never reached"),
    ]);
    const outcome = await new PiSessionExecutor({ models: registry }).run(
      input({
        hooks: recorded.hooks,
        collaborationTools: [
          {
            name: "complete_task",
            description: "Complete the task.",
            parameters: {
              type: "object",
              properties: { result: { type: "string" } },
              required: ["result"],
            } as never,
            summarize: () => "complete_task",
            execute: async (args) => {
              completions.push(args);
              return { text: "Task completed.", endRun: true };
            },
          },
        ],
      }),
    );
    expect(outcome).toEqual({ kind: "ended", finalText: "" });
    expect(completions).toEqual([{ result: "Shipped." }]);
    expect(faux.getPendingResponseCount()).toBe(1);
    // Steering is left in the inbox for the engine once the run ends.
    expect(recorded.drains).toBe(1);
  });

  it("stops at the turn budget", async () => {
    const recorded = recordingHooks();
    faux.setResponses([
      callTool("bash", { command: "echo 1" }),
      callTool("bash", { command: "echo 2" }),
      say("x"),
    ]);
    const outcome = await new PiSessionExecutor({ models: registry }).run(
      input({ hooks: recorded.hooks, budgets: budgets(2) }),
    );
    expect(outcome).toEqual({ kind: "budget", finalText: "" });
    expect(finished(recorded.events, "bash")).toHaveLength(2);
    expect(faux.getPendingResponseCount()).toBe(1);
  });

  it("stops at the deadline, interrupting the running command", async () => {
    const recorded = recordingHooks();
    faux.setResponses([callTool("bash", { command: "sleep 30" }), say("x")]);
    const outcome = await new PiSessionExecutor({ models: registry }).run(
      input({ hooks: recorded.hooks, budgets: budgets(10, 500) }),
    );
    expect(outcome).toEqual({ kind: "budget", finalText: "" });
    expect(finished(recorded.events, "bash")[0]?.interrupted).not.toBe("no");
  });

  it("only offers the coding tools the profile grants", async () => {
    const recorded = recordingHooks();
    faux.setResponses([
      expecting(
        (context) => {
          const system = context.messages[0];
          expect(system?.role).toBe("system");
          const tools =
            system?.role === "system"
              ? (system.toolsAdded ?? []).map((tool) => tool.name)
              : [];
          expect(tools.sort()).toEqual(["ls", "read"]);
        },
        callTool("bash", { command: "echo nope" }),
      ),
      expecting((context) => {
        expect(textOf(lastMessage(context))).toContain("not found");
      }, say("ok")),
    ]);
    const outcome = await new PiSessionExecutor({ models: registry }).run(
      input({ hooks: recorded.hooks, codingTools: ["read", "ls"] }),
    );
    expect(outcome.kind).toBe("ended");
    expect(finished(recorded.events, "bash")[0]?.ok).toBe(false);
  });

  it("refuses paths outside the workspace", async () => {
    const recorded = recordingHooks();
    faux.setResponses([
      callTool("read", { path: "/etc/hostname" }),
      expecting(
        (context) => {
          expect(textOf(lastMessage(context))).toContain(
            "outside the workspace",
          );
        },
        callTool("read", { path: "../../etc/hostname" }),
      ),
      expecting((context) => {
        expect(textOf(lastMessage(context))).toContain("outside the workspace");
      }, say("ok")),
    ]);
    const outcome = await new PiSessionExecutor({ models: registry }).run(
      input({ hooks: recorded.hooks }),
    );
    expect(outcome.kind).toBe("ended");
    expect(finished(recorded.events, "read").every((event) => !event.ok)).toBe(
      true,
    );
  });

  it("searches with grep, find and ls inside the sandbox", async () => {
    await workspace.sandbox.fs.write(
      "src/app.ts",
      "export const answer = 42;\n",
    );
    await workspace.sandbox.fs.write(
      "src/util.ts",
      "export const other = 1;\n",
    );
    const recorded = recordingHooks();
    faux.setResponses([
      callTool("grep", { pattern: "answer" }),
      callTool("find", { pattern: "*.ts" }),
      callTool("ls", { path: "src" }),
      say("found"),
    ]);
    const outcome = await new PiSessionExecutor({ models: registry }).run(
      input({ hooks: recorded.hooks }),
    );
    expect(outcome.kind).toBe("ended");
    expect(finished(recorded.events, "grep")[0]?.output).toBe(
      "src/app.ts:1:export const answer = 42;",
    );
    expect(finished(recorded.events, "find")[0]?.output).toBe(
      "src/app.ts\nsrc/util.ts",
    );
    expect(finished(recorded.events, "ls")[0]?.output).toBe("app.ts\nutil.ts");
  });

  it("reports an unconfigured model as an error outcome", async () => {
    const recorded = recordingHooks();
    const outcome = await new PiSessionExecutor({ models: registry }).run(
      input({ hooks: recorded.hooks, model: "openai/gpt-6-luna" }),
    );
    expect(outcome).toMatchObject({ kind: "error", code: "auth" });
    expect(outcome.kind === "error" && outcome.error).toContain(
      "OPENAI_API_KEY",
    );
    // The delivered input is kept for the next run.
    expect(recorded.entries.map((entry) => textOf(entry))).toEqual([
      "Do the work.",
    ]);
  });

  it("clamps a model-chosen bash timeout to the profile limit itself", async () => {
    // The driver would allow 120 s; only the runtime's clamp gives 0.3 s.
    const { sandbox, execs } = recordingSandbox(workspace.sandbox);
    const recorded = recordingHooks();
    faux.setResponses([
      callTool("bash", { command: "sleep 5", timeout: 600 }),
      say("ok"),
    ]);
    const startedAt = Date.now();
    const outcome = await new PiSessionExecutor({ models: registry }).run(
      input({
        hooks: recorded.hooks,
        sandbox,
        sandboxLimits: { ...workspace.limits, execTimeoutMs: 300 },
      }),
    );
    expect(outcome.kind).toBe("ended");
    expect(execs).toEqual([{ command: "sleep 5", timeoutMs: 300 }]);
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    const [sleep] = finished(recorded.events, "bash");
    expect(sleep?.ok).toBe(false);
    expect(sleep?.interrupted).not.toBe("no");
    expect(sleep?.output).toContain("Command timed out after 0.3 s.");
  });

  it("honours a model-chosen timeout shorter than the profile limit", async () => {
    const { sandbox, execs } = recordingSandbox(workspace.sandbox);
    const recorded = recordingHooks();
    faux.setResponses([
      callTool("bash", { command: "sleep 5", timeout: 0.3 }),
      say("ok"),
    ]);
    const startedAt = Date.now();
    await new PiSessionExecutor({ models: registry }).run(
      input({ hooks: recorded.hooks, sandbox }),
    );
    expect(workspace.limits.execTimeoutMs).toBe(120_000);
    expect(execs).toEqual([{ command: "sleep 5", timeoutMs: 300 }]);
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    expect(finished(recorded.events, "bash")[0]?.output).toContain(
      "Command timed out after 0.3 s.",
    );
  });

  it("ends the run as aborted when the sandbox is released mid-command", async () => {
    const recorded = recordingHooks();
    const hooks = {
      ...recorded.hooks,
      onEvent: (event: ExecutorEvent) => {
        recorded.hooks.onEvent(event);
        if (event.type === "tool.started")
          setTimeout(() => void workspace.sandbox.release(), 200);
      },
    };
    faux.setResponses([
      callTool("bash", { command: "sleep 30" }),
      say("never reached"),
    ]);
    const outcome = await new PiSessionExecutor({ models: registry }).run(
      input({ hooks }),
    );
    expect(outcome).toEqual({ kind: "aborted", reason: "sandbox_released" });
    const [sleep] = finished(recorded.events, "bash");
    expect(sleep?.ok).toBe(false);
    expect(sleep?.interrupted).not.toBe("no");
    expect(faux.getPendingResponseCount()).toBe(1);
  });

  it("ends the run as aborted when a tool meets an already released sandbox", async () => {
    await workspace.sandbox.release();
    const recorded = recordingHooks();
    faux.setResponses([
      callTool("write", { path: "late.txt", content: "x" }),
      say("never reached"),
    ]);
    const outcome = await new PiSessionExecutor({ models: registry }).run(
      input({ hooks: recorded.hooks }),
    );
    expect(outcome).toEqual({ kind: "aborted", reason: "sandbox_released" });
    const [write] = finished(recorded.events, "write");
    expect(write?.ok).toBe(false);
    expect(write?.output).toContain("released");
    expect(faux.getPendingResponseCount()).toBe(1);
  });

  it("keeps at most maxOutputBytes of a command's output", async () => {
    const recorded = recordingHooks();
    faux.setResponses([
      callTool("bash", { command: "head -c 10000000 /dev/zero | tr '\\0' a" }),
      say("ok"),
    ]);
    const limit = workspace.limits.maxOutputBytes;
    await new PiSessionExecutor({ models: registry }).run(
      input({ hooks: recorded.hooks }),
    );
    const [big] = finished(recorded.events, "bash");
    expect(big).toMatchObject({
      ok: true,
      truncated: true,
      artifactId: "artifact-1",
    });
    const spilled = recorded.spilled[0]?.text ?? "";
    // The 10 MB never reached memory: only the sandbox's limit plus a note.
    expect(Buffer.byteLength(spilled)).toBeLessThanOrEqual(limit + 512);
    expect(spilled.startsWith("a".repeat(1000))).toBe(true);
    expect(spilled).toContain(
      "[Output was cut at 256 KiB, the sandbox's output limit; the rest was not kept.]",
    );
  });

  it("retries a transient provider failure", async () => {
    const recorded = recordingHooks();
    faux.setResponses([
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "429 Too Many Requests: rate limit reached",
      }),
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: "503 Service Unavailable",
      }),
      say("Recovered."),
    ]);
    const outcome = await new PiSessionExecutor({
      models: registry,
      retry: { baseDelayMs: 5 },
    }).run(input({ hooks: recorded.hooks }));
    expect(outcome).toEqual({ kind: "ended", finalText: "Recovered." });
    expect(faux.state.callCount).toBe(3);
    expect(
      recorded.events.filter((event) => event.type === "model.finished"),
    ).toHaveLength(1);
  });

  it("classifies and redacts a provider error without retrying it", async () => {
    const recorded = recordingHooks();
    const leaked = "sk-proj-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789";
    faux.setResponses([
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage: `401 Incorrect API key provided: ${leaked}. Authorization: Bearer ${leaked}`,
      }),
      say("never reached"),
    ]);
    const outcome = await new PiSessionExecutor({
      models: registry,
      retry: { baseDelayMs: 5 },
    }).run(input({ hooks: recorded.hooks }));
    expect(outcome).toMatchObject({ kind: "error", code: "auth" });
    expect(faux.state.callCount).toBe(1);
    const finishedModel = recorded.events.find(
      (event) => event.type === "model.finished",
    );
    for (const text of [
      JSON.stringify(outcome),
      JSON.stringify(finishedModel),
    ]) {
      expect(text).not.toContain(leaked);
      expect(text).not.toContain("AbCdEfGh");
      expect(text).toContain("[redacted]");
    }
    expect(finishedModel).toMatchObject({ errorCode: "auth" });
  });

  it("reports a context overflow", async () => {
    faux.setResponses([
      fauxAssistantMessage([], {
        stopReason: "error",
        errorMessage:
          "400 Your input exceeds the context window of this model.",
      }),
    ]);
    const outcome = await new PiSessionExecutor({
      models: registry,
      retry: { baseDelayMs: 5 },
    }).run(input({ hooks: recordingHooks().hooks }));
    expect(outcome).toMatchObject({ kind: "error", code: "context_overflow" });
  });

  it("persists the inputs when the deadline has already passed", async () => {
    const recorded = recordingHooks([["inbox item"]]);
    const outcome = await new PiSessionExecutor({ models: registry }).run(
      input({
        hooks: recorded.hooks,
        budgets: { maxTurns: 5, deadline: new Date(Date.now() - 1) },
      }),
    );
    expect(outcome).toEqual({ kind: "budget", finalText: "" });
    expect(recorded.entries.map((entry) => textOf(entry))).toEqual([
      "Do the work.",
    ]);
    expect(recorded.drains).toBe(0);
    expect(faux.state.callCount).toBe(0);
  });

  it("persists drained inbox items when an abort lands right after the drain", async () => {
    const controller = new AbortController();
    const recorded = recordingHooks();
    const hooks = {
      ...recorded.hooks,
      drainInbox: async () => {
        controller.abort();
        return ["late result"];
      },
    };
    const outcome = await new PiSessionExecutor({ models: registry }).run(
      input({
        hooks,
        inputs: [],
        transcript: [say("Waiting.")],
        signal: controller.signal,
      }),
    );
    expect(outcome).toEqual({ kind: "aborted" });
    expect(recorded.entries.map((entry) => textOf(entry))).toEqual([
      "late result",
    ]);
    expect(faux.state.callCount).toBe(0);
  });

  it("is idle when woken with no inputs and an empty inbox", async () => {
    for (const transcript of [[], [say("All done earlier.")]]) {
      const recorded = recordingHooks();
      const outcome = await new PiSessionExecutor({ models: registry }).run(
        input({ hooks: recorded.hooks, inputs: [], transcript }),
      );
      expect(outcome).toEqual({ kind: "idle" });
      expect(recorded.entries).toEqual([]);
    }
    expect(faux.state.callCount).toBe(0);
  });

  it("refuses an invalid turn budget, keeping the inputs", async () => {
    for (const maxTurns of [Number.NaN, 0, Number.POSITIVE_INFINITY]) {
      const recorded = recordingHooks();
      const outcome = await new PiSessionExecutor({ models: registry }).run(
        input({
          hooks: recorded.hooks,
          budgets: { maxTurns, deadline: new Date(Date.now() + 5000) },
        }),
      );
      expect(outcome).toMatchObject({ kind: "error", code: "invalid_request" });
      expect(recorded.entries.map((entry) => textOf(entry))).toEqual([
        "Do the work.",
      ]);
    }
  });

  it("persists each finished command at once, so a crash mid-batch loses none", async () => {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("bash", { command: "sleep 30" }, { id: "slow" }),
          fauxToolCall("bash", { command: "echo fast" }, { id: "fast" }),
        ],
        { stopReason: "toolUse" },
      ),
    ]);
    const crashed = recordingHooks();
    const crashing = {
      ...crashed.hooks,
      onEvent: (event: ExecutorEvent) => {
        crashed.hooks.onEvent(event);
        if (event.type === "tool.finished" && event.toolCallId === "fast")
          throw new Error("worker crashed");
      },
    };
    const lost = await new PiSessionExecutor({ models: registry }).run(
      input({ hooks: crashing }),
    );
    expect(lost).toMatchObject({ kind: "error" });
    expect(crashed.entries.map((entry) => entry.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
    expect(toolResults(crashed.entries)[0]).toMatchObject({
      toolCallId: "fast",
      isError: false,
    });

    faux.setResponses([
      expecting((context) => {
        const messages = conversation(context);
        // Back in call order: the lost command is interrupted, the finished one keeps its output.
        expect(
          messages
            .slice(-2)
            .map((message) =>
              message.role === "toolResult" ? message.toolCallId : "",
            ),
        ).toEqual(["slow", "fast"]);
        expect(textOf(messages.at(-2))).toBe(INTERRUPTED_BY_RESTART);
        expect(textOf(messages.at(-1))).toBe("fast");
      }, say("Resumed.")),
    ]);
    const recovered = recordingHooks();
    const outcome = await new PiSessionExecutor({ models: registry }).run(
      input({
        hooks: recovered.hooks,
        transcript: crashed.entries,
        inputs: [],
      }),
    );
    expect(outcome).toEqual({ kind: "ended", finalText: "Resumed." });
    expect(
      toolResults(recovered.entries).map((entry) => entry.toolCallId),
    ).toEqual(["slow"]);
  });

  it("answers calls an abort kept from starting with 'Not started'", async () => {
    const controller = new AbortController();
    const noted: unknown[] = [];
    const recorded = recordingHooks();
    const hooks = {
      ...recorded.hooks,
      onEvent: (event: ExecutorEvent) => {
        recorded.hooks.onEvent(event);
        if (event.type === "tool.started")
          setTimeout(() => controller.abort(), 200);
      },
    };
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxToolCall("bash", { command: "sleep 30" }, { id: "first" }),
          fauxToolCall("note", { text: "after" }, { id: "second" }),
        ],
        { stopReason: "toolUse" },
      ),
    ]);
    const outcome = await new PiSessionExecutor({ models: registry }).run(
      input({
        hooks,
        signal: controller.signal,
        collaborationTools: [
          {
            name: "note",
            description: "Record a note.",
            parameters: Type.Object({ text: Type.String() }),
            execute: async (args) => {
              noted.push(args);
              return { text: "noted" };
            },
          },
        ],
      }),
    );
    expect(outcome).toEqual({ kind: "aborted" });
    expect(noted).toEqual([]);
    const results = toolResults(recorded.entries);
    expect(results.map((result) => result.toolCallId)).toEqual([
      "first",
      "second",
    ]);
    expect(results[0]?.details).toMatchObject({
      interrupted: expect.not.stringMatching(/^no$/),
    });
    expect(textOf(results[1])).toBe(NOT_STARTED_TEXT);
    // Nothing is left for a restart to call "outcome unknown".
    expect(repairTranscript(recorded.entries as PiMessage[])).toEqual(
      recorded.entries,
    );
  });
});
