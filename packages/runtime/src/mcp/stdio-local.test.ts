// A real stdio MCP server (fixtures/stdio-server.mjs) in the workspace, run
// through the `local` driver's `Sandbox.spawn`: discovery, a call, a crash
// mid-call with its redacted stderr, a slow start, a 5 MiB line, and close.
import { readFile } from "node:fs/promises";
import type { SandboxProcess } from "@jj/sandbox";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localSandbox } from "../test-support";
import { McpConnection } from "./connector";
import { McpServerError } from "./errors";
import { SandboxStdioTransport } from "./stdio";

const SECRET = "sk-fixture-0123456789abcdef";
const redact = (text: string) => text.replaceAll(SECRET, "[redacted]");

let workspace: Awaited<ReturnType<typeof localSandbox>>;
const open: McpConnection[] = [];

beforeEach(async () => {
  workspace = await localSandbox("mcp-fixture");
  await workspace.sandbox.fs.write(
    "mcp/server.mjs",
    await readFile(new URL("./fixtures/stdio-server.mjs", import.meta.url)),
  );
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((connection) => connection.close()));
  await workspace.cleanup();
});

/** A connection to the fixture, and the processes its launches started. */
function fixture(args: string[] = [], startupTimeoutMs = 15_000) {
  const spawned: SandboxProcess[] = [];
  const { sandbox } = workspace;
  const transport = new SandboxStdioTransport({
    launch: async (signal) => {
      if (!sandbox.spawn) throw new Error("the local driver cannot spawn");
      const process = await sandbox.spawn(
        [globalThis.process.execPath, "mcp/server.mjs", ...args],
        { env: { FIXTURE_SECRET: SECRET }, signal },
      );
      spawned.push(process);
      return process;
    },
    closeGraceMs: 2_000,
  });
  const connection = new McpConnection({
    server: "fixture",
    transport,
    startupTimeoutMs,
    redact,
  });
  open.push(connection);
  return { connection, spawned };
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

describe("a stdio MCP server through the local driver's spawn", () => {
  it("discovers its tools and calls one", async () => {
    const { connection } = fixture();
    expect(await connection.start()).toEqual({
      name: "fixture",
      version: "1.0.0",
      protocolVersion: "2025-11-25",
    });
    const listed = await connection.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "echo",
      "crash",
      "flood",
      "leak",
    ]);
    const result = await connection.callTool(
      "echo",
      { text: "hi" },
      { timeoutMs: 10_000 },
    );
    expect(result.content).toEqual([{ type: "text", text: '{"text":"hi"}' }]);
  });

  it("fails a call the server crashes in, with its exit code and redacted stderr, outcome unknown", async () => {
    const { connection } = fixture();
    await connection.start();
    // stderr the server wrote earlier is in the tail too, redacted.
    await connection.callTool("leak", {}, { timeoutMs: 10_000 });
    const error = await failure(
      connection.callTool("crash", {}, { timeoutMs: 10_000 }),
    );
    expect(error.kind).toBe("exited");
    expect(error.interrupted).toBe("unknown");
    expect(error.exitCode).toBe(3);
    expect(error.stderrTail).toBe("using [redacted]\nfatal: lost [redacted]");
    expect(error.message).not.toContain(SECRET);
    expect(connection.state).toBe("closed");
  });

  it("stops a server that does not answer initialize within the startup timeout", async () => {
    const { connection, spawned } = fixture(["--silent"], 1_500);
    const error = await failure(connection.start());
    expect(error.kind).toBe("startup");
    expect(error.message).toBe(
      "MCP server fixture did not answer initialize within 1.5 s; it was stopped.",
    );
    const [process] = spawned;
    expect(process).toBeDefined();
    // Stopped: it exits once stdin closes, or is killed.
    expect((await process?.exited)?.exitCode).not.toBeUndefined();
  });

  it("closes the connection and stops the server when a line passes 4 MiB", async () => {
    const { connection, spawned } = fixture();
    await connection.start();
    const error = await failure(
      connection.callTool("flood", {}, { timeoutMs: 20_000 }),
    );
    expect(error.kind).toBe("closed");
    expect(error.message).toContain(
      "The MCP server sent a message over 4194304 bytes; the connection was closed",
    );
    await spawned[0]?.exited;
    expect(connection.state).toBe("closed");
  });

  it("ends the server's process on close, which exits when its stdin closes", async () => {
    const { connection, spawned } = fixture();
    await connection.start();
    await connection.close();
    const exit = await spawned[0]?.exited;
    expect(exit).toMatchObject({ exitCode: 0, interrupted: "no" });
  });
});
