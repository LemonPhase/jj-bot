// Liveness and readiness: database, migrations, the embedded worker's
// heartbeat and at least one available sandbox driver.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Engine } from "@jj/backend";
import { migrationsFolder } from "@jj/db";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

describe("GET /health", () => {
  it("reports liveness without touching anything else", async () => {
    const response = await t.app.request("/health");
    expect(response.status).toBe(200);
    expect(await json(response)).toEqual({
      status: "ok",
      service: "jj-api",
      contractVersion: "1.0.2",
    });
  });
});

describe("GET /health/ready", () => {
  it("is ready with the database, migrations, a polling worker and a driver", async () => {
    const response = await t.app.request("/health/ready");
    expect(response.status).toBe(200);
    const body = await json(response);
    expect(body).toMatchObject({
      status: "ready",
      checks: {
        database: { ok: true },
        migrations: { ok: true, applied: shipped, expected: shipped },
        worker: { ok: true, embedded: true, activeJobs: 0 },
        drivers: { ok: true, available: ["local"], unavailable: [] },
      },
    });
    expect(Date.parse(body.checks.worker.lastPollAt)).not.toBeNaN();
  });

  it("is not ready while the embedded worker is not polling", async () => {
    const app = createApp({
      engine: idle.engine,
      config: { workerEmbedded: true },
      logger: quietLogger,
    });
    const response = await app.request("/health/ready");
    expect(response.status).toBe(503);
    expect(await json(response)).toMatchObject({
      status: "not_ready",
      checks: { worker: { ok: false, embedded: true, lastPollAt: null } },
    });
  });

  it("does not check a worker that runs elsewhere", async () => {
    const response = await idle.app.request("/health/ready");
    expect(response.status).toBe(200);
    expect((await json(response)).checks.worker).toEqual({
      ok: true,
      embedded: false,
    });
  });

  it("is not ready without an available sandbox driver", async () => {
    const engine = {
      ...idle.engine,
      drivers: async () => ({
        drivers: (await idle.engine.drivers()).drivers.map((info) => ({
          ...info,
          available: false,
        })),
      }),
    } as Engine;
    const app = createApp({
      engine,
      config: { workerEmbedded: false },
      logger: quietLogger,
    });
    const response = await app.request("/health/ready");
    expect(response.status).toBe(503);
    expect((await json(response)).checks.drivers).toEqual({
      ok: false,
      available: [],
      unavailable: ["local"],
    });
  });

  it("is not ready when a migration is pending, or the database fails", async () => {
    await idle.database.db.execute(
      sql`delete from drizzle.__drizzle_migrations`,
    );
    const pending = await idle.app.request("/health/ready");
    expect(pending.status).toBe(503);
    expect((await json(pending)).checks.migrations).toEqual({
      ok: false,
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
        },
      },
    } as unknown as Engine;
    const app = createApp({
      engine,
      config: { workerEmbedded: false },
      logger: quietLogger,
    });
    const response = await app.request("/health/ready");
    expect(response.status).toBe(503);
    const text = await response.text();
    expect(JSON.parse(text).checks).toMatchObject({
      database: { ok: false },
      migrations: { ok: false },
    });
    // Unauthenticated: no error text or endpoints leave the server.
    expect(text).not.toContain("10.0.0.5");
  });
});
