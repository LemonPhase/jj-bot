// `GET /health` (liveness) and `GET /health/ready` (readiness). Both are
// unauthenticated, so checks report states and counts, never error text or
// endpoints; failures are logged server-side.
import type { Engine, Logger } from "@jj/backend";
import { CONTRACT_VERSION } from "@jj/contracts";
import { migrationStatus } from "@jj/db";
import { sql } from "drizzle-orm";
import { Hono } from "hono";

export interface ReadinessOptions {
  /** The job loop runs in this process, so its heartbeat is checked. */
  workerEmbedded: boolean;
  /** A worker poll older than this is stale. */
  workerStaleMs: number;
}

interface Check {
  ok: boolean;
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

const failure = (logger: Logger, what: string) => (error: unknown) => {
  logger.warn(`Readiness: ${what} failed`, {
    error: error instanceof Error ? error.message : String(error),
  });
  return { ok: false } as Check;
};

export async function readiness(
  engine: Engine,
  options: ReadinessOptions,
  logger: Logger,
): Promise<Readiness> {
  const { db } = engine.context;
  const [database, migrations, drivers] = await Promise.all([
    db
      .execute(sql`select 1`)
      .then((): Check => ({ ok: true }))
      .catch(failure(logger, "the database query")),
    migrationStatus(db)
      .then(
        (status): Check => ({
          ok: status.pending === 0,
          applied: status.applied,
          expected: status.expected,
        }),
      )
      .catch(failure(logger, "the migration check")),
    engine
      .drivers()
      .then(({ drivers }): Check => {
        const available = drivers
          .filter((info) => info.available)
          .map((info) => info.id);
        return {
          ok: available.length > 0,
          available,
          unavailable: drivers
            .filter((info) => !info.available)
            .map((info) => info.id),
        };
      })
      .catch(failure(logger, "the driver probe")),
  ]);
  let worker: Check;
  if (!options.workerEmbedded) worker = { ok: true, embedded: false };
  else {
    const last = engine.worker.lastPollAt;
    const ageMs = last ? Date.now() - last.getTime() : null;
    worker = {
      ok: ageMs !== null && ageMs <= options.workerStaleMs,
      embedded: true,
      lastPollAt: last?.toISOString() ?? null,
      activeJobs: engine.worker.activeJobs,
    };
  }
  const checks = { database, migrations, worker, drivers };
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
  health.get("/", (c) =>
    c.json({
      status: "ok",
      service: "jj-api",
      contractVersion: CONTRACT_VERSION,
    }),
  );
  health.get("/ready", async (c) => {
    const report = await readiness(engine, options, logger);
    return c.json(report, report.status === "ready" ? 200 : 503);
  });
  return health;
}
