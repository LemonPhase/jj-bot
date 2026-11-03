import { z } from "zod";
import { sha256Hex } from "./canonical";
import { idSchema, timestampSchema } from "./common";
import { secretNameSchema } from "./secrets";

/**
 * MCP servers a runtime profile configures (`profile.mcpServers`) and the
 * records around them: the reviewed tool list a server was discovered with
 * (`McpToolSnapshot`) and the discovery that produced it (`McpDiscovery`).
 *
 * A `stdio` server runs in the task's sandbox; an `http` (Streamable HTTP)
 * server is called by the worker, never by the sandbox. The model sees a
 * server's tools as `mcp__<server>__<tool>` (`mcpToolName`), declared only
 * from a reviewed snapshot.
 */

/** Every MCP tool name, and every approval selector of one, starts with this. No built-in tool does. */
export const MCP_TOOL_PREFIX = "mcp__";
/** Most MCP servers one profile configures. */
export const MAX_MCP_SERVERS = 8;
/** Most MCP tools one profile declares to a session, over all its servers. */
export const MAX_MCP_DIRECT_TOOLS = 64;
/** Most tools a snapshot keeps of one server; a server that lists more gets a warning. */
export const MAX_MCP_SNAPSHOT_TOOLS = 200;
/** Longest tool name a provider accepts, and so the longest `mcpToolName`. */
export const MCP_TOOL_NAME_LIMIT = 64;
/** Longest MCP server name. */
export const MCP_SERVER_NAME_LIMIT = 24;
/** Longest tool description a snapshot keeps. */
export const MCP_TOOL_DESCRIPTION_LIMIT = 2_000;
/** Largest input schema a snapshot keeps, in bytes of its JSON. */
export const MCP_SCHEMA_BYTES_LIMIT = 16_384;
/** Deepest input schema a snapshot keeps. */
export const MCP_SCHEMA_DEPTH_LIMIT = 12;

export const MCP_TRANSPORTS = ["stdio", "http"] as const;
export const mcpTransportSchema = z.enum(MCP_TRANSPORTS);

/**
 * Lowercase letters and digits with single underscores between them,
 * starting with a letter: never `__` and never a trailing `_`, so
 * `mcp__<server>__<tool>` names its server unambiguously.
 */
export const MCP_SERVER_NAME_PATTERN = /^[a-z](?:_?[a-z0-9])*$/;

export const mcpServerNameSchema = z
  .string()
  .max(
    MCP_SERVER_NAME_LIMIT,
    `Use at most ${MCP_SERVER_NAME_LIMIT} characters.`,
  )
  .regex(
    MCP_SERVER_NAME_PATTERN,
    "Use lowercase letters and digits, starting with a letter, with single underscores between them (never two in a row, nor one at the end).",
  );

/** `direct`: declared to sessions as a tool. `hidden`: not declared. */
export const mcpExposureSchema = z.enum(["direct", "hidden"]);

const noControl = /^[^\u0000-\u001f\u007f]*$/;
const noControlMessage = "Use one line without control characters.";
const noNul = (value: string) => !value.includes("\u0000");
const noNulMessage = { message: "NUL characters are not allowed." };

const maxEntries =
  (limit: number) =>
  (record: Record<string, unknown>): boolean =>
    Object.keys(record).length <= limit;
const maxEntriesMessage = (limit: number) => ({
  message: `Use at most ${limit} entries.`,
});

/** An environment variable a stdio server gets: the names sandbox secrets may take. */
const envNameSchema = secretNameSchema;

/** HTTP headers the transport sets itself, which a server's configuration may not. */
const RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
]);

export const mcpHeaderNameSchema = z
  .string()
  .regex(
    /^[A-Za-z0-9-]{1,64}$/,
    "Use a header name of letters, digits and hyphens, at most 64 characters.",
  )
  .refine((name) => !RESERVED_HEADERS.has(name.toLowerCase()), {
    message: "The transport sets this header itself.",
  });

const headerValueSchema = z
  .string()
  .max(4096)
  .regex(noControl, noControlMessage);

/** Workspace-relative: no leading `/`, no `.` or `..` segment. */
const workspaceRelativeSchema = z
  .string()
  .min(1)
  .max(256)
  .refine(noNul, noNulMessage)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      path.split("/").every((segment) => segment !== ".."),
    { message: "Use a path relative to the workspace, without `..`." },
  );

const mcpServerCommon = {
  name: mcpServerNameSchema,
  /** Written by the user; the only text of a server's that enters a system prompt. */
  description: z.string().trim().max(300).default(""),
  enabled: z.boolean().default(true),
  /** The default for the server's tools; `toolExposure` overrides it per tool. */
  exposure: mcpExposureSchema.default("direct"),
  /** Keys: tool names as the server gives them. */
  toolExposure: z
    .record(z.string().min(1).max(128), mcpExposureSchema)
    .refine(
      maxEntries(MAX_MCP_SNAPSHOT_TOOLS),
      maxEntriesMessage(MAX_MCP_SNAPSHOT_TOOLS),
    )
    .default({}),
  /** Bounds each call; progress from the server renews it, and the run's deadline caps it. */
  timeoutSec: z.number().int().min(1).max(600).default(60),
  /** The reviewed tool list. Null: never discovered, or not for this configuration; no tools are declared. */
  snapshotId: idSchema.nullable().default(null),
};

/**
 * A server the task's sandbox runs as one long-lived process, speaking
 * newline-delimited JSON-RPC on stdin and stdout.
 */
export const mcpStdioServerSchema = z
  .object({
    ...mcpServerCommon,
    transport: z.literal("stdio"),
    /**
     * Ask before calls the server does not mark read-only. Off by default for
     * a stdio server. Annotations come from the server, so this guides a
     * cooperative model; approval rules remain the boundary.
     */
    askUnlessReadOnly: z.boolean().default(false),
    /** One executable, not a shell string. */
    command: z.string().min(1).max(256).refine(noNul, noNulMessage),
    args: z
      .array(z.string().max(1024).refine(noNul, noNulMessage))
      .max(64)
      .default([]),
    /** Workspace-relative; the workspace root when omitted. */
    cwd: workspaceRelativeSchema.optional(),
    /** Non-secret variables. */
    env: z
      .record(envNameSchema, z.string().max(4096).refine(noNul, noNulMessage))
      .refine(maxEntries(64), maxEntriesMessage(64))
      .default({}),
    /**
     * `VAR: secretName`: the variable is set from a sandbox secret the same
     * profile grants (`profile.secrets`), expanded inside the sandbox, so the
     * value never travels in argv, events or logs.
     */
    secretEnv: z
      .record(envNameSchema, secretNameSchema)
      .refine(maxEntries(64), maxEntriesMessage(64))
      .default({}),
    /** How long the process may take to answer `initialize`. */
    startupTimeoutSec: z.number().int().min(1).max(300).default(60),
  })
  .superRefine((server, context) => {
    for (const name of Object.keys(server.secretEnv))
      if (Object.hasOwn(server.env, name))
        context.addIssue({
          code: "custom",
          path: ["secretEnv", name],
          message: `${name} is also set in env; a variable comes from one place only.`,
        });
  });

const parseUrl = (value: string): URL | undefined => {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
};

/** An https URL without credentials in it; credentials go in `secretHeaders`. */
const mcpUrlSchema = z
  .string()
  .trim()
  .max(2048)
  .refine(
    (value) => {
      const url = /^https:\/\//i.test(value) ? parseUrl(value) : undefined;
      return url?.protocol === "https:" && url.hostname !== "";
    },
    { message: "Use an https:// URL." },
  )
  .refine(
    (value) => {
      const url = parseUrl(value);
      return !url || (url.username === "" && url.password === "");
    },
    {
      message:
        "Put credentials in a secret header, not in the URL: a URL is stored and shown in the clear.",
    },
  );

/**
 * A remote server over Streamable HTTP (legacy SSE is refused). The worker
 * calls it; the sandbox never reaches it, and its secrets never enter one.
 */
export const mcpHttpServerSchema = z
  .object({
    ...mcpServerCommon,
    transport: z.literal("http"),
    /**
     * Ask before calls the server does not mark read-only. On by default for
     * a remote server. Annotations come from the server, so this guides a
     * cooperative model; approval rules remain the boundary.
     */
    askUnlessReadOnly: z.boolean().default(true),
    url: mcpUrlSchema,
    /** Non-secret headers. */
    headers: z
      .record(mcpHeaderNameSchema, headerValueSchema)
      .refine(maxEntries(32), maxEntriesMessage(32))
      .default({}),
    /**
     * `Header: { secret, prefix }`: the header is `prefix` followed by the
     * stored secret's value (`prefix: "Bearer "`). Sent by the worker only;
     * the secret is never granted to a sandbox.
     */
    secretHeaders: z
      .record(
        mcpHeaderNameSchema,
        z.object({
          secret: secretNameSchema,
          prefix: z
            .string()
            .max(32)
            .regex(noControl, noControlMessage)
            .default(""),
        }),
      )
      .refine(maxEntries(32), maxEntriesMessage(32))
      .default({}),
  })
  .superRefine((server, context) => {
    const seen = new Set<string>();
    for (const [field, names] of [
      ["headers", Object.keys(server.headers)],
      ["secretHeaders", Object.keys(server.secretHeaders)],
    ] as const)
      for (const name of names) {
        const key = name.toLowerCase();
        if (seen.has(key))
          context.addIssue({
            code: "custom",
            path: [field, name],
            message: `${name} is set more than once; header names ignore case.`,
          });
        seen.add(key);
      }
  });

export const mcpServerSchema = z.discriminatedUnion("transport", [
  mcpStdioServerSchema,
  mcpHttpServerSchema,
]);

/** A profile's servers: at most MAX_MCP_SERVERS, with unique names. */
export const mcpServersSchema = z
  .array(mcpServerSchema)
  .max(MAX_MCP_SERVERS, `Use at most ${MAX_MCP_SERVERS} MCP servers.`)
  .superRefine((servers, context) => {
    const seen = new Set<string>();
    servers.forEach((server, index) => {
      if (seen.has(server.name))
        context.addIssue({
          code: "custom",
          path: [index, "name"],
          message: `Another MCP server is already named ${server.name}.`,
        });
      seen.add(server.name);
    });
  });

/** A `secretEnv` entry whose secret its profile does not grant. */
export interface UngrantedMcpSecret {
  /** Index of the server in `mcpServers`. */
  index: number;
  server: string;
  variable: string;
  secret: string;
}

/**
 * Every `secretEnv` entry of the servers whose secret is not among the
 * profile's `secrets` grants: a stdio server can only use what the sandbox
 * it runs in was granted. Pure, so commands, the server and the profile
 * editor check alike.
 */
export function ungrantedMcpSecrets(
  servers: readonly McpServer[],
  grants: readonly string[],
): UngrantedMcpSecret[] {
  const granted = new Set(grants);
  return servers.flatMap((server, index) =>
    server.transport === "stdio"
      ? Object.entries(server.secretEnv)
          .filter(([, secret]) => !granted.has(secret))
          .map(([variable, secret]) => ({
            index,
            server: server.name,
            variable,
            secret,
          }))
      : [],
  );
}

/** Adds an issue at `mcpServers.<i>.secretEnv.<VAR>` for each ungranted secret. */
export function refineMcpSecretGrants(
  servers: readonly McpServer[],
  grants: readonly string[],
  context: z.RefinementCtx,
): void {
  for (const missing of ungrantedMcpSecrets(servers, grants))
    context.addIssue({
      code: "custom",
      path: ["mcpServers", missing.index, "secretEnv", missing.variable],
      message: `${missing.secret} is not granted by this profile; grant it under secrets first.`,
    });
}

const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

/** A tool as discovered and reviewed: sanitized, and frozen in its snapshot. */
export const mcpToolSchema = z.object({
  /** As the server names it; used in `tools/call`. */
  name: z.string().min(1).max(128),
  /** `mcpToolNames(server, …)`: the name the model calls it by. */
  exposedName: z
    .string()
    .max(MCP_TOOL_NAME_LIMIT)
    .regex(/^mcp__[A-Za-z0-9_]+$/),
  title: z.string().max(200).optional(),
  /** Clipped to MCP_TOOL_DESCRIPTION_LIMIT, with invisible characters written out (`visibleText`). */
  description: z.string().max(MCP_TOOL_DESCRIPTION_LIMIT),
  /**
   * Sanitized: an object schema at the root, an allowlist of keywords (no
   * `pattern`, `format` or remote `$ref`), at most MCP_SCHEMA_BYTES_LIMIT
   * bytes and MCP_SCHEMA_DEPTH_LIMIT deep.
   */
  inputSchema: z.record(z.string(), z.unknown()),
  /** As the server claims them; unverified. */
  annotations: z
    .object({
      readOnlyHint: z.boolean().optional(),
      destructiveHint: z.boolean().optional(),
      idempotentHint: z.boolean().optional(),
      openWorldHint: z.boolean().optional(),
    })
    .optional(),
  /** SHA-256 of the canonical JSON of `{ name, description, inputSchema }`. */
  hash: sha256Schema,
});

/**
 * The reviewed tool list of one server for one configuration. Immutable: a
 * new discovery makes a new snapshot. Saving a profile pins one per server
 * (`snapshotId`), and its `configHash` must match the configuration
 * (MCP_SNAPSHOT_MISMATCH otherwise).
 */
export const mcpToolSnapshotSchema = z.object({
  id: idSchema,
  profileId: idSchema,
  server: mcpServerNameSchema,
  /** SHA-256 of what runs: the configuration the tools were discovered with. */
  configHash: sha256Schema,
  serverInfo: z.object({
    name: z.string().max(200),
    version: z.string().max(100),
    protocolVersion: z.string().max(20),
  }),
  tools: z.array(mcpToolSchema).max(MAX_MCP_SNAPSHOT_TOOLS),
  warnings: z.array(z.string().max(500)).max(50),
  discoveredAt: timestampSchema,
});

export const MCP_DISCOVERY_STATUSES = [
  "queued",
  "running",
  "succeeded",
  "failed",
] as const;
export const mcpDiscoveryStatusSchema = z.enum(MCP_DISCOVERY_STATUSES);

/**
 * One "Test" of a server configuration: the worker starts the server (a
 * stdio one in an ephemeral sandbox), calls only `initialize` and
 * `tools/list`, and stores what it found as a snapshot.
 */
export const mcpDiscoverySchema = z.object({
  id: idSchema,
  profileId: idSchema,
  server: mcpServerNameSchema,
  status: mcpDiscoveryStatusSchema,
  /** Why it failed, redacted. */
  error: z.string().max(2000).nullable(),
  /** The end of the server's stderr when it failed, redacted. */
  stderrTail: z.string().max(2000).nullable(),
  /** Set once it succeeded. */
  snapshot: mcpToolSnapshotSchema.nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  createdAt: timestampSchema,
  finishedAt: timestampSchema.nullable(),
});

/**
 * `POST /api/runtime-profiles/:id/mcp-discoveries` → 202 `{ discovery }`.
 * Takes a draft configuration, saved or not; its `secretEnv` secrets must be
 * granted by the stored profile.
 */
export const startMcpDiscoveryCommandSchema = z.object({
  server: mcpServerSchema,
});

/** `POST /api/runtime-profiles/:id/mcp-discoveries` and `GET /api/mcp-discoveries/:id`. */
export const mcpDiscoveryResultSchema = z.object({
  discovery: mcpDiscoverySchema,
});

/** `GET /api/mcp-snapshots/:id`. */
export const mcpSnapshotResultSchema = z.object({
  snapshot: mcpToolSnapshotSchema,
});

export const MCP_SERVER_STATES = [
  "starting",
  "ready",
  "failed",
  "exited",
] as const;
export const mcpServerStateSchema = z.enum(MCP_SERVER_STATES);

/** `mcp.server` event payload: a server connection of a task changed state. */
export const mcpServerEventSchema = z.object({
  profileId: idSchema,
  server: mcpServerNameSchema,
  state: mcpServerStateSchema,
  durationMs: z.number().int().nonnegative().optional(),
  /** Redacted. */
  error: z.string().max(500).optional(),
  /** Redacted. */
  stderrTail: z.string().max(2000).optional(),
  /**
   * Tools the running server lists differently from the pinned snapshot.
   * Reported, never declared: sessions keep the snapshot's definitions.
   */
  drift: z.array(z.string().max(200)).max(50).optional(),
});

const sanitize = (text: string) => text.replace(/[^A-Za-z0-9_]/g, "_");
const hashSuffix = (server: string, tool: string, attempt: number) =>
  sha256Hex(
    attempt === 0 ? `${server}\0${tool}` : `${server}\0${tool}\0${attempt}`,
  ).slice(0, 8);
const shortened = (name: string, hash: string) =>
  `${name.slice(0, MCP_TOOL_NAME_LIMIT - hash.length - 1)}_${hash}`;

/**
 * `mcp__<server>__<tool>` as pi names MCP tools: every character outside
 * `[A-Za-z0-9_]` becomes `_`, and a name over MCP_TOOL_NAME_LIMIT
 * characters, or one `isTaken` reports, keeps its start and ends in `_` and
 * 8 hex digits of the SHA-256 of `<server>\0<tool>`. Pure and deterministic.
 * Use `mcpToolNames` to name a server's whole tool list.
 */
export function mcpToolName(
  server: string,
  tool: string,
  isTaken: (name: string) => boolean = () => false,
): string {
  const name = sanitize(`${MCP_TOOL_PREFIX}${server}__${tool}`);
  if (name.length <= MCP_TOOL_NAME_LIMIT && !isTaken(name)) return name;
  return shortened(name, hashSuffix(server, tool, 0));
}

/**
 * Names a server's tools, from tool name to exposed name, independently of
 * the order they are listed in: tools are named in tool-name order (UTF-16
 * code units), and every tool whose name sanitizes to one another tool's
 * does too (`a-b` and `a_b`) gets the hash suffix, so neither keeps the
 * plain name. A suffixed name that still meets a name already given is
 * suffixed again with the hash of `<server>\0<tool>\0<n>`, so names are
 * always unique. Names of different servers never meet: a server name
 * contains no `__` and every name keeps `mcp__<server>__` whole.
 */
export function mcpToolNames(
  server: string,
  tools: Iterable<string>,
): Map<string, string> {
  const names = [...new Set(tools)].sort();
  const plainCount = new Map<string, number>();
  for (const tool of names) {
    const plain = sanitize(`${MCP_TOOL_PREFIX}${server}__${tool}`);
    plainCount.set(plain, (plainCount.get(plain) ?? 0) + 1);
  }
  const given = new Set<string>();
  const exposed = new Map<string, string>();
  for (const tool of names) {
    let name = mcpToolName(
      server,
      tool,
      (candidate) =>
        given.has(candidate) || (plainCount.get(candidate) ?? 0) > 1,
    );
    for (let attempt = 1; given.has(name); attempt += 1)
      name = shortened(
        sanitize(`${MCP_TOOL_PREFIX}${server}__${tool}`),
        hashSuffix(server, tool, attempt),
      );
    given.add(name);
    exposed.set(tool, name);
  }
  return exposed;
}

/**
 * The exposed names a new session of a profile would declare, sorted: the
 * tools of each enabled server's pinned snapshot whose exposure (the tool's
 * own in `toolExposure`, else the server's) is `direct`. A server without a
 * snapshot, or whose `snapshotId` names a snapshot of another server or not
 * among `snapshots`, declares none. A profile declares at most
 * MAX_MCP_DIRECT_TOOLS.
 */
export function declaredMcpTools(
  servers: readonly McpServer[],
  snapshots: readonly McpToolSnapshot[],
): string[] {
  return servers
    .flatMap((server) => {
      if (!server.enabled || server.snapshotId === null) return [];
      const snapshot = snapshots.find(
        (candidate) =>
          candidate.id === server.snapshotId &&
          candidate.server === server.name,
      );
      if (!snapshot) return [];
      return snapshot.tools
        .filter(
          (tool) =>
            (Object.hasOwn(server.toolExposure, tool.name)
              ? server.toolExposure[tool.name]
              : server.exposure) === "direct",
        )
        .map((tool) => tool.exposedName);
    })
    .sort();
}

/**
 * An approval rule's `tool` for MCP tools: one exposed name
 * (`mcp__docs__search`) or every tool of one server (`mcp__docs__*`).
 */
export const MCP_TOOL_SELECTOR_PATTERN =
  /^mcp__([a-z](?:_?[a-z0-9])*)__(\*|[A-Za-z0-9_]+)$/;

export const mcpToolSelectorSchema = z
  .templateLiteral([MCP_TOOL_PREFIX, z.string()])
  .refine(
    (selector) => {
      const server = MCP_TOOL_SELECTOR_PATTERN.exec(selector)?.[1];
      return (
        selector.length <= MCP_TOOL_NAME_LIMIT &&
        server !== undefined &&
        server.length <= MCP_SERVER_NAME_LIMIT
      );
    },
    {
      message:
        "Use mcp__<server>__<tool> for one MCP tool, or mcp__<server>__* for every tool of a server.",
    },
  );

/** The server an MCP tool name or selector names, or undefined for any other tool. */
export function mcpServerOf(tool: string): string | undefined {
  return MCP_TOOL_SELECTOR_PATTERN.exec(tool)?.[1];
}

/**
 * True when an approval rule's `tool` covers a call of `tool`: the same
 * name, or `mcp__<server>__*` and a tool of that server.
 */
export function toolSelectorMatches(selector: string, tool: string): boolean {
  if (selector === tool) return true;
  if (!selector.startsWith(MCP_TOOL_PREFIX) || !selector.endsWith("__*"))
    return false;
  // `mcp__<server>__`: a server name has no `__`, so only its tools start so.
  const prefix = selector.slice(0, -1);
  return (
    tool.startsWith(prefix) && /^[A-Za-z0-9_]+$/.test(tool.slice(prefix.length))
  );
}

export type McpTransport = z.infer<typeof mcpTransportSchema>;
export type McpExposure = z.infer<typeof mcpExposureSchema>;
export type McpStdioServer = z.infer<typeof mcpStdioServerSchema>;
export type McpHttpServer = z.infer<typeof mcpHttpServerSchema>;
export type McpServer = z.infer<typeof mcpServerSchema>;
export type McpServerInput = z.input<typeof mcpServerSchema>;
export type McpTool = z.infer<typeof mcpToolSchema>;
export type McpToolSnapshot = z.infer<typeof mcpToolSnapshotSchema>;
export type McpDiscoveryStatus = z.infer<typeof mcpDiscoveryStatusSchema>;
export type McpDiscovery = z.infer<typeof mcpDiscoverySchema>;
export type StartMcpDiscoveryCommand = z.input<
  typeof startMcpDiscoveryCommandSchema
>;
export type McpDiscoveryResult = z.infer<typeof mcpDiscoveryResultSchema>;
export type McpSnapshotResult = z.infer<typeof mcpSnapshotResultSchema>;
export type McpServerState = z.infer<typeof mcpServerStateSchema>;
export type McpServerEvent = z.infer<typeof mcpServerEventSchema>;
export type McpToolSelector = z.infer<typeof mcpToolSelectorSchema>;
