// Shared by the @jj/db test files; not exported from the package.
import { Client } from "pg";
import { type Database, type Db, openDatabase } from "./database";
import { newId, ulid } from "./ids";
import { bots, sessions, tasks } from "./schema";

/**
 * For hooks and tests that open databases. Booting PGlite and migrating takes
 * seconds and over 10 s (vitest's default hook timeout) on a loaded machine.
 */
export const OPEN_TIMEOUT = 60_000;

/** Opt-in disposable PostgreSQL server; each suite creates and drops its own database on it. */
export const postgresUrl = process.env.JJ_TEST_DATABASE_URL;

export interface Target {
  name: "pglite" | "postgres";
  /** A brand-new, empty database (migrated by openDatabase). */
  fresh(): Promise<{
    url?: string;
    open(
      poolSize?: number,
      onError?: (error: unknown) => void,
    ): Promise<Database>;
  }>;
}

const cleanups: Array<() => Promise<void>> = [];

/** Run in afterAll: closes every database opened through a target and drops PostgreSQL test databases. */
export async function cleanup() {
  for (const step of cleanups.splice(0).reverse()) await step();
}

function track(database: Database) {
  cleanups.push(() => database.close());
  return database;
}

export const pgliteTarget: Target = {
  name: "pglite",
  async fresh() {
    return {
      open: async (_poolSize?: number, onError?: (error: unknown) => void) =>
        track(await openDatabase({ mode: "pglite", onError })),
    };
  },
};

export const postgresTarget: Target = {
  name: "postgres",
  async fresh() {
    if (!postgresUrl) throw new Error("JJ_TEST_DATABASE_URL is not set.");
    const name = `jj_test_${ulid().toLowerCase()}`;
    await admin((client) => client.query(`CREATE DATABASE "${name}"`));
    cleanups.push(() =>
      admin((client) =>
        client.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
      ),
    );
    const url = new URL(postgresUrl);
    url.pathname = `/${name}`;
    const connectionString = url.toString();
    return {
      url: connectionString,
      open: async (poolSize?: number, onError?: (error: unknown) => void) =>
        track(
          await openDatabase({
            mode: "postgres",
            connectionString,
            poolSize,
            onError,
          }),
        ),
    };
  },
};

/** PGlite always; PostgreSQL when JJ_TEST_DATABASE_URL is set. */
export const targets: Target[] = postgresUrl
  ? [pgliteTarget, postgresTarget]
  : [pgliteTarget];

async function admin(fn: (client: Client) => Promise<unknown>) {
  const client = new Client({ connectionString: postgresUrl });
  await client.connect();
  try {
    await fn(client);
  } finally {
    await client.end();
  }
}

export async function seedBot(db: Db, name = `Bot ${ulid()}`) {
  const [bot] = await db
    .insert(bots)
    .values({ id: newId("bot"), name })
    .returning();
  if (!bot) throw new Error("seed bot failed");
  return bot;
}

export async function seedTask(db: Db, coordinatorBotId?: string) {
  const botId = coordinatorBotId ?? (await seedBot(db)).id;
  const [task] = await db
    .insert(tasks)
    .values({
      id: newId("task"),
      title: "Test task",
      goal: "Test goal",
      coordinatorBotId: botId,
    })
    .returning();
  if (!task) throw new Error("seed task failed");
  return task;
}

export async function seedBots(db: Db, count: number) {
  return db
    .insert(bots)
    .values(
      Array.from({ length: count }, () => ({
        id: newId("bot"),
        name: `Bot ${ulid()}`,
      })),
    )
    .returning();
}

/** Sessions of one new task, all run by its coordinator bot. */
export async function seedSessions(db: Db, count: number) {
  const task = await seedTask(db);
  const rows = await db
    .insert(sessions)
    .values(
      Array.from({ length: count }, () => ({
        id: newId("session"),
        taskId: task.id,
        botId: task.coordinatorBotId,
        role: "worker" as const,
        brief: "Test brief",
        goalVersion: 1,
      })),
    )
    .returning();
  return { task, sessions: rows };
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Resolves to "settled" if the promise settles within `ms`, else "pending". */
export async function settlesWithin(promise: Promise<unknown>, ms: number) {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"pending">((resolve) => {
    timer = setTimeout(() => resolve("pending"), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => "settled" as const,
        () => "settled" as const,
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function waitFor(check: () => boolean, ms = 5_000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("Timed out waiting.");
    await sleep(10);
  }
}

/** A promise with its resolver, for holding a transaction open. */
export function gate() {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}
