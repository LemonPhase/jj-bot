// Data migrations, checked on rows written under the schema before them.
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { type SQL, sql } from "drizzle-orm";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { migrationsFolder } from "./database";
import { cleanup, OPEN_TIMEOUT, targets } from "./test-helpers";

afterAll(cleanup, OPEN_TIMEOUT);

interface Journal {
  entries: { tag: string }[];
}

/** A migrations folder holding only the migrations before `tag`. */
async function migrationsBefore(tag: string): Promise<string> {
  const journal = JSON.parse(
    await readFile(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as Journal;
  const index = journal.entries.findIndex((entry) => entry.tag === tag);
  if (index < 1) throw new Error(`No migration before ${tag}.`);
  const folder = await mkdtemp(join(tmpdir(), "jj-migrations-"));
  await mkdir(join(folder, "meta"));
  const entries = journal.entries.slice(0, index);
  await writeFile(
    join(folder, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries }),
  );
  for (const entry of entries)
    await copyFile(
      join(migrationsFolder, `${entry.tag}.sql`),
      join(folder, `${entry.tag}.sql`),
    );
  return folder;
}

interface Upgrade {
  execute(query: SQL): Promise<{ rows: unknown[] }>;
  /** Applies every migration in the real folder (the rest of them). */
  upgrade(): Promise<void>;
  close(): Promise<void>;
}

/** A database at the schema before `tag`, on the target's driver. */
async function databaseBefore(
  target: (typeof targets)[number],
  tag: string,
): Promise<Upgrade> {
  const folder = await migrationsBefore(tag);
  try {
    if (target.name === "pglite") {
      const client = await PGlite.create();
      const db = drizzlePglite(client);
      await migratePglite(db, { migrationsFolder: folder });
      return {
        execute: (query) => db.execute(query),
        upgrade: () => migratePglite(db, { migrationsFolder }),
        close: () => client.close(),
      };
    }
    const { url } = await target.fresh();
    const client = new Client({ connectionString: url });
    await client.connect();
    const db = drizzleNodePg(client);
    await migrateNodePg(db, { migrationsFolder: folder });
    return {
      execute: (query) => db.execute(query),
      upgrade: () => migrateNodePg(db, { migrationsFolder }),
      close: () => client.end(),
    };
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

const STOPPED =
  "The worker stopped; the session resumes from its last completed turn.";
const RESTARTED =
  "Interrupted by a worker restart; the session resumes from its last completed turn.";
const LAUNCH_GUARD =
  "Interrupted: the worker stopped and the task was stopped meanwhile.";
const EXHAUSTED =
  "The session was interrupted too many times (its worker kept stopping) and was given up.";

describe.each(targets)("migrations on $name", (target) => {
  it(
    "0004 marks pending only the runs another actor closed or left running",
    async () => {
      const database = await databaseBefore(target, "0004_run_snapshots");
      try {
        await database.execute(sql`
          insert into bots (id, name) values ('bot_1', 'Ada');
        `);
        await database.execute(sql`
          insert into tasks (id, title, goal, coordinator_bot_id)
          values ('task_1', 'Task', 'Goal', 'bot_1');
        `);
        await database.execute(sql`
          insert into sessions (id, task_id, bot_id, role, brief, goal_version)
          values ('sess_1', 'task_1', 'bot_1', 'coordinator', 'Brief', 1);
        `);
        const rows: [string, string, string | null][] = [
          ["waiting", "start", null],
          ["completed", "wake", null],
          ["failed", "wake", "model error: boom"],
          ["cancelled", "wake", null],
          ["cancelled", "recovery", STOPPED],
          ["failed", "recovery", RESTARTED],
          ["cancelled", "recovery", LAUNCH_GUARD],
          ["failed", "recovery", EXHAUSTED],
          ["running", "recovery", null],
        ];
        for (const [index, [status, reason, error]] of rows.entries())
          await database.execute(sql`
            insert into runs (id, session_id, task_id, number, reason, status, error, finished_at)
            values (${`run_${index + 1}`}, 'sess_1', 'task_1', ${index + 1}, ${reason}, ${status}, ${error},
              ${status === "running" ? null : sql`now()`})
          `);

        await database.upgrade();

        const result = await database.execute(
          sql`select id, snapshot_pending from runs order by number`,
        );
        expect(
          (result.rows as { id: string; snapshot_pending: boolean }[]).map(
            (row) => [row.id, row.snapshot_pending],
          ),
        ).toEqual([
          ["run_1", false],
          ["run_2", false],
          ["run_3", false],
          ["run_4", false],
          ["run_5", true],
          ["run_6", true],
          ["run_7", true],
          ["run_8", true],
          ["run_9", true],
        ]);
      } finally {
        await database.close();
      }
    },
    OPEN_TIMEOUT,
  );
});
