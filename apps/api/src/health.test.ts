// Liveness and readiness: the database, the migration level, the worker's
// heartbeat (the embedded job loop's, or a separate worker's row) and at
// least one available sandbox driver, each failing check with its reason.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Engine } from "@jj/backend";
import { migrationsFolder, recordWorkerHeartbeat } from "@jj/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { OPEN_TIMEOUT, quietLogger, type TestApp, testApp } from "./testing";

const json = (response: Response): Promise<any> => response.json();
const shipped = (
  JSON.parse(
    readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as { entries: unknown[] }
).entries.length;
let t: TestApp;
let idle: TestApp;

beforeAll(async () => {
  [t, idle] = await Promise.all([testApp(), testApp({ startWorker: false })]);
}, OPEN_TIMEOUT);
afterAll(async () => {
  await Promise.all([t?.dispose(), idle?.dispose()]);
});

/** An app over `engine`, its worker elsewhere unless `workerEmbedded`. */
const appOver = (engine: Engine, workerEmbedded = false, timeoutMs?: number) =>
  createApp({
    engine,
    config: {
      workerEmbedded,
      ...(timeoutMs ? { readinessTimeoutMs: timeoutMs } : {}),
    },
    logger: quietLogger,
  });

const ready = async (app: {
  request: (path: string) => Response | Promise<Response>;
}) => {
  const response = await app.request("/health/ready");
  return { status: response.status, body: await json(response) };
};

describe("GET /health/live and /health", () => {
  it("report the process alone, without the token", async () => {
    for (const path of ["/health/live", "/health"]) {
      const response = await t.app.request(path);
      expect(response.status, path).toBe(200);
      expect(await json(response)).toEqual({
        status: "ok",
        service: "jj-api",
        contractVersion: "1.9.0",
      });
    }
  });

  it("answer while every readiness check fails", async () => {
    const broken = {
      ...idle.engine,
      context: { ...idle.engine.context, db: {} },
      drivers: async () => {
        throw new Error("down");
      },
    } as unknown as Engine;
    const app = appOver(broken);
    expect((await app.request("/health/live")).status).toBe(200);
    expect((await ready(app)).status).toBe(503);
  });
});

describe("GET /health/ready", () => {
  it("is ready with the database, migrations, a polling worker and a driver", async () => {
    const { status, body } = await ready(t.app);
    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: "ready",
      checks: {
        database: { ok: true, reason: "reachable" },
        migrations: {
          ok: true,
          reason: "at this build's level",
          applied: shipped,
          expected: shipped,
        },
        worker: {
          ok: true,
          reason: "the job loop is polling",
          embedded: true,
          activeJobs: 0,
        },
        drivers: {
          ok: true,
          reason: "local available",
          available: ["local"],
          unavailable: [],
        },
      },
    });
    expect(Date.parse(body.checks.worker.lastPollAt)).not.toBeNaN();
  });

  it("is not ready while the embedded worker is not polling", async () => {
    const { status, body } = await ready(appOver(idle.engine, true));
    expect(status).toBe(503);
    expect(body).toMatchObject({
      status: "not_ready",
      checks: {
        worker: {
          ok: false,
          reason: "the job loop is not polling",
          embedded: true,
          lastPollAt: null,
        },
      },
    });
  });

  it("is not ready once the embedded worker's last poll is stale", async () => {
    const stalled = {
      ...t.engine,
      worker: {
        ...t.engine.worker,
        lastPollAt: new Date(Date.now() - 45_000),
        activeJobs: 1,
      },
    } as Engine;
    const { status, body } = await ready(appOver(stalled, true));
    expect(status).toBe(503);
    expect(body.checks.worker).toMatchObject({
      ok: false,
      reason: "the job loop last polled 45 s ago",
      embedded: true,
      activeJobs: 1,
    });
  });

  describe("with the worker in another process", () => {
    beforeEach(async () => {
      await idle.database.db.execute(sql`delete from worker_heartbeats`);
    });

    it("is not ready while no worker has a heartbeat", async () => {
      const { status, body } = await ready(idle.app);
      expect(status).toBe(503);
      expect(body.checks.worker).toEqual({
        ok: false,
        reason: "no worker has a heartbeat",
        embedded: false,
        workers: 0,
        lastSeenSecondsAgo: null,
      });
    });

    it("is ready while a worker's heartbeat is fresh", async () => {
      await recordWorkerHeartbeat(idle.database.db, "worker-elsewhere");
      const { status, body } = await ready(idle.app);
      expect(status).toBe(200);
      expect(body.checks.worker).toEqual({
        ok: true,
        reason: "a worker's heartbeat is fresh",
        embedded: false,
        workers: 1,
        lastSeenSecondsAgo: 0,
      });
      // It names no worker: their ids hold host names.
      expect(JSON.stringify(body)).not.toContain("worker-elsewhere");
    });

    it("is not ready once the newest heartbeat is stale", async () => {
      await recordWorkerHeartbeat(idle.database.db, "worker-elsewhere");
      await idle.database.db.execute(
        sql`update worker_heartbeats set seen_at = now() - interval '2 minutes'`,
      );
      const { status, body } = await ready(idle.app);
      expect(status).toBe(503);
      expect(body.checks.worker).toEqual({
        ok: false,
        reason: "the newest worker heartbeat is 120 s old",
        embedded: false,
        workers: 0,
        lastSeenSecondsAgo: 120,
      });
    });
  });

  it("is not ready without an available sandbox driver", async () => {
    const engine = {
      ...t.engine,
      drivers: async () => ({
        drivers: (await t.engine.drivers()).drivers.map((info) => ({
          ...info,
          available: false,
        })),
      }),
    } as Engine;
    const { status, body } = await ready(appOver(engine, true));
    expect(status).toBe(503);
    expect(body.checks.drivers).toEqual({
      ok: false,
      reason: "no sandbox driver is available",
      available: [],
      unavailable: ["local"],
    });
  });

  it("fails a check that does not answer in time", async () => {
    const engine = {
      ...t.engine,
      drivers: () => new Promise<never>(() => {}),
    } as unknown as Engine;
    const started = Date.now();
    const { status, body } = await ready(appOver(engine, true, 100));
    expect(status).toBe(503);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(body.checks.drivers).toEqual({
      ok: false,
      reason: "no answer within 100 ms",
    });
    expect(body.checks.database.ok).toBe(true);
  });

  it("is not ready when the database has a migration newer than this build", async () => {
    await t.database.db.execute(
      sql`insert into drizzle.__drizzle_migrations (hash, created_at) values ('from-a-newer-build', 9999999999999)`,
    );
    try {
      const { status, body } = await ready(t.app);
      expect(status).toBe(503);
      expect(body.checks.migrations).toEqual({
        ok: false,
        reason: "1 migration newer than this build",
        applied: shipped + 1,
        expected: shipped,
      });
    } finally {
      await t.database.db.execute(
        sql`delete from drizzle.__drizzle_migrations where hash = 'from-a-newer-build'`,
      );
    }
    expect((await ready(t.app)).status).toBe(200);
  });

  it("is not ready when a migration is pending, or the database fails", async () => {
    await idle.database.db.execute(
      sql`delete from drizzle.__drizzle_migrations`,
    );
    const pending = await ready(idle.app);
    expect(pending.status).toBe(503);
    expect(pending.body.checks.migrations).toEqual({
      ok: false,
      reason: `${shipped} migrations pending`,
      applied: 0,
      expected: shipped,
    });

    const engine = {
      ...idle.engine,
      context: {
        ...idle.engine.context,
        db: {
          execute: async () => {
            throw new Error("connection refused at 10.0.0.5:5432");
          },
          select: () => {
            throw new Error("connection refused at 10.0.0.5:5432");
          },
        },
      },
    } as unknown as Engine;
    const response = await appOver(engine).request("/health/ready");
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text).checks).toMatchObject({
      database: { ok: false, reason: "unreachable" },
      migrations: { ok: false, reason: "the migration record cannot be read" },
      worker: {
        ok: false,
        reason: "the worker heartbeats cannot be read",
        embedded: false,
      },
    });
    // Unauthenticated: no error text or endpoints leave the server.
    expect(text).not.toContain("10.0.0.5");
    expect(text).not.toContain("connection refused");
  });
});
