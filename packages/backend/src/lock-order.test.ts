// The engine's lock order on PostgreSQL: runtime profiles (by id), then
// secrets. Each case lines two writers up behind a third connection that
// holds a secret's row, so the interleaving that would deadlock under any
// other order happens every time, then lets them go: both must finish, and
// none may fail with a deadlock (40P01). PGlite runs one transaction at a
// time, so these run on PostgreSQL only (JJ_TEST_DATABASE_URL).
import { randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createKeyring } from "./secrets/keyring";
import { SecretStore } from "./secrets/store";
import {
  OPEN_TIMEOUT,
  openTestDatabase,
  postgresUrl,
  type TestDatabase,
  type TestEngine,
  testEngine,
  until,
} from "./testing/harness";

let db: TestDatabase;
let current: TestEngine | undefined;
let holder: Client | undefined;

beforeAll(async () => {
  if (postgresUrl) db = await openTestDatabase();
}, OPEN_TIMEOUT);
afterEach(async () => {
  await holder?.query("rollback").catch(() => {});
  await holder?.end().catch(() => {});
  holder = undefined;
  await current?.dispose();
  current = undefined;
});
afterAll(async () => {
  await db?.close();
});

/** A connection of its own to the suite's database. */
async function connect(): Promise<Client> {
  const rows = (await db.database.db.execute(
    sql`select current_database() as name`,
  )) as unknown as { rows: { name: string }[] };
  const url = new URL(postgresUrl as string);
  url.pathname = `/${(rows.rows[0] as { name: string }).name}`;
  const client = new Client({ connectionString: url.toString() });
  await client.connect();
  return client;
}

/** Backends of this database waiting for a lock. */
async function waiting(): Promise<number> {
  const rows = (await db.database.db.execute(
    sql`select count(*)::int as n from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'`,
  )) as unknown as { rows: { n: number }[] };
  return (rows.rows[0] as { n: number }).n;
}

const deadlocked = (error: unknown): boolean => {
  for (
    let cause = error as { code?: unknown; cause?: unknown } | undefined,
      depth = 0;
    cause && depth < 6;
    cause = cause.cause as typeof cause, depth++
  )
    if (cause.code === "40P01") return true;
  return /deadlock/i.test(String(error));
};

async function setup() {
  current = await testEngine(db.database, {
    secretStore: new SecretStore({
      db: db.database.db,
      keyring: createKeyring(randomBytes(32)),
    }),
  });
  const { engine } = current;
  for (const name of ["LOCK_ONE", "LOCK_TWO"])
    await engine.secrets.put(name, {
      value: `${name.toLowerCase()}-${randomBytes(12).toString("hex")}`,
    });
  const [seeded] = (await engine.profiles.list()).profiles.filter(
    (profile) => profile.isDefault,
  );
  if (!seeded) throw new Error("no default profile");
  return { engine, defaultId: seeded.id };
}

/** Holds the secret's row on a third connection until `release`. */
async function hold(secret: string) {
  holder = await connect();
  await holder.query("begin");
  await holder.query("select 1 from secrets where name = $1 for update", [
    secret,
  ]);
  const client = holder;
  return async () => {
    await client.query("commit");
  };
}

describe.skipIf(!postgresUrl)("lock order: profiles, then secrets", () => {
  it(
    "a save that makes a profile the default and a secret's removal both finish",
    async () => {
      const { engine, defaultId } = await setup();
      const { profile } = await engine.profiles.create({
        name: "Lock order",
        sandbox: { driver: "local", network: { mode: "open" } },
      });
      expect(profile.id > defaultId).toBe(true);
      const release = await hold("LOCK_ONE");
      const before = await waiting();
      // Holds its profile, then waits for LOCK_ONE's row to grant it.
      const save = engine.profiles.update(profile.id, {
        isDefault: true,
        secrets: ["LOCK_ONE"],
      });
      await until(async () => (await waiting()) > before);
      // Takes every profile, the default first, and waits for the saved one.
      const removal = engine.secrets.delete("LOCK_TWO");
      await until(async () => (await waiting()) > before + 1);
      await release();
      const settled = await Promise.allSettled([save, removal]);
      for (const result of settled)
        if (result.status === "rejected")
          expect(deadlocked(result.reason), String(result.reason)).toBe(false);
      expect(settled.map((result) => result.status)).toEqual([
        "fulfilled",
        "fulfilled",
      ]);
      const { profile: saved } = await engine.profiles.get(profile.id);
      expect(saved).toMatchObject({ isDefault: true, secrets: ["LOCK_ONE"] });
    },
    OPEN_TIMEOUT,
  );

  it(
    "a new default profile granting a secret and that secret's removal both finish",
    async () => {
      const { engine } = await setup();
      const release = await hold("LOCK_ONE");
      const before = await waiting();
      const create = engine.profiles.create({
        name: "New default",
        sandbox: { driver: "local", network: { mode: "open" } },
        secrets: ["LOCK_ONE"],
        isDefault: true,
      });
      await until(async () => (await waiting()) > before);
      const removal = engine.secrets.delete("LOCK_ONE");
      await until(async () => (await waiting()) > before + 1);
      await release();
      const settled = await Promise.allSettled([create, removal]);
      for (const result of settled)
        if (result.status === "rejected")
          expect(deadlocked(result.reason), String(result.reason)).toBe(false);
      // The removal ran last: it took the new profile's grant with it.
      expect(settled.map((result) => result.status)).toEqual([
        "fulfilled",
        "fulfilled",
      ]);
      const created = (await engine.profiles.list()).profiles.find(
        (profile) => profile.name === "New default",
      );
      expect(created).toMatchObject({ isDefault: true, secrets: [] });
    },
    OPEN_TIMEOUT,
  );
});
