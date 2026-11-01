import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, getTableName, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Database,
  migrationStatus,
  migrationsFolder,
  openDatabase,
} from "./database";
import { newId } from "./ids";
import {
  DatabaseInUseError,
  LOCK_FILE,
  NESTED_TRANSACTION_MESSAGE,
} from "./pglite";
import {
  artifacts,
  botMemory,
  bots,
  runtimeProfiles,
  sessions,
  tables,
  tasks,
} from "./schema";
import {
  cleanup,
  OPEN_TIMEOUT,
  pgliteTarget,
  postgresTarget,
  postgresUrl,
  seedBot,
  seedSessions,
  seedTask,
  settlesWithin,
  sleep,
  targets,
} from "./test-helpers";

/** The database error under drizzle's "Failed query" wrapper. */
function rootCause(error: unknown): { code?: string; message?: string } {
  let current = error as { cause?: unknown };
  while (current?.cause) current = current.cause as { cause?: unknown };
  return current as { code?: string; message?: string };
}

afterAll(cleanup, OPEN_TIMEOUT);

async function journalLength() {
  const journal = JSON.parse(
    await readFile(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as { entries: unknown[] };
  return journal.entries.length;
}

async function appliedMigrations(database: Database) {
  const result = (await database.db.execute(
    sql`select hash from drizzle.__drizzle_migrations`,
  )) as unknown as { rows: unknown[] };
  return result.rows.length;
}

async function publicTables(database: Database) {
  const result = (await database.db.execute(
    sql`select table_name from information_schema.tables where table_schema = 'public' order by table_name`,
  )) as unknown as { rows: Array<{ table_name: string }> };
  return result.rows.map((row) => row.table_name);
}

const expectedTables = Object.values(tables).map(getTableName).sort();

describe.each(targets)("openDatabase on $name", (target) => {
  let database: Database;
  beforeAll(async () => {
    database = await (await target.fresh()).open();
  }, OPEN_TIMEOUT);

  it("applies every migration to a fresh database", async () => {
    expect(expectedTables).toHaveLength(17);
    expect(await publicTables(database)).toEqual(expectedTables);
    expect(await appliedMigrations(database)).toBe(await journalLength());
  });

  it("reports the migration status as applied with none pending", async () => {
    const length = await journalLength();
    expect(await migrationStatus(database.db)).toEqual({
      expected: length,
      applied: length,
      pending: 0,
    });
  });

  it("maps timestamps, jsonb and bytea the same way on both drivers", async () => {
    const { db } = database;
    const task = await seedTask(db);
    expect(task.createdAt).toBeInstanceOf(Date);
    expect(task.eventSeq).toBe(0);
    expect(task.status).toBe("queued");
    const content = new Uint8Array([0, 1, 2, 254, 255]);
    const [stored] = await db
      .insert(artifacts)
      .values({
        id: newId("artifact"),
        taskId: task.id,
        kind: "file",
        path: "out/a.bin",
        name: "a.bin",
        contentType: "application/octet-stream",
        sizeBytes: content.byteLength,
        sha256: "0".repeat(64),
        content,
      })
      .returning();
    const [read] = await db
      .select()
      .from(artifacts)
      .where(eq(artifacts.id, stored?.id ?? ""));
    expect(read?.content).toBeInstanceOf(Uint8Array);
    expect([...(read?.content ?? [])]).toEqual([...content]);
    const [bot] = await db
      .update(bots)
      .set({ appearance: { shape: "round", nested: { a: [1, 2] } } })
      .where(eq(bots.id, task.coordinatorBotId))
      .returning();
    expect(bot?.appearance).toEqual({ shape: "round", nested: { a: [1, 2] } });
  });

  it("enforces the schema's integrity constraints", async () => {
    const { db } = database;
    const bot = await seedBot(db, "Researcher");
    // Names resolve case-insensitively, so they are unique that way per owner.
    await expect(seedBot(db, "researcher")).rejects.toThrow();
    // Statuses are constrained to the declared unions.
    await seedTask(db, bot.id);
    await expect(
      db
        .update(tasks)
        .set({ status: "paused" as never })
        .where(eq(tasks.coordinatorBotId, bot.id)),
    ).rejects.toThrow();
    // At most one default runtime profile.
    const profile = {
      sandbox: { driver: "local" },
      tools: ["bash"],
      budgets: {},
      isDefault: true,
    };
    await db
      .insert(runtimeProfiles)
      .values({ id: newId("runtimeProfile"), name: "A", ...profile });
    await expect(
      db
        .insert(runtimeProfiles)
        .values({ id: newId("runtimeProfile"), name: "B", ...profile }),
    ).rejects.toThrow();
    // Memory belongs to its bot and goes with it.
    await db.insert(botMemory).values({ botId: bot.id, text: "Prefers tabs." });
    const lonely = await seedBot(db);
    await db.insert(botMemory).values({ botId: lonely.id, text: "x" });
    await db.delete(bots).where(eq(bots.id, lonely.id));
    expect(
      await db.select().from(botMemory).where(eq(botMemory.botId, lonely.id)),
    ).toEqual([]);
    // A bot that coordinates a task cannot be deleted out from under it.
    await expect(db.delete(bots).where(eq(bots.id, bot.id))).rejects.toThrow();
    // Archiving frees the name for a new bot.
    await db
      .update(bots)
      .set({ archivedAt: new Date() })
      .where(eq(bots.id, bot.id));
    expect((await seedBot(db, "researcher")).name).toBe("researcher");
  });

  it("keeps waiting_for set exactly while a session waits", async () => {
    const { db } = database;
    const {
      sessions: [session],
    } = await seedSessions(db, 1);
    const id = session?.id ?? "";
    const set = (values: Partial<typeof sessions.$inferInsert>) =>
      db.update(sessions).set(values).where(eq(sessions.id, id));
    await expect(set({ status: "waiting" })).rejects.toThrow();
    await set({ status: "waiting", waitingFor: "delegations" });
    await expect(set({ status: "running" })).rejects.toThrow();
    await expect(set({ waitingFor: "nobody" as never })).rejects.toThrow();
    await set({ status: "running", waitingFor: null });
    const [row] = await db.select().from(sessions).where(eq(sessions.id, id));
    expect(row).toMatchObject({ status: "running", waitingFor: null });
  });

  it("refuses a missing PostgreSQL connection string", async () => {
    await expect(
      openDatabase({ mode: "postgres", connectionString: " " }),
    ).rejects.toThrow("connection string");
  });
});

describe("migrationStatus", () => {
  it("counts migrations newer than the last applied one as pending", async () => {
    const database = await openDatabase({ mode: "pglite" });
    try {
      await database.db.execute(sql`delete from drizzle.__drizzle_migrations`);
      const length = await journalLength();
      expect(await migrationStatus(database.db)).toEqual({
        expected: length,
        applied: 0,
        pending: length,
      });
    } finally {
      await database.close();
    }
  });
});

describe("PGlite data directory", () => {
  it(
    "is locked to one process at a time and released on close",
    async () => {
      const path = await mkdtemp(join(tmpdir(), "jj-db-"));
      try {
        const first = await openDatabase({ mode: "pglite", path });
        const second = openDatabase({ mode: "pglite", path });
        await expect(second).rejects.toBeInstanceOf(DatabaseInUseError);
        await expect(second).rejects.toThrow(
          `in use by pid ${process.pid}. PGlite supports one process; use PostgreSQL for a separate worker.`,
        );
        // The refused open left the owner's lock alone.
        expect(await readFile(join(path, LOCK_FILE), "utf8")).toMatch(
          new RegExp(`^${process.pid}\n`),
        );
        await first.close();
        await expect(readFile(join(path, LOCK_FILE))).rejects.toThrow();
        const third = await openDatabase({ mode: "pglite", path });
        await third.close();
      } finally {
        await rm(path, { recursive: true, force: true });
      }
    },
    OPEN_TIMEOUT,
  );

  it(
    "takes over a lock left by a process that is gone",
    async () => {
      const path = await mkdtemp(join(tmpdir(), "jj-db-"));
      try {
        const gone = spawnSync(process.execPath, ["-e", ""]).pid;
        await writeFile(join(path, LOCK_FILE), `${gone}\nstale\n`);
        const database = await openDatabase({ mode: "pglite", path });
        expect(await readFile(join(path, LOCK_FILE), "utf8")).toMatch(
          new RegExp(`^${process.pid}\n`),
        );
        await database.close();
        await expect(readFile(join(path, LOCK_FILE))).rejects.toThrow();
      } finally {
        await rm(path, { recursive: true, force: true });
      }
    },
    OPEN_TIMEOUT,
  );

  it(
    "keeps data and re-runs no migration when reopened",
    async () => {
      const path = await mkdtemp(join(tmpdir(), "jj-db-"));
      try {
        const first = await openDatabase({ mode: "pglite", path });
        const bot = await seedBot(first.db, "Persistent");
        await first.close();
        await first.close(); // idempotent
        const second = await openDatabase({ mode: "pglite", path });
        try {
          expect(await appliedMigrations(second)).toBe(await journalLength());
          const [found] = await second.db
            .select()
            .from(bots)
            .where(eq(bots.id, bot.id));
          expect(found?.name).toBe("Persistent");
        } finally {
          await second.close();
        }
      } finally {
        await rm(path, { recursive: true, force: true });
      }
    },
    OPEN_TIMEOUT,
  );
});

describe.skipIf(!postgresUrl)("PostgreSQL migrations", () => {
  it(
    "is idempotent on reopen and safe when several processes open a fresh database at once",
    async () => {
      const fresh = await postgresTarget.fresh();
      // Four pools racing on an empty database: without the advisory lock the
      // migrator's CREATE SCHEMA/TABLE and journal check race and fail or double-apply.
      const opened = await Promise.all(
        Array.from({ length: 4 }, () => fresh.open(2)),
      );
      for (const database of opened)
        expect(await appliedMigrations(database)).toBe(await journalLength());
      expect(await publicTables(opened[0] as Database)).toEqual(expectedTables);
      const bot = await seedBot((opened[0] as Database).db, "Survivor");
      const reopened = await fresh.open(2);
      expect(await appliedMigrations(reopened)).toBe(await journalLength());
      const [found] = await reopened.db
        .select()
        .from(bots)
        .where(eq(bots.id, bot.id));
      expect(found?.name).toBe("Survivor");
    },
    OPEN_TIMEOUT,
  );
});

describe("PGlite nested calls", () => {
  let database: Database;
  beforeAll(async () => {
    database = await (await pgliteTarget.fresh()).open();
  }, OPEN_TIMEOUT);

  it("refuses the top-level database inside a transaction instead of hanging", async () => {
    const { db, bus } = database;
    const nested = db.transaction(async () => {
      await db.select().from(bots);
    });
    expect(await settlesWithin(nested, 2_000)).toBe("settled");
    await expect(nested).rejects.toThrow(NESTED_TRANSACTION_MESSAGE);
    await expect(
      db.transaction(() => db.transaction(async () => {})),
    ).rejects.toThrow(NESTED_TRANSACTION_MESSAGE);
    await expect(
      db.transaction(() => bus.subscribe("jj_hint", () => {})),
    ).rejects.toThrow(NESTED_TRANSACTION_MESSAGE);
    // The transaction handle, savepoints and later top-level calls still work.
    const bot = await db.transaction(async (tx) => {
      await tx.transaction(async (savepoint) => {
        await savepoint.select().from(bots);
      });
      const [row] = await tx
        .insert(bots)
        .values({ id: newId("bot"), name: "Nested" })
        .returning();
      return row;
    });
    const [found] = await db
      .select()
      .from(bots)
      .where(eq(bots.id, bot?.id ?? ""));
    expect(found?.name).toBe("Nested");
  });
});

describe.skipIf(!postgresUrl)("PostgreSQL session timeouts", () => {
  let database: Database;
  const errors: unknown[] = [];
  beforeAll(async () => {
    const fresh = await postgresTarget.fresh();
    database = await openDatabase({
      mode: "postgres",
      connectionString: fresh.url ?? "",
      lockTimeoutMs: 300,
      idleInTransactionTimeoutMs: 500,
      onError: (error) => errors.push(error),
    });
  }, OPEN_TIMEOUT);
  afterAll(() => database.close(), OPEN_TIMEOUT);

  it("fails a top-level call that waits on its own transaction's lock instead of hanging", async () => {
    const { db } = database;
    const task = await seedTask(db);
    const nested = db.transaction(async (tx) => {
      await tx
        .update(tasks)
        .set({ title: "held" })
        .where(eq(tasks.id, task.id));
      // A second connection: it waits for the row this transaction holds.
      await db
        .update(tasks)
        .set({ title: "nested" })
        .where(eq(tasks.id, task.id));
    });
    expect(await settlesWithin(nested, 3_000)).toBe("settled");
    const error = await nested.catch((caught: unknown) => caught);
    expect(rootCause(error).code).toBe("55P03"); // lock_not_available
    const [row] = await db.select().from(tasks).where(eq(tasks.id, task.id));
    expect(row?.title).toBe("Test task");
  });

  it("ends a transaction left idle, reports it, and keeps the pool usable", async () => {
    const { db } = database;
    const abandoned = db.transaction(async (tx) => {
      await tx.execute(sql`select 1`);
      await sleep(1_200);
      await tx.execute(sql`select 1`);
    });
    await expect(abandoned).rejects.toThrow();
    expect(errors.map((error) => rootCause(error).code)).toContain("25P03"); // idle_in_transaction_session_timeout
    const result = (await db.execute(sql`select 2 as two`)) as unknown as {
      rows: Array<{ two: number }>;
    };
    expect(result.rows).toEqual([{ two: 2 }]);
  });
});
