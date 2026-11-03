// MCP servers of runtime profiles: the configuration hash a snapshot is
// discovered for, the rules a profile's servers must pass when it is saved,
// and discoveries. `POST /api/runtime-profiles/:id/mcp-discoveries` records
// a queued discovery and its `mcp.discover` job; the worker runs it
// (worker/mcp-discovery.ts), since only the worker acquires sandboxes.
import {
  type ApprovalRule,
  canonicalJson,
  declaredMcpTools,
  MAX_MCP_DIRECT_TOOLS,
  type McpDiscovery,
  type McpServer,
  type McpToolSnapshot,
  mcpRulesWithoutTool,
  type SandboxSpec,
  type StartMcpDiscoveryCommand,
  sha256Hex,
  startMcpDiscoveryCommandSchema,
  ungrantedMcpSecrets,
} from "@jj/contracts";
import {
  type Executor,
  enqueue,
  mcpDiscoveries,
  mcpToolSnapshots,
  runtimeProfiles,
  secrets,
  type Tx,
} from "@jj/db";
import {
  and,
  desc,
  eq,
  inArray,
  notExists,
  notInArray,
  sql,
} from "drizzle-orm";
import type { EngineContext } from "../context";
import { DomainError, notFound, parseCommand } from "../errors";
import { wakeWorkers } from "../events";
import { profileSettings, toMcpDiscovery, toMcpSnapshot } from "../records";

/** Finished discoveries a profile keeps, the newest; older ones go with their unpinned snapshots. */
export const MAX_KEPT_DISCOVERIES = 20;

const FINISHED = ["succeeded", "failed"] as const;
const ACTIVE = ["queued", "running"] as const;

/** Why remote servers cannot run here, as the runtime words it. */
const REMOTE_OFF =
  "remote MCP servers are turned off on this server (JJ_MCP_REMOTE=off).";

/**
 * SHA-256 of what runs, as canonical JSON: the transport and, for stdio,
 * the command, args, cwd, env and `secretEnv` (variable to secret name),
 * and the sandbox it runs in (the profile's driver, image, network policy
 * and `sandbox.env`, which can change what the server lists); for http the
 * URL, plain headers and `secretHeaders` (header to secret name and
 * prefix), called by the worker whatever the sandbox. Secret values never
 * enter it. A snapshot pins the hash of the configuration it was
 * discovered with; the name, description, exposure, timeouts and `enabled`
 * do not change what runs. A configuration whose canonical JSON passes the
 * canonical limit (1 Mi characters) is refused rather than hashed.
 */
export function mcpConfigHash(
  server: McpServer,
  sandbox: Pick<SandboxSpec, "driver" | "image" | "network" | "env">,
): string {
  const runs =
    server.transport === "stdio"
      ? {
          transport: "stdio",
          command: server.command,
          args: server.args,
          cwd: server.cwd ?? null,
          env: server.env,
          secretEnv: server.secretEnv,
          sandbox: {
            driver: sandbox.driver,
            image: sandbox.image ?? null,
            network: sandbox.network,
            env: sandbox.env,
          },
        }
      : {
          transport: "http",
          url: server.url,
          headers: server.headers,
          secretHeaders: server.secretHeaders,
        };
  const json = canonicalJson(runs);
  if (json === undefined)
    throw new DomainError(
      "VALIDATION_FAILED",
      `${server.name}: the configuration is too large to identify; use shorter args, env or headers.`,
    );
  return sha256Hex(json);
}

/** Where a server's problem is reported: `mcpServers.<i>` in a profile, `server` in a discovery. */
interface At {
  list: string;
  item(index: number): string;
}
const inProfile: At = {
  list: "mcpServers",
  item: (index) => `mcpServers.${index}`,
};
const inDiscovery: At = { list: "server", item: () => "server" };

/**
 * MCP_UNAVAILABLE unless this server can run every one of `servers`: it
 * has an MCP client, a stdio server's sandbox driver declares `spawn`, and
 * remote servers are not turned off.
 */
export function assertMcpRunnable(
  ctx: EngineContext,
  servers: readonly McpServer[],
  sandbox: SandboxSpec,
  at: At = inProfile,
): void {
  if (servers.length === 0) return;
  if (!ctx.mcp)
    throw new DomainError(
      "MCP_UNAVAILABLE",
      `${at.list}: this server has no MCP client, so it runs no MCP server.`,
    );
  const driver = ctx.drivers.get(sandbox.driver);
  servers.forEach((server, index) => {
    if (server.transport === "stdio" && !driver?.capabilities.spawn)
      throw new DomainError(
        "MCP_UNAVAILABLE",
        `${at.item(index)}: ${server.name} runs in the task's sandbox, and the ${sandbox.driver} driver cannot start long-lived processes (spawn).`,
      );
    if (server.transport === "http" && !ctx.mcp?.remote)
      throw new DomainError(
        "MCP_UNAVAILABLE",
        `${at.item(index)}: ${server.name} is a remote server, and ${REMOTE_OFF}`,
      );
  });
}

/**
 * VALIDATION_FAILED for each stdio `secretEnv` secret the profile does not
 * grant, on enabled servers (`ungrantedMcpSecrets`): one disabled when its
 * secret was removed keeps its reference, and is checked again when it is
 * enabled.
 */
export function assertSecretEnvGranted(
  servers: readonly McpServer[],
  grants: readonly string[],
  at: At = inProfile,
): void {
  const missing = ungrantedMcpSecrets(servers, grants);
  if (missing.length > 0)
    throw new DomainError(
      "VALIDATION_FAILED",
      missing
        .map(
          (entry) =>
            `${at.item(entry.index)}.secretEnv.${entry.variable}: ${entry.secret} is not granted by this profile; grant it under secrets first.`,
        )
        .join("; "),
    );
}

/**
 * VALIDATION_FAILED unless every secret an enabled remote server's
 * `secretHeaders` names is stored. They are sandbox secrets, sent by the worker and never
 * granted to a sandbox. The rows are locked for the transaction, so a
 * concurrent removal waits and then disables the server.
 */
export async function assertSecretHeadersStored(
  ctx: EngineContext,
  tx: Tx,
  servers: readonly McpServer[],
  at: At = inProfile,
): Promise<void> {
  const wanted = servers.flatMap((server, index) =>
    server.transport === "http" && server.enabled
      ? Object.entries(server.secretHeaders).map(([header, { secret }]) => ({
          index,
          header,
          secret,
        }))
      : [],
  );
  if (wanted.length === 0) return;
  const stored = await tx
    .select({ name: secrets.name })
    .from(secrets)
    .where(
      and(
        eq(secrets.ownerId, ctx.secretStore.owner),
        eq(secrets.kind, "sandbox"),
        inArray(secrets.name, [
          ...new Set(wanted.map((entry) => entry.secret)),
        ]),
      ),
    )
    .for("share");
  const missing = wanted.filter(
    (entry) => !stored.some((row) => row.name === entry.secret),
  );
  if (missing.length > 0)
    throw new DomainError(
      "VALIDATION_FAILED",
      missing
        .map(
          (entry) =>
            `${at.item(entry.index)}.secretHeaders.${entry.header}: no sandbox secret named ${entry.secret} is stored. Add it in Settings → Secrets first.`,
        )
        .join("; "),
    );
}

/**
 * The snapshots `servers` pin, each locked for the transaction.
 * MCP_SNAPSHOT_MISMATCH unless each exists, was discovered for this
 * profile and this server, and for the configuration the server has now,
 * in the profile's sandbox (`mcpConfigHash`).
 */
export async function pinnedSnapshots(
  tx: Tx,
  profileId: string,
  servers: readonly McpServer[],
  sandbox: SandboxSpec,
): Promise<McpToolSnapshot[]> {
  const ids = servers.flatMap((server) =>
    server.snapshotId === null ? [] : [server.snapshotId],
  );
  if (ids.length === 0) return [];
  const rows = await tx
    .select()
    .from(mcpToolSnapshots)
    .where(inArray(mcpToolSnapshots.id, [...new Set(ids)]))
    .for("share");
  const problems = servers.flatMap((server, index) => {
    if (server.snapshotId === null) return [];
    const row = rows.find((candidate) => candidate.id === server.snapshotId);
    const where = `mcpServers.${index}.snapshotId`;
    if (!row || row.profileId !== profileId || row.server !== server.name)
      return [
        `${where}: ${server.snapshotId} is not a snapshot of ${server.name} in this profile. Test the server and pin the snapshot it finds.`,
      ];
    if (row.configHash !== mcpConfigHash(server, sandbox))
      return [
        `${where}: ${server.snapshotId} was discovered for another configuration of ${server.name}, or another sandbox. Test the server again and pin the new snapshot.`,
      ];
    return [];
  });
  if (problems.length > 0)
    throw new DomainError("MCP_SNAPSHOT_MISMATCH", problems.join("; "));
  return rows.map(toMcpSnapshot);
}

/** VALIDATION_FAILED for an exact `mcp__<server>__<tool>` rule naming no tool of that server's pinned snapshot. */
export function assertMcpRulesKnown(
  rules: readonly ApprovalRule[],
  servers: readonly McpServer[],
  snapshots: readonly McpToolSnapshot[],
): void {
  const unknown = mcpRulesWithoutTool(rules, servers, snapshots);
  if (unknown.length > 0)
    throw new DomainError(
      "VALIDATION_FAILED",
      unknown
        .map(
          (index) =>
            `approvals.${index}.tool: ${rules[index]?.tool} names no tool of its MCP server's pinned snapshot. Exact names hold only within a snapshot; mcp__<server>__* covers every tool of a server.`,
        )
        .join("; "),
    );
}

/** VALIDATION_FAILED when a new session would declare more than MAX_MCP_DIRECT_TOOLS MCP tools. */
export function assertDeclaredCap(
  servers: readonly McpServer[],
  snapshots: readonly McpToolSnapshot[],
): void {
  const declared = declaredMcpTools(servers, snapshots).length;
  if (declared > MAX_MCP_DIRECT_TOOLS)
    throw new DomainError(
      "VALIDATION_FAILED",
      `mcpServers: this profile would declare ${declared} MCP tools, over the limit of ${MAX_MCP_DIRECT_TOOLS}. Set some servers or tools to hidden, or disable a server.`,
    );
}

/** What a profile save changes, for `checkMcpServers`. */
export interface McpSave {
  profileId: string;
  sandbox: SandboxSpec;
  secrets: readonly string[];
  mcpServers: readonly McpServer[];
  approvals: readonly ApprovalRule[];
  /** Which of them the save sets; on create, all. */
  changed: {
    sandbox: boolean;
    secrets: boolean;
    servers: boolean;
    approvals: boolean;
  };
}

/**
 * The save-time rules, on the merged profile, in the save's transaction:
 * every server can run here (MCP_UNAVAILABLE), each stdio `secretEnv`
 * secret is granted and each `secretHeaders` secret stored
 * (VALIDATION_FAILED), each pinned snapshot matches (MCP_SNAPSHOT_MISMATCH),
 * every exact MCP approval rule names a pinned tool, and the profile
 * declares at most MAX_MCP_DIRECT_TOOLS (VALIDATION_FAILED). A rule is
 * checked only when the save changes what it reads; the secret rules skip
 * disabled servers, so a server disabled with its secret's removal never
 * stops a save.
 */
export async function checkMcpServers(
  ctx: EngineContext,
  tx: Tx,
  save: McpSave,
): Promise<void> {
  const { changed, mcpServers: servers } = save;
  if (changed.servers || changed.sandbox)
    assertMcpRunnable(ctx, servers, save.sandbox);
  if (changed.servers || changed.secrets)
    assertSecretEnvGranted(servers, save.secrets);
  if (changed.servers) await assertSecretHeadersStored(ctx, tx, servers);
  if (!changed.servers && !changed.approvals && !changed.sandbox) return;
  const snapshots = await pinnedSnapshots(
    tx,
    save.profileId,
    servers,
    save.sandbox,
  );
  assertMcpRulesKnown(save.approvals, servers, snapshots);
  if (changed.servers) assertDeclaredCap(servers, snapshots);
}

/**
 * Deletes the profile's finished discoveries past the newest
 * MAX_KEPT_DISCOVERIES (one still queued or running is never deleted: a
 * client may be polling it and the worker running it), then its snapshots
 * that neither its servers pin nor a kept discovery holds. The caller holds
 * the profile row, so no save pins a snapshot while this runs.
 */
async function prune(tx: Tx, profileId: string, pinned: readonly string[]) {
  const kept = tx
    .select({ id: mcpDiscoveries.id })
    .from(mcpDiscoveries)
    .where(
      and(
        eq(mcpDiscoveries.profileId, profileId),
        inArray(mcpDiscoveries.status, FINISHED),
      ),
    )
    .orderBy(desc(mcpDiscoveries.createdAt), desc(mcpDiscoveries.id))
    .limit(MAX_KEPT_DISCOVERIES);
  await tx
    .delete(mcpDiscoveries)
    .where(
      and(
        eq(mcpDiscoveries.profileId, profileId),
        inArray(mcpDiscoveries.status, FINISHED),
        notInArray(mcpDiscoveries.id, kept),
      ),
    );
  await tx
    .delete(mcpToolSnapshots)
    .where(
      and(
        eq(mcpToolSnapshots.profileId, profileId),
        ...(pinned.length > 0
          ? [notInArray(mcpToolSnapshots.id, [...pinned])]
          : []),
        notExists(
          tx
            .select({ one: sql`1` })
            .from(mcpDiscoveries)
            .where(eq(mcpDiscoveries.snapshotId, mcpToolSnapshots.id)),
        ),
      ),
    );
}

/**
 * `POST /api/runtime-profiles/:id/mcp-discoveries`: queues a test of a
 * configuration, saved in the profile or not, with the stored profile's
 * sandbox spec and grants. It must be one this server can run, its
 * `secretEnv` secrets granted by the profile and its `secretHeaders`
 * secrets stored. The worker runs it; poll `GET /api/mcp-discoveries/:id`.
 * A server of the profile has at most one discovery queued or running: a
 * test while one is returns that one.
 */
export async function startDiscovery(
  ctx: EngineContext,
  profileId: string,
  input: StartMcpDiscoveryCommand,
): Promise<{ discovery: McpDiscovery }> {
  const { server } = parseCommand(startMcpDiscoveryCommandSchema, input);
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(runtimeProfiles)
      .where(eq(runtimeProfiles.id, profileId))
      .for("no key update");
    if (!row) throw notFound("Runtime profile", profileId);
    const settings = profileSettings(row);
    assertMcpRunnable(ctx, [server], settings.sandbox, inDiscovery);
    assertSecretEnvGranted([server], settings.secrets, inDiscovery);
    await assertSecretHeadersStored(ctx, tx, [server], inDiscovery);
    const configHash = mcpConfigHash(server, settings.sandbox);
    // The profile row is held, so no other test of this server starts meanwhile.
    const [active] = await tx
      .select()
      .from(mcpDiscoveries)
      .where(
        and(
          eq(mcpDiscoveries.profileId, profileId),
          eq(mcpDiscoveries.server, server.name),
          inArray(mcpDiscoveries.status, ACTIVE),
        ),
      )
      .limit(1);
    if (active) return { discovery: toMcpDiscovery(active, undefined) };
    const id = ctx.ids("mcpDiscovery");
    const [inserted] = await tx
      .insert(mcpDiscoveries)
      .values({
        id,
        profileId,
        server: server.name,
        config: server,
        configHash,
        createdAt: ctx.clock(),
      })
      .returning();
    await enqueue(tx, {
      kind: "mcp.discover",
      payload: { discoveryId: id },
    });
    await wakeWorkers(tx);
    await prune(
      tx,
      profileId,
      settings.mcpServers.flatMap((entry) =>
        entry.snapshotId === null ? [] : [entry.snapshotId],
      ),
    );
    if (!inserted) throw new Error("The discovery insert returned no row.");
    return { discovery: toMcpDiscovery(inserted, undefined) };
  });
}

async function snapshotRow(exec: Executor, id: string) {
  const [row] = await exec
    .select()
    .from(mcpToolSnapshots)
    .where(eq(mcpToolSnapshots.id, id));
  return row;
}

/** `GET /api/mcp-discoveries/:id`, with its snapshot once it succeeded. */
export async function getDiscovery(
  ctx: EngineContext,
  id: string,
): Promise<{ discovery: McpDiscovery }> {
  const [row] = await ctx.db
    .select()
    .from(mcpDiscoveries)
    .where(eq(mcpDiscoveries.id, id));
  if (!row) throw notFound("MCP discovery", id);
  const snapshot = row.snapshotId
    ? await snapshotRow(ctx.db, row.snapshotId)
    : undefined;
  return { discovery: toMcpDiscovery(row, snapshot) };
}

/** `GET /api/mcp-snapshots/:id`. */
export async function getSnapshot(
  ctx: EngineContext,
  id: string,
): Promise<{ snapshot: McpToolSnapshot }> {
  const row = await snapshotRow(ctx.db, id);
  if (!row) throw notFound("MCP tool snapshot", id);
  return { snapshot: toMcpSnapshot(row) };
}
