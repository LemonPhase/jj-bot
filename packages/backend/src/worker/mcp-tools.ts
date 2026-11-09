// A session's MCP tools. At its first run a session pins its toolset: the
// tools its bot's profile declares then (enabled servers this worker can
// run, direct tools of their pinned snapshots), copied whole, so its
// declarations never change. Each run binds every pinned tool to its server:
// a call is checked against the profile as it is then (a tool taken away is
// refused with the reason, never undeclared), and reaches its server through
// the worker's connections with the configuration the profile holds now.
import {
  type McpServer,
  type McpTool,
  mcpServerNameSchema,
  mcpToolSchema,
} from "@jj/contracts";
import {
  mcpToolSnapshots,
  type RuntimeProfileRow,
  sessionToolsets,
} from "@jj/db";
import type { Sandbox } from "@jj/sandbox/contract";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { EngineContext } from "../context";
import { emit } from "../events";
import type { McpConnector, McpToolBinding } from "../ports";
import { profileSettings, toMcpSnapshot } from "../records";
import { mcpConfigHash } from "../services/mcp";
import { profileFor } from "../services/profiles";
import { McpCallNotSent } from "./mcp-connections";
import { attributionOf, type RunContext, writeRun } from "./run-context";
import type { SandboxHold } from "./sandboxes";

/** One server's part of a pinned toolset, as `session_toolsets.mcp` holds it. */
const pinnedServerSchema = z.object({
  server: mcpServerNameSchema,
  profileId: z.string().min(1),
  snapshotId: z.string().min(1),
  tools: z.array(mcpToolSchema),
});
type PinnedServer = z.infer<typeof pinnedServerSchema>;

/** A run's view of its session's MCP tools, for the approval review. */
export interface RunMcp {
  /** Tools that ask before they run: their server asks unless a tool is marked read-only, and this one is not. */
  askFirst: ReadonlySet<string>;
  /** Why a pinned tool may no longer be called, or undefined; undefined too for a tool that is not one. */
  refusal(tool: string): Promise<string | undefined>;
}

const exposureOf = (server: McpServer, tool: Pick<McpTool, "name">) =>
  Object.hasOwn(server.toolExposure, tool.name)
    ? server.toolExposure[tool.name]
    : server.exposure;

/** Why `server` cannot run for a session in this sandbox, or undefined. */
function unrunnable(
  ctx: EngineContext,
  server: McpServer,
  sandbox: Sandbox,
): string | undefined {
  if (!ctx.mcp)
    return `This server has no MCP client, so MCP server ${server.name} cannot be used.`;
  if (server.transport === "stdio" && !sandbox.spawn)
    return `MCP server ${server.name} runs in the task's sandbox, and its ${sandbox.driverId} driver cannot start long-lived processes.`;
  if (server.transport === "http" && !ctx.mcp.remote)
    return `MCP server ${server.name} is a remote server, and remote MCP servers are turned off on this server (JJ_MCP_REMOTE=off).`;
  return undefined;
}

/**
 * What a new session of this profile declares: for each enabled server this
 * worker can run in `sandbox`, the direct tools of the snapshot it pins,
 * as the snapshot holds them, by server name.
 */
async function declaredToolset(
  ctx: EngineContext,
  profile: RuntimeProfileRow,
  sandbox: Sandbox,
): Promise<PinnedServer[]> {
  const servers = profileSettings(profile).mcpServers.filter(
    (server) =>
      server.enabled &&
      server.snapshotId !== null &&
      unrunnable(ctx, server, sandbox) === undefined,
  );
  if (servers.length === 0) return [];
  const rows = await ctx.db
    .select()
    .from(mcpToolSnapshots)
    .where(
      inArray(
        mcpToolSnapshots.id,
        servers.map((server) => server.snapshotId as string),
      ),
    );
  return servers
    .flatMap((server) => {
      const row = rows.find(
        (candidate) =>
          candidate.id === server.snapshotId &&
          candidate.profileId === profile.id &&
          candidate.server === server.name,
      );
      if (!row) return [];
      const tools = toMcpSnapshot(row).tools.filter(
        (tool) => exposureOf(server, tool) === "direct",
      );
      return tools.length > 0
        ? [
            {
              server: server.name,
              profileId: profile.id,
              snapshotId: row.id,
              tools,
            },
          ]
        : [];
    })
    .sort((a, b) => (a.server < b.server ? -1 : a.server > b.server ? 1 : 0));
}

/**
 * The session's toolset: as pinned at its first run, or pinned now from
 * `profile` (the bot's) when this is its first. Written once, through the
 * run's fence; a toolset that no longer parses declares no MCP tool.
 */
async function pinnedToolset(
  rc: RunContext,
  hold: SandboxHold,
  profile: RuntimeProfileRow | undefined,
): Promise<PinnedServer[]> {
  const { ctx } = rc.deps;
  const read = async () => {
    const [row] = await ctx.db
      .select({ mcp: sessionToolsets.mcp })
      .from(sessionToolsets)
      .where(eq(sessionToolsets.sessionId, rc.session.id));
    return row;
  };
  let row = await read();
  if (!row) {
    const pinned = profile
      ? await declaredToolset(ctx, profile, hold.sandbox)
      : [];
    await writeRun(rc, (tx) =>
      tx
        .insert(sessionToolsets)
        .values({
          sessionId: rc.session.id,
          mcp: pinned,
          pinnedAt: ctx.clock(),
        })
        .onConflictDoNothing(),
    );
    row = await read();
  }
  const parsed = pinnedServerSchema.array().safeParse(row?.mcp ?? []);
  if (parsed.success) return parsed.data;
  ctx.logger.warn(
    "A session's pinned MCP toolset does not parse; it declares none",
    {
      sessionId: rc.session.id,
    },
  );
  return [];
}

/** Where a pinned tool's call goes, as the profile is now; or why it may not be made. */
type Resolution =
  | { refusal: string }
  | {
      server: McpServer;
      configHash: string;
      snapshotTools: readonly McpTool[];
    };

/** A pinned tool checked against the bot's profile as it is now. */
async function resolve(
  rc: RunContext,
  hold: SandboxHold,
  pinned: PinnedServer,
  tool: McpTool,
): Promise<Resolution> {
  const { ctx } = rc.deps;
  const name = tool.exposedName;
  const after = "after this session started";
  const profile = await profileFor(ctx.db, rc.bot.runtimeProfileId);
  if (!profile || profile.id !== pinned.profileId)
    return {
      refusal: `${name} can no longer be called: this bot's runtime profile changed ${after}. A new session has its new profile's tools.`,
    };
  const settings = profileSettings(profile);
  const server = settings.mcpServers.find(
    (candidate) => candidate.name === pinned.server,
  );
  if (!server)
    return {
      refusal: `MCP server ${pinned.server} was removed from this bot's profile ${after}, so ${name} can no longer be called.`,
    };
  if (!server.enabled)
    return {
      refusal: `MCP server ${pinned.server} was disabled in this bot's profile ${after}, so ${name} can no longer be called.`,
    };
  if (exposureOf(server, tool) !== "direct")
    return {
      refusal: `${name} was hidden in this bot's profile ${after}, so it can no longer be called.`,
    };
  const [row] = server.snapshotId
    ? await ctx.db
        .select()
        .from(mcpToolSnapshots)
        .where(eq(mcpToolSnapshots.id, server.snapshotId))
    : [];
  const snapshot = row ? toMcpSnapshot(row) : undefined;
  const now = snapshot?.tools.find((candidate) => candidate.name === tool.name);
  if (!now || now.exposedName !== name || now.hash !== tool.hash)
    return {
      refusal: `${name} changed or was removed in the tool list of MCP server ${pinned.server} pinned ${after}, so it can no longer be called; a new session declares the new list.`,
    };
  const reason = unrunnable(ctx, server, hold.sandbox);
  if (reason) return { refusal: `${reason} ${name} cannot be called.` };
  return {
    server,
    configHash: mcpConfigHash(server, settings.sandbox),
    snapshotTools: snapshot?.tools ?? [],
  };
}

/**
 * The session's MCP tools for this run: its pinned toolset (pinned now on
 * its first run) bound to their servers, and what the approval review needs.
 * `profile` is the bot's own, as this run read it.
 */
export async function sessionMcpTools(
  rc: RunContext,
  hold: SandboxHold,
  profile: RuntimeProfileRow | undefined,
): Promise<{ bindings: McpToolBinding[]; mcp: RunMcp }> {
  const { ctx } = rc.deps;
  const toolset = await pinnedToolset(rc, hold, profile);
  const servers = profile ? profileSettings(profile).mcpServers : [];
  const askFirst = new Set<string>();
  const checks = new Map<string, () => Promise<Resolution>>();
  const bindings = toolset.flatMap((pinned) => {
    const now = servers.find((server) => server.name === pinned.server);
    return pinned.tools.map((tool): McpToolBinding => {
      if (now?.askUnlessReadOnly && tool.annotations?.readOnlyHint !== true)
        askFirst.add(tool.exposedName);
      const check = () => resolve(rc, hold, pinned, tool);
      checks.set(tool.exposedName, check);
      // The latest check, made by `refusal` right before each call's
      // `connect`: one read of the profile per call. A parallel call of the
      // same tool may take the other's, made at the same moment.
      let checked: Promise<Resolution> | undefined;
      return {
        server: pinned.server,
        tool,
        timeoutMs: (now?.timeoutSec ?? 60) * 1000,
        refusal: async () => {
          checked = check();
          const resolution = await checked;
          return "refusal" in resolution ? resolution.refusal : undefined;
        },
        connect: async (signal): Promise<McpConnector> => {
          const resolution = await (checked ?? check());
          if ("refusal" in resolution)
            throw new McpCallNotSent(resolution.refusal);
          return rc.deps.mcp.acquire(
            {
              ...resolution,
              profileId: pinned.profileId,
              sandbox: hold.sandbox,
              taskId: rc.task.id,
              redact: rc.redact,
              report: (event) =>
                writeRun(rc, (tx) =>
                  emit(tx, ctx, rc.task.id, {
                    type: "mcp.server",
                    payload: {
                      profileId: pinned.profileId,
                      server: pinned.server,
                      ...event,
                    },
                    ...attributionOf(rc),
                  }),
                ).then(() => {}),
            },
            signal,
          );
        },
      };
    });
  });
  return {
    bindings,
    mcp: {
      askFirst,
      // Asked by the review before a call is held, so no approval is asked
      // for a call that would be refused; the call checks again when it
      // runs, since the profile can change while it waits.
      refusal: async (tool) => {
        const check = checks.get(tool);
        if (!check) return undefined;
        const resolution = await check();
        return "refusal" in resolution ? resolution.refusal : undefined;
      },
    },
  };
}
