// The stdio MCP fixture (mcp-server.cjs) as a server configuration. Its
// source travels in `args`, in pieces under the 1024-character cap, and a
// one-line loader joins and runs them, so it needs nothing but Node in the
// sandbox: the host's on `local`, the image's on docker.
import { readFileSync } from "node:fs";
import type { McpStdioServer } from "@jj/contracts";

const SOURCE = readFileSync(
  new URL("./mcp-server.cjs", import.meta.url),
  "utf8",
);
const LOADER = "eval(process.argv.slice(1).join(''))";
const PIECE = 1000;

export type FixtureMode = "crash" | "silent" | "hostile" | `many:${number}`;

/** A stdio server running the fixture; `command` is Node (`process.execPath` by default, for `local`). */
export function mcpFixture(
  options: {
    command?: string;
    mode?: FixtureMode;
  } & Partial<Omit<McpStdioServer, "transport" | "command" | "args">> = {},
) {
  const { command, mode, env, ...rest } = options;
  const pieces: string[] = [];
  for (let at = 0; at < SOURCE.length; at += PIECE)
    pieces.push(SOURCE.slice(at, at + PIECE));
  return {
    name: "docs",
    transport: "stdio" as const,
    command: command ?? process.execPath,
    args: ["-e", LOADER, "--", ...pieces],
    env: { ...env, ...(mode ? { FIXTURE_MODE: mode } : {}) },
    secretEnv: { DOCS_TOKEN: "DOCS_SECRET" },
    startupTimeoutSec: 20,
    ...rest,
  };
}
