// Data migrations, checked on rows written under the schema before them.
import { rm } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { type SQL, sql } from "drizzle-orm";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { migrationsFolder, shippedMigrations } from "./migrations";
import { cleanup, OPEN_TIMEOUT, targets } from "./test-helpers";
import { migrationsThrough } from "./testing";

afterAll(cleanup, OPEN_TIMEOUT);

/** A migrations folder holding only the migrations before `tag`. */
function migrationsBefore(tag: string): Promise<string> {
  const shipped = shippedMigrations();
  const index = shipped.findIndex((entry) => entry.tag === tag);
  const previous = shipped[index - 1];
  if (index < 1 || !previous) throw new Error(`No migration before ${tag}.`);
  return migrationsThrough(previous.tag);
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

  it(
    "0005 leaves waiting only the user messages a pending reply will answer",
    async () => {
      const database = await databaseBefore(target, "0005_chat_task_updates");
      try {
        await database.execute(sql`
          insert into bots (id, name) values ('bot_1', 'Ada'), ('bot_2', 'Bob'), ('bot_3', 'Cy');
        `);
        // Ada: answered, then a failed reply (nothing pending). Bob: a reply is queued.
        // Cy: answered, then a message whose reply is running.
        const messages: [string, string, number, string][] = [
          ["cmsg_1", "bot_1", 1, "user"],
          ["cmsg_2", "bot_1", 2, "assistant"],
          ["cmsg_3", "bot_1", 3, "user"],
          ["cmsg_4", "bot_2", 1, "user"],
          ["cmsg_5", "bot_3", 1, "user"],
          ["cmsg_6", "bot_3", 2, "assistant"],
          ["cmsg_7", "bot_3", 3, "user"],
        ];
        for (const [id, bot, sequence, role] of messages)
          await database.execute(sql`
            insert into conversation_messages (id, bot_id, sequence, role, text)
            values (${id}, ${bot}, ${sequence}, ${role}, 'text')
          `);
        await database.execute(sql`
          insert into jobs (id, kind, bot_id, status, lease_owner, lease_until)
          values ('job_1', 'chat.reply', 'bot_1', 'failed', null, null),
                 ('job_2', 'chat.reply', 'bot_2', 'queued', null, null),
                 ('job_3', 'chat.reply', 'bot_3', 'running', 'w', now())
        `);

        await database.upgrade();

        const result = await database.execute(
          sql`select id from conversation_messages where role = 'user' and handled_at is null order by id`,
        );
        expect((result.rows as { id: string }[]).map((row) => row.id)).toEqual([
          "cmsg_4",
          "cmsg_7",
        ]);
        // The conversation view finds a reply by what it was answering.
        const indexes = await database.execute(
          sql`select indexdef from pg_indexes where indexname = 'jobs_chat_reply_answering_idx'`,
        );
        expect((indexes.rows as { indexdef: string }[])[0]?.indexdef).toContain(
          "'answering'",
        );
      } finally {
        await database.close();
      }
    },
    OPEN_TIMEOUT,
  );

  it(
    "0006 caps existing tasks at the default and marks past calls at no cost unpriced",
    async () => {
      const database = await databaseBefore(target, "0006_spend_caps");
      try {
        await database.execute(sql`
          insert into bots (id, name) values ('bot_1', 'Ada');
        `);
        await database.execute(sql`
          insert into tasks (id, title, goal, coordinator_bot_id, status)
          values ('task_1', 'Open', 'Goal', 'bot_1', 'waiting'),
            ('task_2', 'Done', 'Goal', 'bot_1', 'completed');
        `);
        await database.execute(sql`
          insert into usage (id, task_id, bot_id, model, input_tokens, cost_usd)
          values ('use_1', 'task_1', 'bot_1', 'openai/gpt', 100, 0.25),
            ('use_2', 'task_1', 'bot_1', 'free/model', 100, 0),
            ('use_3', null, 'bot_1', 'openai/gpt', 0, 0);
        `);

        await database.upgrade();

        const tasks = await database.execute(
          sql`select id, spend_cap_usd from tasks order by id`,
        );
        expect(tasks.rows).toEqual([
          { id: "task_1", spend_cap_usd: 5 },
          { id: "task_2", spend_cap_usd: 5 },
        ]);
        // Priced: a cost was recorded, or no tokens were used at all.
        const usage = await database.execute(
          sql`select id, priced from usage order by id`,
        );
        expect(usage.rows).toEqual([
          { id: "use_1", priced: true },
          { id: "use_2", priced: false },
          { id: "use_3", priced: true },
        ]);
      } finally {
        await database.close();
      }
    },
    OPEN_TIMEOUT,
  );
});
