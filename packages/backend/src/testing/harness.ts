// Test harness: a database per suite (PGlite, or PostgreSQL when
// JJ_TEST_DATABASE_URL is set), engines wired to the local sandbox driver and
// the fakes, and polling helpers. Not exported from the package.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskView } from "@jj/contracts";
import { type Database, jobs, openDatabase, ulid } from "@jj/db";
import { LocalSandboxDriver } from "@jj/sandbox";
import { inArray, sql } from "drizzle-orm";
import { Client } from "pg";
import type { EngineConfigInput } from "../config";
import type { Logger } from "../context";
import { createDriverRegistry, type DriverEntry } from "../drivers";
import { createEngine, type Engine } from "../engine";
import type { DriverRegistry } from "../ports";
import { FakeExecutor } from "./fake-executor";
import { FakeChatResponder, FakeModels } from "./fakes";

export const postgresUrl = process.env.JJ_TEST_DATABASE_URL;
export const OPEN_TIMEOUT = 60_000;

export interface TestDatabase {
  database: Database;
  close(): Promise<void>;
}

/** A fresh database: PGlite in memory, or a new PostgreSQL database dropped on close. */
export async function openTestDatabase(): Promise<TestDatabase> {
  if (!postgresUrl) {
    const database = await openDatabase({ mode: "pglite", onError: () => {} });
    return { database, close: () => database.close() };
  }
  const name = `jj_engine_${ulid().toLowerCase()}`;
  await admin((client) => client.query(`CREATE DATABASE "${name}"`));
  const url = new URL(postgresUrl);
  url.pathname = `/${name}`;
  const database = await openDatabase({
    mode: "postgres",
    connectionString: url.toString(),
    poolSize: 8,
    onError: () => {},
  });
  return {
    database,
    async close() {
      await database.close();
      await admin((client) =>
        client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
      );
    },
  };
}

async function admin(fn: (client: Client) => Promise<unknown>) {
  const client = new Client({ connectionString: postgresUrl });
  await client.connect();
  try {
    await fn(client);
  } finally {
    await client.end();
  }
}

export const quietLogger: Logger & { warnings: string[]; infos: string[] } = {
  warnings: [],
  infos: [],
  info(message) {
    quietLogger.infos.push(message);
  },
  warn(message) {
    quietLogger.warnings.push(message);
  },
  error(message, details) {
    quietLogger.warnings.push(`${message} ${JSON.stringify(details)}`);
  },
};

export interface TestEngine {
  engine: Engine;
  executor: FakeExecutor;
  chat: FakeChatResponder;
  drivers: DriverRegistry;
  workspaceRoot: string;
  /** Stops the worker and cancels whatever jobs it left, so suites sharing a database stay independent. */
  dispose(): Promise<void>;
}

export interface TestEngineOptions {
  config?: EngineConfigInput;
  executor?: FakeExecutor;
  chat?: FakeChatResponder;
  models?: FakeModels;
  /** Extra drivers next to `local`. */
  drivers?: DriverEntry[];
  /** Replace the whole registry. */
  registry?: DriverRegistry;
  workspaceRoot?: string;
  start?: boolean;
  /** The engine's clock (run starts, record timestamps); the database clock still drives leases. */
  clock?: () => Date;
}

export async function testEngine(
  database: Database,
  options: TestEngineOptions = {},
): Promise<TestEngine> {
  const workspaceRoot =
    options.workspaceRoot ?? (await mkdtemp(join(tmpdir(), "jj-engine-")));
  const drivers =
    options.registry ??
    createDriverRegistry([
      {
        driver: new LocalSandboxDriver({
          root: workspaceRoot,
          killGraceMs: 200,
        }),
        label: "Local (unisolated)",
      },
      ...(options.drivers ?? []),
    ]);
  const executor = options.executor ?? new FakeExecutor();
  const chat = options.chat ?? new FakeChatResponder();
  const engine = await createEngine({
    db: database,
    drivers,
    executor,
    chat,
    models: options.models ?? new FakeModels(),
    logger: quietLogger,
    clock: options.clock,
    config: {
      pollIntervalMs: 25,
      leaseMs: 5_000,
      streamPollMs: 200,
      ...options.config,
    },
  });
  if (options.start !== false) await engine.worker.start();
  return {
    engine,
    executor,
    chat,
    drivers,
    workspaceRoot,
    async dispose() {
      await engine.worker.abandon();
      await database.db
        .update(jobs)
        .set({ status: "cancelled", leaseUntil: null, updatedAt: sql`now()` })
        .where(inArray(jobs.status, ["queued", "running"]));
      if (!options.workspaceRoot)
        await rm(workspaceRoot, { recursive: true, force: true });
    },
  };
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls until `check` returns a truthy value. */
export async function until<T>(
  check: () =>
    | Promise<T | undefined | null | false>
    | T
    | undefined
    | null
    | false,
  options: { timeoutMs?: number; what?: string } = {},
): Promise<T> {
  const deadline = Date.now() + (options.timeoutMs ?? 15_000);
  let last: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    if (Date.now() > deadline)
      throw new Error(
        `Timed out waiting for ${options.what ?? "a condition"}${last ? `: ${String(last)}` : ""}`,
      );
    await sleep(20);
  }
}

/** Waits until the task view satisfies `check`, returning that view. */
export function untilTask(
  engine: Engine,
  taskId: string,
  check: (view: TaskView) => boolean,
  what = "the task",
  timeoutMs?: number,
): Promise<TaskView> {
  return until(
    async () => {
      const view = await engine.tasks.get(taskId);
      return check(view) ? view : undefined;
    },
    { what, timeoutMs },
  );
}

/** A unique bot name per test, so suites can share a database. */
export const uniqueName = (base: string) =>
  `${base}${ulid().slice(-6).toLowerCase()}`;

/** Wraps a driver to count sandboxes acquired and released. */
export function countingDriver<D extends import("../ports").EngineDriver>(
  inner: D,
) {
  const counts = { acquired: 0, released: 0 };
  const driver: import("../ports").EngineDriver = {
    id: inner.id,
    capabilities: inner.capabilities,
    validateSpec: (spec) => inner.validateSpec(spec),
    probe: () => inner.probe(),
    async acquire(request) {
      const sandbox = await inner.acquire(request);
      counts.acquired += 1;
      let released = false;
      return Object.assign(Object.create(sandbox) as typeof sandbox, {
        exec: sandbox.exec.bind(sandbox),
        release: async (options?: { persist?: boolean }) => {
          if (!released) counts.released += 1;
          released = true;
          await sandbox.release(options);
        },
        fs: sandbox.fs,
        id: sandbox.id,
        driverId: sandbox.driverId,
        workspaceDir: sandbox.workspaceDir,
      });
    },
  };
  return { driver, counts };
}
