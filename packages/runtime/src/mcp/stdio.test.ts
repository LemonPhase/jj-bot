// MCP over a sandbox process's stdin and stdout, with an in-memory process:
// framing, the message cap, a crash with its redacted stderr tail, a slow
// start, and how the process is stopped.
import { afterEach, describe, expect, it } from "vitest";
import { McpConnection } from "./connector";
import { McpServerError } from "./errors";
import { SandboxStdioTransport } from "./stdio";
import {
  FakeSandboxProcess,
  ScriptedMcpServer,
  type ScriptedServerOptions,
} from "./test-server";

const SECRET = "sk-live-0123456789abcdef";
const redact = (text: string, cut?: { start?: boolean; end?: boolean }) => {
  redactions.push(cut ?? {});
  return text.replaceAll(SECRET, "[redacted]");
};
let redactions: { start?: boolean; end?: boolean }[] = [];
const open: McpConnection[] = [];

afterEach(async () => {
  redactions = [];
  await Promise.all(open.splice(0).map((connection) => connection.close()));
});

function stdio(
  options: ScriptedServerOptions,
  extra: {
    startupTimeoutMs?: number;
    exitOnEndInput?: boolean;
    launch?: (process: FakeSandboxProcess) => Promise<FakeSandboxProcess>;
    maxInFlight?: number;
    writeTimeoutMs?: number;
  } = {},
) {
  const server = new ScriptedMcpServer(options);
  const process = new FakeSandboxProcess(server, {
    exitOnEndInput: extra.exitOnEndInput ?? false,
  });
  const launched: AbortSignal[] = [];
  const transport = new SandboxStdioTransport({
    launch: async (signal) => {
      launched.push(signal);
      return extra.launch ? extra.launch(process) : process;
    },
    closeGraceMs: 20,
    ...(extra.writeTimeoutMs ? { writeTimeoutMs: extra.writeTimeoutMs } : {}),
  });
  const connection = new McpConnection({
    server: "files",
    transport,
    startupTimeoutMs: extra.startupTimeoutMs ?? 2_000,
    redact,
    ...(extra.maxInFlight ? { maxInFlight: extra.maxInFlight } : {}),
  });
  open.push(connection);
  return { connection, server, process, transport, launched };
}

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof McpServerError) return error;
    throw error;
  }
  throw new Error("expected the promise to fail");
};

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

describe("SandboxStdioTransport", () => {
  it("discovers tools and calls one over newline-delimited JSON", async () => {
    const { connection, process } = stdio({
      tools: [{ name: "echo", description: "Echoes." }],
    });
    await connection.start();
    const listed = await connection.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual(["echo"]);
    const result = await connection.callTool(
      "echo",
      { text: "hi" },
      { timeoutMs: 1_000 },
    );
    expect(result.content).toEqual([{ type: "text", text: '{"text":"hi"}' }]);
    // One JSON-RPC message per line on stdin.
    for (const line of process.stdin)
      expect(() => JSON.parse(line)).not.toThrow();
    expect(process.stdin.map((line) => JSON.parse(line).method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
  });

  it("reassembles a message split across chunks, reads several from one, and skips a bad line", async () => {
    const { connection, process, transport } = stdio({
      tools: [{ name: "slow", call: () => new Promise(() => {}) }],
    });
    await connection.start();
    const errors: Error[] = [];
    transport.onError((error) => errors.push(error));
    const pending = connection.callTool("slow", {}, { timeoutMs: 1_000 });
    await tick();
    const id = JSON.parse(process.stdin.at(-1) ?? "{}").id;
    const answer = JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: "split ✓" }] },
    });
    const bytes = Buffer.from(`not json\n${answer}\n`);
    // Cut through the multi-byte check mark, too.
    const cut = bytes.indexOf(Buffer.from("✓")) + 1;
    process.stdout(bytes.subarray(0, 5));
    process.stdout(bytes.subarray(5, cut));
    process.stdout(bytes.subarray(cut));
    expect((await pending).content).toEqual([
      { type: "text", text: "split ✓" },
    ]);
    expect(errors).toHaveLength(1);
    expect(connection.state).toBe("ready");
  });

  it("fails an in-flight call when the server crashes, with the exit code and a redacted stderr tail", async () => {
    const { connection, process } = stdio({
      tools: [{ name: "work", call: () => new Promise(() => {}) }],
    });
    await connection.start();
    const ends: unknown[] = [];
    connection.onClose((end) => ends.push(end));
    const pending = failure(
      connection.callTool("work", {}, { timeoutMs: 5_000 }),
    );
    await tick();
    process.stderr(`panic: could not use token ${SECRET}\n`);
    process.exit(3);
    const error = await pending;
    expect(error.kind).toBe("exited");
    expect(error.interrupted).toBe("unknown");
    expect(error.exitCode).toBe(3);
    expect(error.message).toBe(
      "MCP server files exited with code 3 while the MCP call work ran; whether it took effect is unknown. Its latest stderr:\npanic: could not use token [redacted]",
    );
    expect(error.stderrTail).toBe("panic: could not use token [redacted]");
    expect(
      JSON.stringify({ error, message: error.message, ends }),
    ).not.toContain(SECRET);
    expect(ends).toEqual([
      {
        reason: "exited",
        error: "MCP server files exited with code 3.",
        exitCode: 3,
        stderrTail: "panic: could not use token [redacted]",
      },
    ]);
  });

  it("keeps only the latest 16 KiB of stderr, redacting it as cut at its start", async () => {
    const { connection, process } = stdio({
      tools: [{ name: "work", call: () => new Promise(() => {}) }],
    });
    await connection.start();
    const pending = failure(
      connection.callTool("work", {}, { timeoutMs: 5_000 }),
    );
    await tick();
    for (let index = 0; index < 40; index++)
      process.stderr(
        `${String(index).padStart(4, "0")} ${"e".repeat(1_019)}\n`,
      );
    process.stderr(`last line ${SECRET}`);
    process.exit(1);
    const error = await pending;
    expect(error.stderrTail?.length).toBeLessThanOrEqual(2_000);
    expect(error.stderrTail?.endsWith("last line [redacted]")).toBe(true);
    expect(redactions).toContainEqual({ start: true });
  });

  it("closes the connection and stops the process when a message passes 4 MiB", async () => {
    const { connection, process } = stdio({
      tools: [{ name: "flood", call: () => new Promise(() => {}) }],
    });
    await connection.start();
    const pending = failure(
      connection.callTool("flood", {}, { timeoutMs: 5_000 }),
    );
    await tick();
    // 5 MiB without a newline, in 64 KiB chunks.
    const chunk = Buffer.alloc(64 * 1024, "x");
    for (
      let sent = 0;
      sent < 5 * 1024 * 1024 && !process.killed;
      sent += chunk.length
    )
      process.stdout(chunk);
    const error = await pending;
    expect(error.kind).toBe("closed");
    expect(error.interrupted).toBe("unknown");
    expect(error.message).toBe(
      "The MCP server sent a message over 4194304 bytes; the connection was closed while the MCP call flood ran; whether it took effect is unknown.",
    );
    expect(process.inputEnded).toBe(true);
    expect(process.killed).toBe(true);
    expect(connection.state).toBe("closed");
  });

  it("refuses to send a message over 4 MiB, keeping the connection", async () => {
    const { connection, server } = stdio({ tools: [{ name: "echo" }] });
    await connection.start();
    const error = await failure(
      connection.callTool(
        "echo",
        { blob: "y".repeat(5 * 1024 * 1024) },
        { timeoutMs: 1_000 },
      ),
    );
    expect(error.kind).toBe("refused");
    expect(error.interrupted).toBe("yes");
    expect(server.calls).toEqual([]);
    expect(connection.state).toBe("ready");
  });

  it("stops a server that never answers initialize once the startup timeout passes", async () => {
    const { connection, process } = stdio(
      { tools: [], silentStart: true },
      {
        startupTimeoutMs: 100,
        launch: async (started) => {
          setTimeout(() => started.stderr(`loading with ${SECRET}\n`), 10);
          return started;
        },
      },
    );
    const error = await failure(connection.start());
    expect(error.kind).toBe("startup");
    expect(error.message).toBe(
      "MCP server files did not answer initialize within 0.1 s; it was stopped. Its latest stderr:\nloading with [redacted]",
    );
    expect(process.inputEnded).toBe(true);
    expect(process.killed).toBe(true);
  });

  it("stops a process whose launch outlasted the startup timeout", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { connection, process, launched } = stdio(
      { tools: [] },
      {
        startupTimeoutMs: 50,
        launch: async (started) => {
          await gate;
          return started;
        },
      },
    );
    const error = await failure(connection.start());
    expect(error.kind).toBe("startup");
    expect(launched[0]?.aborted).toBe(true);
    release();
    await tick();
    expect(process.killed).toBe(true);
  });

  it("closes stdin first, killing only a server that does not exit on its own", async () => {
    const polite = stdio({ tools: [] }, { exitOnEndInput: true });
    await polite.connection.start();
    await polite.connection.close();
    expect(polite.process.inputEnded).toBe(true);
    expect(polite.process.killed).toBe(false);

    const stubborn = stdio({ tools: [] });
    await stubborn.connection.start();
    await stubborn.connection.close();
    expect(stubborn.process.inputEnded).toBe(true);
    expect(stubborn.process.killed).toBe(true);
  });

  it("reports a call that waited for a slot as not sent when the server exits first", async () => {
    const { connection, process, server } = stdio(
      { tools: [{ name: "work", call: () => new Promise(() => {}) }] },
      { maxInFlight: 1 },
    );
    await connection.start();
    const first = failure(
      connection.callTool("work", { n: 1 }, { timeoutMs: 5_000 }),
    );
    const second = failure(
      connection.callTool("work", { n: 2 }, { timeoutMs: 5_000 }),
    );
    await tick();
    process.exit(1);
    expect((await first).interrupted).toBe("unknown");
    const queued = await second;
    expect(queued.interrupted).toBe("yes");
    expect(queued.message).toBe(
      "MCP server files exited with code 1 before the MCP call work was sent; it did not run.",
    );
    expect(server.calls).toEqual([{ name: "work", args: { n: 1 } }]);
  });

  it("stops waiting for a write when its request ends", async () => {
    const { connection, process, transport } = stdio({ tools: [] });
    await connection.start();
    process.stuck = true;
    const controller = new AbortController();
    const sending = transport.send(
      { jsonrpc: "2.0", method: "notifications/progress" },
      { signal: controller.signal },
    );
    setTimeout(() => controller.abort(), 20);
    await expect(sending).rejects.toThrow("MCP request aborted");
  });

  it("closes the connection when the server stops taking its input", async () => {
    const { connection, process } = stdio(
      { tools: [{ name: "work" }] },
      { writeTimeoutMs: 50 },
    );
    await connection.start();
    process.stuck = true;
    const started = Date.now();
    const error = await failure(
      connection.callTool("work", {}, { timeoutMs: 4_000 }),
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(error.kind).toBe("closed");
    expect(error.message).toContain(
      "The MCP server stopped reading its input for 0.1 s; the connection was closed",
    );
    expect(process.killed).toBe(true);
  });

  it("holds a long line's bytes, not a buffer per chunk, while it arrives", async () => {
    const { connection, process } = stdio({ tools: [] });
    await connection.start();
    const before = globalThis.process.memoryUsage().heapUsed;
    // Two million one-byte chunks: about 200 MiB of buffer objects if each is kept.
    for (let index = 0; index < 2_000_000; index++)
      process.stdout(Buffer.from("x"));
    const grown = globalThis.process.memoryUsage().heapUsed - before;
    expect(grown).toBeLessThan(80 * 1024 * 1024);
    expect(connection.state).toBe("ready");
  });
});
