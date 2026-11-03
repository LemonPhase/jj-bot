import type { Tool } from "@earendil-works/pi-mcp";
import type {
  McpHttpServer,
  McpServer,
  McpStdioServer,
  McpTool,
} from "@jj/contracts";
import type { Sandbox } from "@jj/sandbox";
import type { CutEdges } from "../tools";
import { McpConnection, type McpServerInfo } from "./connector";
import { McpServerError } from "./errors";
import {
  createRemoteTransport,
  type McpEnv,
  type RemoteGuardOptions,
  remoteMcpEnabled,
} from "./remote";
import { sanitizeTools } from "./sanitize";
import { SandboxStdioTransport } from "./stdio";

/**
 * Discovery: what the engine's `mcp.discover` job runs. It starts one
 * server from a configuration (a stdio one in the sandbox it is given, a
 * remote one through the guard), calls `initialize` and `tools/list` and
 * nothing else (never `tools/call`), and closes the connection whatever
 * happens. What it returns is redacted and sanitized, ready for a snapshot.
 */

/** Time `tools/list` has after `initialize`, in all of its pages. */
export const MCP_DISCOVERY_LIST_MS = 30_000;
/** Most warnings a snapshot keeps (the contract's cap). */
const MAX_WARNINGS = 50;
const WARNING_LIMIT = 500;

export interface McpDiscoverInput {
  /** The configuration to test, parsed with `mcpServerSchema`. */
  server: McpServer;
  /**
   * A stdio server's sandbox (its driver declares `spawn`). Discovery runs
   * in an ephemeral one with no task files, so a missing working directory
   * is made first.
   */
  sandbox?: Sandbox;
  /** A remote server's `secretHeaders` with their stored values, by header name. */
  secretHeaders?: Readonly<Record<string, { prefix: string; value: string }>>;
  /** Replaces the server's secrets: applied to every text returned or thrown. */
  redact: (text: string, cut?: CutEdges) => string;
  /** Aborting stops the discovery, and the server. */
  signal?: AbortSignal;
}

export interface McpDiscoverResult {
  serverInfo: McpServerInfo;
  /** Sanitized (`sanitizeTools`), sorted by name, their text redacted. */
  tools: McpTool[];
  warnings: string[];
}

export interface McpDiscovererOptions {
  /** Read for JJ_MCP_REMOTE and the proxy variables; default `process.env`. */
  env?: McpEnv;
  /** The remote guard's resolver, address check and trust (tests). */
  guard?: Omit<RemoteGuardOptions, "env">;
  /** Default MCP_DISCOVERY_LIST_MS. */
  listTimeoutMs?: number;
  /** A stdio server's grace between its stdin's end and a kill, on close; default the transport's. */
  closeGraceMs?: number;
}

const POSIX_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * How a stdio server is started in its sandbox: argv, its own `env` and
 * `cwd`. Each `secretEnv` variable is set from the sandbox secret it names
 * by a shell inside the sandbox (`export VAR="${SECRET?}"`, then `exec` of
 * the command), so a value never travels in argv, events or logs; a secret
 * the sandbox lacks stops the shell with its name. Without `secretEnv` the
 * command is run as it is.
 */
export function stdioLaunch(server: McpStdioServer): {
  argv: string[];
  env: Record<string, string>;
  cwd?: string;
} {
  const exports = Object.entries(server.secretEnv);
  for (const [variable, secret] of exports)
    if (!POSIX_NAME.test(variable) || !POSIX_NAME.test(secret))
      throw new Error(
        `secretEnv ${JSON.stringify(variable)} needs environment variable names.`,
      );
  const argv =
    exports.length === 0
      ? [server.command, ...server.args]
      : [
          "/bin/sh",
          "-c",
          `${exports.map(([variable, secret]) => `export ${variable}="\${${secret}?}"`).join("; ")}; exec "$@"`,
          "sh",
          server.command,
          ...server.args,
        ];
  return {
    argv,
    env: { ...server.env },
    ...(server.cwd ? { cwd: server.cwd } : {}),
  };
}

/** Every string in `value`, keys included, through `redact`. */
function redactJson(value: unknown, redact: (text: string) => string): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value))
    return value.map((item) => redactJson(item, redact));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value))
      Object.defineProperty(out, redact(key), {
        value: redactJson(item, redact),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    return out;
  }
  return value;
}

/**
 * The listing with every text redacted, before anything is sanitized or
 * hashed. A tool whose name holds a secret is left out: called by its
 * redacted name it would never run.
 */
function redactListing(
  tools: readonly Tool[],
  redact: (text: string) => string,
): { tools: Tool[]; warnings: string[] } {
  const kept: Tool[] = [];
  let hidden = 0;
  for (const tool of tools) {
    if (redact(tool.name) !== tool.name) {
      hidden++;
      continue;
    }
    kept.push({ ...(redactJson(tool, redact) as Tool), name: tool.name });
  }
  return {
    tools: kept,
    warnings:
      hidden > 0
        ? [
            `${hidden} ${hidden === 1 ? "tool was" : "tools were"} left out, since ${hidden === 1 ? "its name holds" : "their names hold"} a secret value.`,
          ]
        : [],
  };
}

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`;

/**
 * Runs discoveries. `remote` says whether remote servers may be called
 * (`JJ_MCP_REMOTE`), read once; an invalid value throws here.
 */
export class McpDiscoverer {
  readonly remote: boolean;
  private readonly options: McpDiscovererOptions;

  constructor(options: McpDiscovererOptions = {}) {
    this.options = options;
    this.remote = remoteMcpEnabled(options.env ?? process.env);
  }

  async discover(input: McpDiscoverInput): Promise<McpDiscoverResult> {
    const { server } = input;
    const startupTimeoutMs =
      (server.transport === "stdio"
        ? server.startupTimeoutSec
        : server.timeoutSec) * 1000;
    const listTimeoutMs = this.options.listTimeoutMs ?? MCP_DISCOVERY_LIST_MS;
    const redact = (text: string) => input.redact(text);
    const connection = new McpConnection({
      server: server.name,
      transport:
        server.transport === "stdio"
          ? await this.stdio(server, input)
          : this.http(server, input),
      startupTimeoutMs,
      redact: input.redact,
    });
    // `initialize` has its own timeout; the listing gets what is left of both.
    const totalMs = startupTimeoutMs + listTimeoutMs;
    const deadlineAt = Date.now() + totalMs;
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), totalMs);
    const signal = input.signal
      ? AbortSignal.any([input.signal, deadline.signal])
      : deadline.signal;
    try {
      const info = await connection.start(signal);
      const listed = await connection.listTools({
        signal,
        timeoutMs: Math.max(1, deadlineAt - Date.now()),
      });
      const visible = redactListing(listed.tools, redact);
      const sanitized = sanitizeTools(server.name, visible.tools);
      const warnings = [
        ...listed.warnings.map(redact),
        ...visible.warnings,
        ...sanitized.warnings,
      ].map((warning) => clip(warning, WARNING_LIMIT));
      return {
        serverInfo: {
          name: clip(redact(info.name), 200),
          version: clip(redact(info.version), 100),
          protocolVersion: clip(redact(info.protocolVersion), 20),
        },
        tools: sanitized.tools,
        warnings:
          warnings.length > MAX_WARNINGS
            ? [
                ...warnings.slice(0, MAX_WARNINGS - 1),
                `${warnings.length - MAX_WARNINGS + 1} more warnings are not shown.`,
              ]
            : warnings,
      };
    } catch (error) {
      // The listing ran out of time, not the caller: say so in discovery's
      // terms (a request's own wording is about a call's unknown effects).
      if (
        connection.serverInfo &&
        !input.signal?.aborted &&
        (deadline.signal.aborted ||
          (error instanceof McpServerError && error.kind === "timeout"))
      )
        throw new McpServerError(
          "timeout",
          `MCP server ${server.name} did not list its tools within ${seconds(totalMs)} of its start; it was stopped.`,
        );
      throw error;
    } finally {
      clearTimeout(timer);
      await connection.close().catch(() => {});
    }
  }

  private async stdio(server: McpStdioServer, input: McpDiscoverInput) {
    const { sandbox } = input;
    if (!sandbox?.spawn)
      throw new McpServerError(
        "startup",
        `MCP server ${server.name} runs in a sandbox, and this one cannot start long-lived processes.`,
      );
    const spawn = sandbox.spawn.bind(sandbox);
    const launch = stdioLaunch(server);
    if (launch.cwd) await sandbox.fs.mkdir(launch.cwd);
    return new SandboxStdioTransport({
      launch: (signal) =>
        spawn(launch.argv, {
          env: launch.env,
          ...(launch.cwd ? { cwd: launch.cwd } : {}),
          signal,
        }),
      ...(this.options.closeGraceMs !== undefined
        ? { closeGraceMs: this.options.closeGraceMs }
        : {}),
    });
  }

  private http(server: McpHttpServer, input: McpDiscoverInput) {
    return createRemoteTransport({
      ...this.options.guard,
      env: this.options.env ?? process.env,
      url: server.url,
      headers: server.headers,
      secretHeaders: input.secretHeaders ?? {},
    });
  }
}
