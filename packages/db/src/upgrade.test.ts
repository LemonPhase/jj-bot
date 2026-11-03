// Safe upgrades: the database the previous release left behind opens on this
// build through the boot path (openDatabase), keeps every record and ends at
// the current schema; a database a newer version migrated is refused before
// anything is applied.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { eq, getTableName, sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "./database";
import { appendEvent } from "./events";
import {
  migrationStatus,
  migrationsFolder,
  readSchemaLevel,
  type SchemaLevel,
  SchemaTooNewError,
  shippedMigrations,
} from "./migrations";
import { conversationMessages, tables, tasks, usage } from "./schema";
import { cleanup, OPEN_TIMEOUT, type Target, targets } from "./test-helpers";
import {
  type DatabaseLocation,
  PREVIOUS_RELEASE,
  seedPreviousRelease,
} from "./testing";

afterAll(cleanup, OPEN_TIMEOUT);
const directories: string[] = [];
afterAll(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

type Query = <T>(text: string) => Promise<T[]>;

/** A new, empty database on the target, its boot-path opener and raw queries outside it. */
async function emptyDatabase(target: Target): Promise<{
  location: DatabaseLocation;
  open(): Promise<Database>;
  query: Query;
  /** The schema level, read outside the boot path. */
  level(): Promise<SchemaLevel>;
}> {
  if (target.name === "pglite") {
    const path = await mkdtemp(join(tmpdir(), "jj-upgrade-"));
    directories.push(path);
    return {
      location: { mode: "pglite", path },
      open: () => openDatabase({ mode: "pglite", path }),
      async query<T>(text: string) {
        const client = await PGlite.create(path);
        try {
          return (await client.query<T>(text)).rows;
        } finally {
          await client.close();
        }
      },
      async level() {
        const client = await PGlite.create(path);
        try {
          return await readSchemaLevel(drizzlePglite(client));
        } finally {
          await client.close();
        }
      },
    };
  }
  const fresh = await target.fresh();
  const connectionString = fresh.url as string;
  return {
    location: { mode: "postgres", connectionString },
    open: () => fresh.open(),
    async query<T>(text: string) {
      const client = new Client({ connectionString });
      await client.connect();
      try {
        return (await client.query(text)).rows as T[];
      } finally {
        await client.end();
      }
    },
    async level() {
      const client = new Client({ connectionString });
      await client.connect();
      try {
        return await readSchemaLevel(drizzleNodePg(client));
      } finally {
        await client.end();
      }
    },
  };
}

const queryOf =
  (database: Database): Query =>
  async <T>(text: string) =>
    ((await database.db.execute(sql.raw(text))) as unknown as { rows: T[] })
      .rows;

type Row = Record<string, unknown>;

/** Every row of every public table, as JSON (driver-independent), sorted. */
async function snapshot(query: Query): Promise<Record<string, Row[]>> {
  const names = await query<{ table_name: string }>(
    "select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name",
  );
  const result: Record<string, Row[]> = {};
  for (const { table_name: name } of names)
    result[name] = (
      await query<{ row: string }>(
        `select to_jsonb(t)::text as row from public."${name}" t`,
      )
    )
      .map((entry) => JSON.parse(entry.row) as Row)
      .sort(byJson);
  return result;
}

const byJson = (a: Row, b: Row) => {
  const [x, y] = [JSON.stringify(a), JSON.stringify(b)];
  return x < y ? -1 : x > y ? 1 : 0;
};

/** The rows with only the given columns: what an older schema had. */
const project = (rows: Row[], columns: string[]) =>
  rows
    .map((row) => Object.fromEntries(columns.map((key) => [key, row[key]])))
    .sort(byJson);

/** Columns, constraints and indexes of the public schema. */
async function schemaOf(query: Query) {
  return {
    columns: await query(
      "select table_name, column_name, data_type, is_nullable, column_default from information_schema.columns where table_schema = 'public' order by table_name, column_name",
    ),
    constraints: await query(
      "select conrelid::regclass::text as table_name, conname, pg_get_constraintdef(oid) as definition from pg_constraint where connamespace = 'public'::regnamespace order by 1, 2",
    ),
    indexes: await query(
      "select indexname, indexdef from pg_indexes where schemaname = 'public' order by indexname",
    ),
  };
}

/**
 * The SHA-256 of each migration the previous release shipped, as its
 * databases record them. A migration applied in the field never changes:
 * the migrator would not apply the edit to those databases.
 */
const RELEASED_MIGRATIONS: Record<string, string> = {
  "0000_init":
    "345b9c16f2d2d2a7d836252aac06476da02f2f073a7a29cc474aec60f500bc46",
  "0001_chat_idempotency":
    "05fdd4dbc59e77f601b893682775b5c31e6307e58dd6d9f3003ae192c95746be",
  "0002_sandbox_holder":
    "cc4dfa791caf2a9a7002590b0efdc4377eac924f14c7768ebf1e1998fb626666",
  "0003_instance_settings":
    "72d7ffb5fb4507bfa6a3850e98ebdabbf065dcd2431ee03a963622a6c8ff82ba",
  "0004_run_snapshots":
    "cbb5c45a5cc45446464791067722f06fcd1028258029d72bb910ce911061c166",
};

describe("released migrations", () => {
  it(`are unchanged since ${PREVIOUS_RELEASE.name} shipped them, and only appended to`, () => {
    const shipped = shippedMigrations();
    const released = shipped.slice(
      0,
      shipped.findIndex((entry) => entry.tag === PREVIOUS_RELEASE.migration) +
        1,
    );
    expect(released.map((entry) => entry.tag)).toEqual(
      Object.keys(RELEASED_MIGRATIONS),
    );
    const hashes = readMigrationFiles({ migrationsFolder }).map(
      (file) => file.hash,
    );
    expect(
      Object.fromEntries(
        released.map((entry, index) => [entry.tag, hashes[index]]),
      ),
    ).toEqual(RELEASED_MIGRATIONS);
    // Journal timestamps only grow: the newer-schema check relies on it.
    for (const [index, entry] of shipped.entries())
      if (index > 0)
        expect(entry.when).toBeGreaterThan(shipped[index - 1]?.when ?? 0);
  });
});

describe.each(targets)("upgrades on $name", (target) => {
  describe(`from the ${PREVIOUS_RELEASE.name} database`, () => {
    let before: Record<string, Row[]>;
    let database: Database;
    let fresh: Database;
    beforeAll(async () => {
      const place = await emptyDatabase(target);
      await seedPreviousRelease(place.location);
      before = await snapshot(place.query);
      // The boot path: the newer-schema guard, then every migration since.
      database = await place.open();
    }, OPEN_TIMEOUT);
    beforeAll(async () => {
      fresh = await (await target.fresh()).open();
    }, OPEN_TIMEOUT);
    afterAll(async () => {
      await database?.close();
      await fresh?.close();
    }, OPEN_TIMEOUT);

    it("is representative: every table of that schema holds rows", () => {
      // But the instance settings: that build ran on loopback, without a token.
      expect(
        Object.entries(before)
          .filter(([, rows]) => rows.length === 0)
          .map(([name]) => name),
      ).toEqual(["instance_settings"]);
    });

    it("applies every migration since, and none is left pending", async () => {
      const shipped = shippedMigrations().length;
      expect(await migrationStatus(database.db)).toEqual({
        expected: shipped,
        applied: shipped,
        pending: 0,
      });
    });

    it("keeps every value of every record; migrations only add", async () => {
      const after = await snapshot(queryOf(database));
      for (const [name, rows] of Object.entries(before)) {
        const columns = Object.keys(rows[0] ?? {});
        expect(project(after[name] ?? [], columns), name).toEqual(rows);
      }
    });

    it("reads every table through the current schema, old rows included", async () => {
      for (const table of Object.values(tables)) {
        const name = getTableName(table);
        const rows = await database.db.select().from(table);
        expect(rows.length, name).toBe(before[name]?.length ?? 0);
      }
    });

    it("backfills what the migrations since add", async () => {
      // The default spend cap, the scripted model's unpriced calls, and every
      // chat message already answered.
      const capped = await database.db.select().from(tasks);
      expect(capped.map((task) => task.spendCapUsd)).toEqual(
        capped.map(() => 5),
      );
      const calls = await database.db.select().from(usage);
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every((call) => !call.priced)).toBe(true);
      const waiting = await database.db
        .select()
        .from(conversationMessages)
        .where(sql`${conversationMessages.handledAt} is null`);
      expect(waiting.filter((message) => message.role === "user")).toEqual([]);
    });

    it("carries on writing from the old counters", async () => {
      const [task] = await database.db.select().from(tasks).limit(1);
      if (!task) throw new Error("no task in the fixture");
      const event = await database.db.transaction((tx) =>
        appendEvent(tx, { taskId: task.id, type: "task.updated", payload: {} }),
      );
      expect(event.sequence).toBe(task.eventSeq + 1);
      const [bumped] = await database.db
        .select({ eventSeq: tasks.eventSeq })
        .from(tasks)
        .where(eq(tasks.id, task.id));
      expect(bumped?.eventSeq).toBe(task.eventSeq + 1);
    });

    it("ends at the schema a new install gets", async () => {
      expect(await schemaOf(queryOf(database))).toEqual(
        await schemaOf(queryOf(fresh)),
      );
    });
  });

  it(
    "refuses a database a newer version migrated, before applying anything",
    async () => {
      const place = await emptyDatabase(target);
      const shipped = shippedMigrations();
      const newest = shipped.at(-1);
      if (!newest) throw new Error("no migrations");
      const first = await place.open();
      expect(await readSchemaLevel(first.db)).toMatchObject({
        recorded: true,
        applied: shipped.length,
        latest: newest.tag,
        pending: 0,
        newer: 0,
      });
      // A migration from a later build, on top of this build's newest.
      const later = newest.when + 86_400_000;
      await first.db.execute(
        sql`insert into drizzle.__drizzle_migrations (hash, created_at) values ('from-a-newer-version', ${later})`,
      );
      const level = await readSchemaLevel(first.db);
      expect(level).toMatchObject({
        applied: shipped.length + 1,
        latestAt: new Date(later),
        shippedLatest: newest.tag,
        pending: 0,
        newer: 1,
      });
      expect(level.latest).toBeUndefined();
      await first.close();

      const refused = place.open();
      await expect(refused).rejects.toBeInstanceOf(SchemaTooNewError);
      await expect(refused).rejects.toThrow(
        `This database was written by a newer version of JJ Bot: it records ${shipped.length + 1} migrations, 1 of them newer than ${newest.tag}, the newest this version knows`,
      );
      await expect(refused).rejects.toThrow(
        "Migrations are forward-only, so this version cannot use it and refuses to start.",
      );
      // Nothing was applied or removed, and the refusal let go of the
      // database (the PGlite lock, the PostgreSQL advisory lock).
      expect(
        await place.query<{ hash: string }>(
          "select hash from drizzle.__drizzle_migrations order by created_at desc limit 1",
        ),
      ).toEqual([{ hash: "from-a-newer-version" }]);
      await place.query(
        "delete from drizzle.__drizzle_migrations where hash = 'from-a-newer-version'",
      );
      const reopened = await place.open();
      try {
        expect((await migrationStatus(reopened.db)).pending).toBe(0);
      } finally {
        await reopened.close();
      }
    },
    OPEN_TIMEOUT,
  );

  it(
    "reads an empty database as unrecorded, with every migration pending",
    async () => {
      const place = await emptyDatabase(target);
      expect(await place.level()).toMatchObject({
        recorded: false,
        applied: 0,
        pending: shippedMigrations().length,
        newer: 0,
      });
    },
    OPEN_TIMEOUT,
  );
});
