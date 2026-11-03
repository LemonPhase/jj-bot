// One `mcp.discover` job: tests one MCP server configuration of a profile.
// A stdio server runs in an ephemeral sandbox of its own, built from the
// profile's spec and secret grants, with no task files, and released
// whatever happens; a remote one is called through the guard with its
// secret headers. The runtime calls only `initialize` and `tools/list`.
// What is stored (the snapshot, the error, the stderr tail) is redacted.
import {
  type McpServer,
  type McpToolSnapshot,
  mcpServerSchema,
  mcpToolSnapshotSchema,
  type SandboxSpec,
} from "@jj/contracts";
import {
  type ClaimedJob,
  complete,
  enqueue,
  type JobRow,
  mcpDiscoveries,
  mcpToolSnapshots,
  runtimeProfiles,
  type Tx,
} from "@jj/db";
import type { Sandbox } from "@jj/sandbox/contract";
import { and, eq, inArray } from "drizzle-orm";
import type { EngineContext } from "../context";
import { errorMessage } from "../errors";
import type { McpDiscoverResult } from "../ports";
import { profileSettings } from "../records";
import type { Secret } from "../redact";
import { mcpConfigHash } from "../services/mcp";
import { grantedSecrets, secretHeaderValues } from "../services/secrets";
import {
  fencedWrite,
  type JobControl,
  LeaseLostError,
  type WorkerDeps,
} from "./run-context";

/** The contract's caps on a discovery's `error` and `stderrTail`. */
const TEXT_LIMIT = 2_000;

const GIVEN_UP =
  "The worker testing this server stopped too many times; test it again.";

const discoveryIdOf = (job: Pick<JobRow, "payload">) =>
  typeof job.payload.discoveryId === "string"
    ? job.payload.discoveryId
    : undefined;

/** The start of `text`, at most TEXT_LIMIT characters. */
const head = (text: string) =>
  text.length <= TEXT_LIMIT ? text : `${text.slice(0, TEXT_LIMIT - 1)}…`;
/** The end of `text`, at most TEXT_LIMIT characters. */
const tail = (text: string) =>
  text.length <= TEXT_LIMIT ? text : `…${text.slice(-(TEXT_LIMIT - 1))}`;

/** A sandbox of its own: the profile's spec with an ephemeral workspace, keyed by the discovery. */
async function acquire(
  ctx: EngineContext,
  discoveryId: string,
  spec: SandboxSpec,
  secrets: Record<string, string>,
  signal: AbortSignal,
): Promise<Sandbox> {
  const driver = ctx.drivers.get(spec.driver);
  if (!driver)
    throw new Error(
      `Sandbox driver "${spec.driver}" is not installed on this server.`,
    );
  const ephemeral = driver.validateSpec({ ...spec, workspace: "ephemeral" });
  const limitMs = ctx.config.discoveryAcquireMs;
  const starting = driver.acquire({
    taskId: discoveryId,
    sessionId: discoveryId,
    spec: ephemeral,
    workspaceKey: discoveryId,
    signal: AbortSignal.any([signal, AbortSignal.timeout(limitMs)]),
    ...(Object.keys(secrets).length > 0 ? { secrets } : {}),
  });
  // Bounded whether or not the driver heeds its signal: the job's slot is
  // given back on time.
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      starting,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new Error(
                `it did not start within ${Math.ceil(limitMs / 1000)} s`,
              ),
            ),
          limitMs,
        );
      }),
    ]);
  } catch (error) {
    // One that starts after the wait ended is released at once.
    void starting.then(
      (late) => late.release().catch(() => {}),
      () => {},
    );
    throw new Error(`The sandbox could not start: ${errorMessage(error)}`);
  } finally {
    clearTimeout(timer);
  }
}

type Outcome =
  | { kind: "succeeded"; result: McpDiscoverResult }
  | { kind: "failed"; error: string; stderrTail: string | null };

/** Runs the discovery; never throws. */
async function discover(
  ctx: EngineContext,
  discoveryId: string,
  server: McpServer,
  profile: { name: string; sandbox: SandboxSpec; secrets: string[] },
  signal: AbortSignal,
): Promise<Outcome> {
  let redact = await ctx.redactor();
  try {
    const mcp = ctx.mcp;
    if (!mcp) throw new Error("This server has no MCP client.");
    if (server.transport === "http") {
      const headers = await secretHeaderValues(ctx, server);
      redact = await ctx.redactor(
        Object.entries(headers).map(([name, header]) => ({
          name: `the ${name} header of MCP server ${server.name}`,
          value: header.value,
        })),
      );
      const result = await mcp.discover({
        server,
        secretHeaders: headers,
        redact: (text, cut) => redact(text, cut),
        signal,
      });
      return { kind: "succeeded", result };
    }
    const secrets = await grantedSecrets(ctx, profile);
    const injected: Secret[] = Object.entries(secrets).map(([name, value]) => ({
      name: `the sandbox secret ${name}`,
      value,
    }));
    redact = await ctx.redactor(injected);
    const sandbox = await acquire(
      ctx,
      discoveryId,
      profile.sandbox,
      secrets,
      signal,
    );
    try {
      const result = await mcp.discover({
        server,
        sandbox,
        redact: (text, cut) => redact(text, cut),
        signal,
      });
      return { kind: "succeeded", result };
    } finally {
      await sandbox
        .release()
        .catch((error: unknown) =>
          ctx.logger.warn(
            `Releasing the sandbox of MCP discovery ${discoveryId} failed`,
            { error: errorMessage(error) },
          ),
        );
    }
  } catch (error) {
    const stderr = (error as { stderrTail?: unknown }).stderrTail;
    const stderrTail =
      typeof stderr === "string" && stderr.trim() !== ""
        ? tail(redact(stderr))
        : null;
    let message = redact(errorMessage(error));
    // The tail is stored on its own; the message need not repeat it.
    if (stderrTail) {
      const at = message.lastIndexOf(" Its latest stderr:\n");
      if (at > 0) message = message.slice(0, at);
    }
    return { kind: "failed", error: head(message), stderrTail };
  }
}

/** The snapshot the result makes, checked against the contract before it is stored. */
function snapshotOf(
  ctx: EngineContext,
  discovery: { profileId: string; server: string; configHash: string },
  result: McpDiscoverResult,
): McpToolSnapshot {
  return mcpToolSnapshotSchema.parse({
    id: ctx.ids("mcpSnapshot"),
    profileId: discovery.profileId,
    server: discovery.server,
    configHash: discovery.configHash,
    serverInfo: result.serverInfo,
    tools: result.tools,
    warnings: result.warnings,
    discoveredAt: ctx.clock().toISOString(),
  });
}

/** Records the outcome on a discovery still running, and completes the job. */
async function finish(
  tx: Tx,
  ctx: EngineContext,
  job: ClaimedJob,
  discoveryId: string,
  outcome: Outcome,
  durationMs: number,
) {
  // The profile first, as its deletion takes it before the discoveries it
  // cascades to; the snapshot's foreign key needs it too.
  const [discovery] = await tx
    .select({ profileId: mcpDiscoveries.profileId })
    .from(mcpDiscoveries)
    .where(eq(mcpDiscoveries.id, discoveryId));
  const [profile] = discovery
    ? await tx
        .select({ id: runtimeProfiles.id })
        .from(runtimeProfiles)
        .where(eq(runtimeProfiles.id, discovery.profileId))
        .for("key share")
    : [];
  const [row] = profile
    ? await tx
        .select()
        .from(mcpDiscoveries)
        .where(eq(mcpDiscoveries.id, discoveryId))
        .for("update")
    : [];
  // Deleted with its profile, or pruned, while it ran: nothing to record.
  if (row?.status === "running") {
    let final = outcome;
    let snapshot: McpToolSnapshot | undefined;
    if (final.kind === "succeeded")
      try {
        snapshot = snapshotOf(ctx, row, final.result);
      } catch (error) {
        final = {
          kind: "failed",
          error: head(
            `The server's tools could not be stored: ${errorMessage(error)}`,
          ),
          stderrTail: null,
        };
      }
    if (snapshot)
      await tx.insert(mcpToolSnapshots).values({
        id: snapshot.id,
        profileId: snapshot.profileId,
        server: snapshot.server,
        configHash: snapshot.configHash,
        serverInfo: snapshot.serverInfo,
        tools: snapshot.tools,
        warnings: snapshot.warnings,
        discoveredAt: new Date(snapshot.discoveredAt),
      });
    await tx
      .update(mcpDiscoveries)
      .set({
        status: final.kind,
        snapshotId: snapshot?.id ?? null,
        error: final.kind === "failed" ? final.error : null,
        stderrTail: final.kind === "failed" ? final.stderrTail : null,
        durationMs: Math.max(0, Math.round(durationMs)),
        finishedAt: ctx.clock(),
      })
      .where(eq(mcpDiscoveries.id, discoveryId));
  }
  await complete(tx, job.lease);
}

/** A graceful stop: the discovery waits for the next worker, as a session run does. */
async function handBack(tx: Tx, job: ClaimedJob, discoveryId: string) {
  await tx
    .update(mcpDiscoveries)
    .set({ status: "queued", startedAt: null })
    .where(
      and(
        eq(mcpDiscoveries.id, discoveryId),
        eq(mcpDiscoveries.status, "running"),
      ),
    );
  if (await complete(tx, job.lease))
    await enqueue(tx, { kind: "mcp.discover", payload: job.payload });
}

export async function runDiscoveryJob(
  deps: WorkerDeps,
  job: ClaimedJob,
  control: JobControl,
): Promise<void> {
  const { ctx } = deps;
  const write = <T>(fn: (tx: Tx) => Promise<T>) =>
    fencedWrite(ctx, job.lease, control, fn);
  const discoveryId = discoveryIdOf(job);
  try {
    const started = await write(async (tx) => {
      const [row] = discoveryId
        ? await tx
            .select()
            .from(mcpDiscoveries)
            .where(eq(mcpDiscoveries.id, discoveryId))
            .for("update")
        : [];
      const [profile] = row
        ? await tx
            .select()
            .from(runtimeProfiles)
            .where(eq(runtimeProfiles.id, row.profileId))
        : [];
      // Gone, or already recorded by an earlier claim.
      if (
        !row ||
        !profile ||
        (row.status !== "queued" && row.status !== "running")
      ) {
        await complete(tx, job.lease);
        return undefined;
      }
      const parsed = mcpServerSchema.safeParse(row.config);
      const settings = profileSettings(profile);
      // What the snapshot will describe: the sandbox it runs in now.
      let configHash = row.configHash;
      if (parsed.success)
        try {
          configHash = mcpConfigHash(parsed.data, settings.sandbox);
        } catch {
          // Refused at the test's start already; kept as it was.
        }
      await tx
        .update(mcpDiscoveries)
        .set({ status: "running", startedAt: ctx.clock(), configHash })
        .where(eq(mcpDiscoveries.id, row.id));
      return { row, profile, parsed, settings };
    });
    if (!started || !discoveryId) return;
    const startedAt = performance.now();
    const { parsed, settings } = started;
    ctx.logger.info("MCP discovery started", {
      discoveryId,
      server: started.row.server,
    });
    const outcome: Outcome = parsed.success
      ? await discover(
          ctx,
          discoveryId,
          parsed.data,
          {
            name: started.profile.name,
            sandbox: settings.sandbox,
            secrets: settings.secrets,
          },
          control.controller.signal,
        )
      : {
          kind: "failed",
          error: "The configuration tested is no longer valid.",
          stderrTail: null,
        };
    if (control.fenced) return;
    if (control.reason === "shutdown") {
      await write((tx) => handBack(tx, job, discoveryId));
      return;
    }
    await write((tx) =>
      finish(tx, ctx, job, discoveryId, outcome, performance.now() - startedAt),
    );
    ctx.logger.info("MCP discovery finished", {
      discoveryId,
      status: outcome.kind,
    });
  } catch (error) {
    if (error instanceof LeaseLostError) return;
    throw error;
  }
}

/** A discovery whose job's lease ran out too often fails visibly. */
export async function giveUpDiscovery(
  ctx: EngineContext,
  job: JobRow,
): Promise<void> {
  const discoveryId = discoveryIdOf(job);
  if (!discoveryId) return;
  await ctx.db
    .update(mcpDiscoveries)
    .set({ status: "failed", error: GIVEN_UP, finishedAt: ctx.clock() })
    .where(
      and(
        eq(mcpDiscoveries.id, discoveryId),
        inArray(mcpDiscoveries.status, ["queued", "running"]),
      ),
    );
}
