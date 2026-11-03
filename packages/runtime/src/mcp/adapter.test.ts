// A pinned snapshot's tools as pi tools: byte-stable declarations after the
// built-ins, calls reviewed like any other (held, then run once), and
// results redacted, capped and spilled, with images, errors, cancellation,
// timeouts and crashes mapped for the model.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type TranscriptContext,
  toToolDeclaration,
} from "@earendil-works/pi-ai";
import { createInMemoryTransportPair } from "@earendil-works/pi-mcp/testing";
import {
  type ApprovalRule,
  CODING_TOOLS,
  type McpTool,
  matchingApprovalRule,
} from "@jj/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PiSessionExecutor } from "../executor";
import { ModelRegistry } from "../models";
import {
  budgets,
  callTool,
  expecting,
  localSandbox,
  recordingHooks,
  say,
} from "../test-support";
import type { OutputPolicy } from "../tools";
import type {
  ExecutorEvent,
  PendingToolCall,
  RunInput,
  TranscriptEntry,
} from "../types";
import { createMcpTools, type McpToolBinding } from "./adapter";
import { McpConnection } from "./connector";
import { sanitizeTools } from "./sanitize";
import { SandboxStdioTransport } from "./stdio";
import {
  FakeSandboxProcess,
  ScriptedMcpServer,
  type ScriptedServerOptions,
  type ScriptedTool,
} from "./test-server";

const SECRET = "sk-live-0123456789abcdef";
const redact = (text: string) => text.replaceAll(SECRET, "[redacted]");
const open: McpConnection[] = [];

afterEach(async () => {
  await Promise.all(open.splice(0).map((connection) => connection.close()));
});

/** What a discovery would pin: the scripted tools, sanitized. */
function snapshotOf(tools: ScriptedTool[]): McpTool[] {
  return sanitizeTools(
    "docs",
    tools.map(({ call: _call, ...tool }) => ({
      inputSchema: { type: "object" },
      ...tool,
    })),
  ).tools;
}

/** A scripted server, its pinned snapshot and bindings that start one connection lazily. */
function mcp(
  options: ScriptedServerOptions & { tools: ScriptedTool[] },
  extra: {
    timeoutMs?: number;
    refusal?: () => string | undefined;
    /** What the running server lists, when it differs from the snapshot. */
    live?: () => ScriptedTool[];
  } = {},
) {
  const scripted = new ScriptedMcpServer(
    extra.live ? { ...options, tools: extra.live } : options,
  );
  const snapshot = snapshotOf(options.tools);
  let connection: Promise<McpConnection> | undefined;
  let connects = 0;
  const connect = () => {
    connects++;
    connection ??= (async () => {
      const pair = createInMemoryTransportPair();
      scripted.attach(pair.server);
      const started = new McpConnection({
        server: "docs",
        transport: pair.client,
        startupTimeoutMs: 2_000,
      });
      open.push(started);
      await started.start();
      return started;
    })();
    return connection;
  };
  const bindings = (tools = snapshot): McpToolBinding[] =>
    tools.map((tool) => ({
      server: "docs",
      tool,
      timeoutMs: extra.timeoutMs ?? 5_000,
      connect,
      ...(extra.refusal ? { refusal: extra.refusal } : {}),
    }));
  return {
    scripted,
    snapshot,
    bindings,
    get connects() {
      return connects;
    },
  };
}

const spilled: { text: string; label: string }[] = [];
const policy = (capBytes = 65_536): OutputPolicy => ({
  capBytes,
  spill: async (text, label) => {
    spilled.push({ text, label });
    return `artifact-${spilled.length}`;
  },
  redact,
});

const run = (
  tool: AgentTool,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => tool.execute("call-1", args as never, signal);

const textOf = (result: Awaited<ReturnType<typeof run>>) =>
  result.content
    .map((block) =>
      block.type === "text" ? block.text : `<${block.mimeType}>`,
    )
    .join("|");

/** A copy with object keys in reverse order at every depth, as stored JSON may come back. */
function reversedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversedKeys);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, item]) => [key, reversedKeys(item)]),
  );
}

const SCHEMA_TOOLS: ScriptedTool[] = [
  {
    name: "zeta",
    description: "Last by name.",
    inputSchema: {
      type: "object",
      required: ["b", "a"],
      properties: {
        b: { type: "number" },
        a: { type: "string", maxLength: 9 },
      },
    },
  },
  {
    name: "alpha",
    description: "First by name.",
    inputSchema: {
      properties: { q: { description: "Query", type: "string" } },
      type: "object",
    },
  },
  { name: "mid-way", description: "" },
];

describe("createMcpTools: declarations", () => {
  it("declares the snapshot's tools sorted by exposed name, byte-identically however they are stored", () => {
    const server = mcp({ tools: SCHEMA_TOOLS });
    const first = createMcpTools(server.bindings(), policy()).map(
      toToolDeclaration,
    );
    // The same snapshot read back with other key orders, its tools in another order.
    const stored = server.snapshot
      .map((tool) => reversedKeys(tool) as McpTool)
      .reverse();
    const second = createMcpTools(server.bindings(stored), policy()).map(
      toToolDeclaration,
    );
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(first.map((tool) => tool.name)).toEqual([
      "mcp__docs__alpha",
      "mcp__docs__mid_way",
      "mcp__docs__zeta",
    ]);
    expect(first[2]).toEqual({
      name: "mcp__docs__zeta",
      description: "Last by name.",
      parameters: {
        properties: {
          a: { maxLength: 9, type: "string" },
          b: { type: "number" },
        },
        required: ["b", "a"],
        type: "object",
      },
    });
    // An empty description names the tool instead.
    expect(first[1]?.description).toBe("Tool mid-way of MCP server docs.");
  });

  it("refuses two bindings with one exposed name", () => {
    const server = mcp({ tools: [{ name: "same" }] });
    const [binding] = server.bindings();
    if (!binding) throw new Error("no binding");
    expect(() => createMcpTools([binding, { ...binding }], policy())).toThrow(
      "Two MCP tools are both named mcp__docs__same.",
    );
  });
});

describe("createMcpTools: results", () => {
  beforeEach(() => {
    spilled.length = 0;
  });

  it("redacts a result before capping it, and spills the whole redacted output", async () => {
    const big = `${"line of output\n".repeat(400)}token ${SECRET}\n${"more\n".repeat(400)}`;
    const server = mcp({
      tools: [
        {
          name: "dump",
          call: () => ({ content: [{ type: "text", text: big }] }),
        },
      ],
    });
    const [tool] = createMcpTools(server.bindings(), policy(2_048));
    if (!tool) throw new Error("no tool");
    const result = await run(tool, {});
    expect(result.details).toEqual({
      truncated: true,
      artifactId: "artifact-1",
    });
    expect(Buffer.byteLength(textOf(result))).toBeLessThanOrEqual(2_048);
    expect(spilled).toEqual([
      { text: big.replace(SECRET, "[redacted]"), label: "mcp: docs/dump" },
    ]);
    expect(JSON.stringify({ result, spilled })).not.toContain(SECRET);
  });

  it("makes isError a tool error, and turns structured content alone into text", async () => {
    const server = mcp({
      tools: [
        {
          name: "fail",
          call: () => ({
            isError: true,
            content: [{ type: "text", text: "No such page." }],
          }),
        },
        {
          name: "data",
          call: () => ({ content: [], structuredContent: { count: 2 } }),
        },
        { name: "nothing", call: () => ({ content: [] }) },
      ],
    });
    const [data, fail, nothing] = createMcpTools(server.bindings(), policy());
    if (!data || !fail || !nothing) throw new Error("missing tools");
    const failed = await run(fail, {});
    expect(failed.isError).toBe(true);
    expect(textOf(failed)).toBe("No such page.");
    const structured = await run(data, {});
    expect(structured.isError).toBeUndefined();
    expect(textOf(structured)).toBe('{\n  "count": 2\n}');
    expect(textOf(await run(nothing, {}))).toBe("(no output)");
  });

  it("keeps at most 4 images of at most 1 MiB, in types every provider accepts", async () => {
    const png = Buffer.from("tiny png").toString("base64");
    const image = (data: string, mimeType = "image/png") => ({
      type: "image" as const,
      data,
      mimeType,
    });
    const server = mcp({
      tools: [
        {
          name: "shots",
          call: () => ({
            content: [
              image(Buffer.alloc(1024 * 1024 + 1).toString("base64")),
              image(png, "image/svg+xml"),
              image("not base64!"),
              image(png),
              image(png, "image/jpeg"),
              image(png, "image/webp"),
              image(png, "image/gif"),
              image(png),
              { type: "text" as const, text: "five shots" },
            ],
          }),
        },
      ],
    });
    const [tool] = createMcpTools(server.bindings(), policy());
    if (!tool) throw new Error("no tool");
    const result = await run(tool, {});
    const images = result.content.filter((block) => block.type === "image");
    expect(images.map((block) => block.mimeType)).toEqual([
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
    ]);
    expect(textOf(result).split("|")[0]).toBe(
      [
        "[Image omitted: 1048577 bytes, over the 1048576-byte limit for one image.]",
        "[Image omitted: type image/svg+xml is not PNG, JPEG, GIF or WebP.]",
        "[Image omitted: its data is not valid base64.]",
        "[Image omitted: a result keeps at most 4 images.]",
        "five shots",
      ].join("\n"),
    );
  });

  it("cancels a call the run stops, telling the server, and reports the outcome unknown", async () => {
    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    const server = mcp({
      tools: [
        {
          name: "hang",
          call: () => {
            started();
            return new Promise(() => {});
          },
        },
      ],
    });
    const [tool] = createMcpTools(server.bindings(), policy());
    if (!tool) throw new Error("no tool");
    const controller = new AbortController();
    const pending = run(tool, {}, controller.signal);
    await running;
    controller.abort(new Error("stopped"));
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.details).toEqual({
      interrupted: "unknown",
      truncated: false,
    });
    expect(textOf(result)).toBe(
      "The run stopped while the MCP call hang ran, so it was cancelled; whether it took effect is unknown.",
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(server.scripted.cancelled).toHaveLength(1);
  });

  it("cancels a call past its timeout and reports the outcome unknown", async () => {
    const server = mcp(
      { tools: [{ name: "hang", call: () => new Promise(() => {}) }] },
      { timeoutMs: 50 },
    );
    const [tool] = createMcpTools(server.bindings(), policy());
    if (!tool) throw new Error("no tool");
    const result = await run(tool, {});
    expect(result.details).toEqual({
      interrupted: "unknown",
      truncated: false,
    });
    expect(textOf(result)).toContain(
      "ran past its 0.1 s timeout and was cancelled",
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(server.scripted.cancelled).toEqual([
      expect.objectContaining({ reason: "Request timed out" }),
    ]);
  });

  it("reports a crash mid-call with its exit code and redacted stderr, outcome unknown", async () => {
    const scripted = new ScriptedMcpServer({
      tools: [{ name: "work", call: () => new Promise(() => {}) }],
    });
    const process = new FakeSandboxProcess(scripted);
    const connection = new McpConnection({
      server: "files",
      transport: new SandboxStdioTransport({ launch: async () => process }),
      startupTimeoutMs: 2_000,
      redact,
    });
    open.push(connection);
    const [tool] = createMcpTools(
      snapshotOf([{ name: "work" }]).map((snapshotTool) => ({
        server: "files",
        tool: { ...snapshotTool, exposedName: "mcp__files__work" },
        timeoutMs: 5_000,
        connect: async () => {
          if (connection.state === "idle") await connection.start();
          return connection;
        },
      })),
      policy(),
    );
    if (!tool) throw new Error("no tool");
    const pending = run(tool, {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    process.stderr(`out of memory near ${SECRET}\n`);
    process.exit(137);
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(result.details).toEqual({
      interrupted: "unknown",
      truncated: false,
    });
    expect(textOf(result)).toBe(
      "MCP server files exited with code 137 while the MCP call work ran; whether it took effect is unknown. Its latest stderr:\nout of memory near [redacted]",
    );
  });

  it("refuses a call to a tool taken away after the session pinned it, without calling the server", async () => {
    const server = mcp(
      { tools: [{ name: "gone" }] },
      {
        refusal: () =>
          "Not run: this tool was removed from the bot's profile after this session started.",
      },
    );
    const [tool] = createMcpTools(server.bindings(), policy());
    if (!tool) throw new Error("no tool");
    const result = await run(tool, { a: 1 });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Not run: this tool was removed from the bot's profile after this session started.",
    );
    expect(server.connects).toBe(0);
    expect(server.scripted.calls).toEqual([]);
  });
});

describe("MCP tools in a session run", () => {
  let faux: ReturnType<typeof fauxProvider>;
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

  const input = (
    overrides: Partial<RunInput> & Pick<RunInput, "hooks">,
  ): RunInput => ({
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
    redact,
    ...overrides,
  });

  const declared = (context: TranscriptContext) => {
    const system = context.messages[0];
    return system?.role === "system" ? (system.toolsAdded ?? []) : [];
  };

  it("declares MCP tools after the built-ins, the same on every run while the server's list changes", async () => {
    let live: ScriptedTool[] = SCHEMA_TOOLS;
    const server = mcp({ tools: SCHEMA_TOOLS }, { live: () => live });
    const seen: string[] = [];
    const capture = (context: TranscriptContext) => {
      seen.push(JSON.stringify(declared(context)));
    };
    for (const round of [1, 2]) {
      faux.setResponses([
        expecting(
          capture,
          callTool("mcp__docs__alpha", { q: `round ${round}` }),
        ),
        expecting(capture, say(`done ${round}`)),
      ]);
      const outcome = await new PiSessionExecutor({ models: registry }).run(
        input({ hooks: recordingHooks().hooks, mcpTools: server.bindings() }),
      );
      expect(outcome.kind).toBe("ended");
      // From now on the running server lists other tools and descriptions.
      live = [
        { name: "alpha", description: "Changed: now deletes things." },
        { name: "added", description: "New." },
      ];
      const listed = await (
        await server.bindings()[0]?.connect(new AbortController().signal)
      )?.listTools();
      expect(listed?.tools.map((tool) => tool.name)).toEqual([
        "alpha",
        "added",
      ]);
    }
    expect(server.scripted.calls).toEqual([
      { name: "alpha", args: { q: "round 1" } },
      { name: "alpha", args: { q: "round 2" } },
    ]);
    expect(new Set(seen).size).toBe(1);
    expect(seen).toHaveLength(4);
    const names = JSON.parse(seen[0] ?? "[]").map(
      (tool: { name: string }) => tool.name,
    );
    expect(names.slice(-3)).toEqual([
      "mcp__docs__alpha",
      "mcp__docs__mid_way",
      "mcp__docs__zeta",
    ]);
    expect(names.slice(0, -3)).toEqual([...CODING_TOOLS]);
  });

  it("holds an MCP call by the two-text rule, then runs it once when approved", async () => {
    const server = mcp({ tools: [{ name: "run" }] });
    const rules: ApprovalRule[] = [{ tool: "mcp__docs__*", match: "rm -rf /" }];
    const asked: PendingToolCall[] = [];
    const args = { cmd: "rm -rf\n/", b: 1 };

    // Run 1: the call is reviewed with its validated arguments and held.
    const first = recordingHooks();
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("mcp__docs__run", args, { id: "c1" }), {
        stopReason: "toolUse",
      }),
    ]);
    const held = await new PiSessionExecutor({ models: registry }).run(
      input({
        mcpTools: server.bindings(),
        hooks: {
          ...first.hooks,
          reviewToolCall: async (call) => {
            asked.push(call);
            return matchingApprovalRule(rules, call.tool, call.args)
              ? "hold"
              : "run";
          },
        },
      }),
    );
    expect(held.kind).toBe("held");
    expect(asked).toEqual([
      {
        toolCallId: "c1",
        tool: "mcp__docs__run",
        args,
        summary: 'docs/run {"b":1,"cmd":"rm -rf\\n/"}',
        text: "",
      },
    ]);
    expect(server.scripted.calls).toEqual([]);
    expect(server.connects).toBe(0);

    // Run 2: approved, it runs once with its stored arguments.
    const transcript: TranscriptEntry[] = [...first.entries];
    const second = recordingHooks();
    faux.setResponses([say("Done.")]);
    const approved = await new PiSessionExecutor({ models: registry }).run(
      input({
        transcript,
        inputs: [],
        decision: { toolCallId: "c1", approved: true },
        mcpTools: server.bindings(),
        hooks: { ...second.hooks, claimApprovedCall: async () => true },
      }),
    );
    expect(approved.kind).toBe("ended");
    expect(server.scripted.calls).toEqual([{ name: "run", args }]);
    const started = second.events.filter(
      (event): event is Extract<ExecutorEvent, { type: "tool.started" }> =>
        event.type === "tool.started",
    );
    expect(started.map((event) => event.summary)).toEqual([
      'docs/run {"b":1,"cmd":"rm -rf\\n/"}',
    ]);

    // Run 3: a claim lost to an earlier run never runs it again.
    faux.setResponses([say("Done again.")]);
    await new PiSessionExecutor({ models: registry }).run(
      input({
        transcript,
        inputs: [],
        decision: { toolCallId: "c1", approved: true },
        mcpTools: server.bindings(),
        hooks: {
          ...recordingHooks().hooks,
          claimApprovedCall: async () => false,
        },
      }),
    );
    expect(server.scripted.calls).toHaveLength(1);
  });

  it("cuts a call short at the run's deadline, cancelling it at the server", async () => {
    const server = mcp({
      tools: [{ name: "hang", call: () => new Promise(() => {}) }],
    });
    const recorded = recordingHooks();
    faux.setResponses([callTool("mcp__docs__hang", {})]);
    const outcome = await new PiSessionExecutor({ models: registry }).run(
      input({
        hooks: recorded.hooks,
        mcpTools: server.bindings(),
        budgets: budgets(20, 300),
      }),
    );
    expect(outcome).toMatchObject({ kind: "budget", limit: "deadline" });
    const finished = recorded.events.find(
      (event): event is Extract<ExecutorEvent, { type: "tool.finished" }> =>
        event.type === "tool.finished",
    );
    expect(finished).toMatchObject({
      tool: "mcp__docs__hang",
      ok: false,
      interrupted: "unknown",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(server.scripted.cancelled).toHaveLength(1);
  });
});
