// `GET /health/live` (the process answers; `GET /health` is the same) and
// `GET /health/ready` (the database, the migration level, a worker's
// heartbeat and a sandbox driver). Both are unauthenticated, so checks report
// states, counts and a short reason, never error text, paths, hosts or ids;
// failures are logged server-side.
import type { Engine, Logger } from "@jj/backend";
import { CONTRACT_VERSION } from "@jj/contracts";
import { readSchemaLevel, workerHeartbeatStatus } from "@jj/db";
import { sql } from "drizzle-orm";
import { Hono } from "hono";

export interface ReadinessOptions {
  /** The job loop runs in this process, so its own heartbeat is checked; otherwise a worker's row in the database. */
  workerEmbedded: boolean;
  /** A worker poll older than this is stale. */
  workerStaleMs: number;
  /** A check that has not answered by then fails as timed out. Default 3 s. */
  checkTimeoutMs?: number;
}

export interface Check {
  ok: boolean;
  /** Why it passed or failed, in a few words. */
  reason: string;
  [detail: string]: unknown;
}

export interface Readiness {
  status: "ready" | "not_ready";
  checks: {
    database: Check;
    migrations: Check;
    worker: Check;
    drivers: Check;
  };
}

class CheckTimeout extends Error {}

const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

/** Runs a check, failing it (and logging why) when it throws or exceeds the timeout. */
async function run(
  what: string,
  timeoutMs: number,
  logger: Logger,
  check: () => Promise<Check>,
  failed: string,
): Promise<Check> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      check(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new CheckTimeout()), timeoutMs);
        timer.unref();
      }),
    ]);
  } catch (error) {
    if (error instanceof CheckTimeout) {
      logger.warn(`Readiness: ${what} did not answer within ${timeoutMs} ms`);
      return { ok: false, reason: `no answer within ${timeoutMs} ms` };
    }
    logger.warn(`Readiness: ${what} failed`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, reason: failed };
  } finally {
    clearTimeout(timer);
  }
}

async function migrations(engine: Engine): Promise<Check> {
  const level = await readSchemaLevel(engine.context.db);
  const detail = { applied: level.applied, expected: level.shipped };
  if (level.newer > 0)
    return {
      ok: false,
      reason: `${level.newer} migration${level.newer === 1 ? "" : "s"} newer than this build`,
      ...detail,
    };
  if (level.pending > 0)
    return {
      ok: false,
      reason: `${level.pending} migration${level.pending === 1 ? "" : "s"} pending`,
      ...detail,
    };
  return { ok: true, reason: "at this build's level", ...detail };
}

function embeddedWorker(engine: Engine, staleMs: number): Check {
  const last = engine.worker.lastPollAt;
  const ageMs = last ? Date.now() - last.getTime() : null;
  const detail = {
    embedded: true,
    lastPollAt: last?.toISOString() ?? null,
    activeJobs: engine.worker.activeJobs,
  };
  if (ageMs === null)
    return { ok: false, reason: "the job loop is not polling", ...detail };
  if (ageMs > staleMs)
    return {
      ok: false,
      reason: `the job loop last polled ${seconds(ageMs)} ago`,
      ...detail,
    };
  return { ok: true, reason: "the job loop is polling", ...detail };
}

async function separateWorker(engine: Engine, staleMs: number): Promise<Check> {
  const status = await workerHeartbeatStatus(engine.context.db, staleMs);
  const detail = {
    embedded: false,
    workers: status.fresh,
    lastSeenSecondsAgo:
      status.newestAgeMs === null
        ? null
        : Math.round(status.newestAgeMs / 1000),
  };
  if (status.fresh > 0)
    return { ok: true, reason: "a worker's heartbeat is fresh", ...detail };
  return {
    ok: false,
    reason:
      status.newestAgeMs === null
        ? "no worker has a heartbeat"
        : `the newest worker heartbeat is ${seconds(status.newestAgeMs)} old`,
    ...detail,
  };
}

async function drivers(engine: Engine): Promise<Check> {
  const { drivers } = await engine.drivers();
  const available = drivers
    .filter((info) => info.available)
    .map((info) => info.id);
  const unavailable = drivers
    .filter((info) => !info.available)
    .map((info) => info.id);
  return available.length > 0
    ? {
        ok: true,
        reason: `${available.join(", ")} available`,
        available,
        unavailable,
      }
    : {
        ok: false,
        reason: "no sandbox driver is available",
        available,
        unavailable,
      };
}

export async function readiness(
  engine: Engine,
  options: ReadinessOptions,
  logger: Logger,
): Promise<Readiness> {
  const timeoutMs = options.checkTimeoutMs ?? 3_000;
  const [database, migrationLevel, worker, driverCheck] = await Promise.all([
    run(
      "the database query",
      timeoutMs,
      logger,
      async () => {
        await engine.context.db.execute(sql`select 1`);
        return { ok: true, reason: "reachable" };
      },
      "unreachable",
    ),
    run(
      "the migration check",
      timeoutMs,
      logger,
      () => migrations(engine),
      "the migration record cannot be read",
    ),
    options.workerEmbedded
      ? Promise.resolve(embeddedWorker(engine, options.workerStaleMs))
      : run(
          "the worker heartbeat check",
          timeoutMs,
          logger,
          () => separateWorker(engine, options.workerStaleMs),
          "the worker heartbeats cannot be read",
        ).then((check) => ({ embedded: false, ...check })),
    run(
      "the driver probe",
      timeoutMs,
      logger,
      () => drivers(engine),
      "the drivers cannot be probed",
    ),
  ]);
  const checks = {
    database,
    migrations: migrationLevel,
    worker,
    drivers: driverCheck,
  };
  return {
    status: Object.values(checks).every((check) => check.ok)
      ? "ready"
      : "not_ready",
    checks,
  };
}

export function healthRoutes(
  engine: Engine,
  options: ReadinessOptions,
  logger: Logger,
) {
  const health = new Hono();
  const live = () => ({
    status: "ok",
    service: "jj-api",
    contractVersion: CONTRACT_VERSION,
  });
  health.get("/", (c) => c.json(live()));
  health.get("/live", (c) => c.json(live()));
  health.get("/ready", async (c) => {
    const report = await readiness(engine, options, logger);
    c.header("Cache-Control", "no-store");
    return c.json(report, report.status === "ready" ? 200 : 503);
  });
  return health;
}
