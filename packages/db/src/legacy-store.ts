/**
 * Legacy JSONB record store used by the current backend. Superseded by
 * `openDatabase` (see README) and deleted once the engine rewrite lands.
 */
import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import type { TaskEvent } from "@jj/contracts";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

/** Legacy direct Drizzle factory; callers own shutdown. */
export function createDatabase(connectionString: string) {
  if (!connectionString.trim())
    throw new Error("DATABASE_URL is required for persistence.");
  const pool = new Pool({ connectionString });
  return { db: drizzle(pool), close: () => pool.end() };
}

export interface StoreTx {
  get<T>(collection: string, id: string): Promise<T | undefined>;
  list<T>(collection: string): Promise<T[]>;
  put(collection: string, id: string, value: unknown): Promise<void>;
  delete(collection: string, id: string): Promise<void>;
  appendEvent(
    input: Omit<TaskEvent, "id" | "sequence" | "occurredAt">,
  ): Promise<TaskEvent>;
  events(taskId: string, after?: number): Promise<TaskEvent[]>;
}

export interface BackendStore {
  transaction<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>;
  read<T>(fn: (tx: StoreTx) => Promise<T>): Promise<T>;
  events(taskId: string, after?: number): Promise<TaskEvent[]>;
  close(): Promise<void>;
}

export interface StoreConfig {
  mode: "pglite" | "postgres";
  path?: string;
  connectionString?: string;
}

type Row = Record<string, unknown>;
type Query = <T extends Row>(
  sql: string,
  params?: unknown[],
) => Promise<{ rows: T[] }>;

/** Idempotent v1 migration shared by PostgreSQL and embedded PGlite. */
export const migrationSql = `
  CREATE TABLE IF NOT EXISTS jj_records (
    collection TEXT NOT NULL,
    id TEXT NOT NULL,
    value JSONB NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (collection, id)
  );
  CREATE TABLE IF NOT EXISTS jj_events (
    task_id TEXT NOT NULL,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    value JSONB NOT NULL,
    PRIMARY KEY (task_id, sequence)
  );
  CREATE TABLE IF NOT EXISTS jj_write_lock (id INTEGER PRIMARY KEY CHECK (id = 1));
  INSERT INTO jj_write_lock (id) VALUES (1) ON CONFLICT DO NOTHING;
`;

function makeTx(query: Query, readOnly: boolean) {
  let active = true;
  function check(write = false) {
    if (!active) throw new Error("The storage transaction has finished.");
    if (write && readOnly)
      throw new Error("Cannot write through a read-only storage transaction.");
  }
  const tx: StoreTx = {
    async get<T>(collection: string, id: string) {
      check();
      const result = await query<{ value: T }>(
        "SELECT value FROM jj_records WHERE collection = $1 AND id = $2",
        [collection, id],
      );
      return result.rows[0]?.value;
    },
    async list<T>(collection: string) {
      check();
      const result = await query<{ value: T }>(
        "SELECT value FROM jj_records WHERE collection = $1 ORDER BY id",
        [collection],
      );
      return result.rows.map((row) => row.value);
    },
    async put(collection, id, value) {
      check(true);
      const json = JSON.stringify(value);
      if (json === undefined)
        throw new Error("Stored values must be JSON serializable.");
      await query(
        `INSERT INTO jj_records (collection, id, value) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (collection, id) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [collection, id, json],
      );
    },
    async delete(collection, id) {
      check(true);
      await query("DELETE FROM jj_records WHERE collection = $1 AND id = $2", [
        collection,
        id,
      ]);
    },
    async appendEvent(input) {
      check(true);
      const result = await query<{ sequence: number }>(
        "SELECT COALESCE(MAX(sequence), 0)::integer + 1 AS sequence FROM jj_events WHERE task_id = $1",
        [input.taskId],
      );
      const event: TaskEvent = {
        ...input,
        id: randomUUID(),
        sequence: result.rows[0]?.sequence ?? 1,
        occurredAt: new Date().toISOString(),
      };
      await query(
        "INSERT INTO jj_events (task_id, sequence, value) VALUES ($1, $2, $3::jsonb)",
        [event.taskId, event.sequence, JSON.stringify(event)],
      );
      return event;
    },
    async events(taskId, after = 0) {
      check();
      validateCursor(after);
      const result = await query<{ value: TaskEvent }>(
        "SELECT value FROM jj_events WHERE task_id = $1 AND sequence > $2 ORDER BY sequence",
        [taskId, after],
      );
      return result.rows.map((row) => row.value);
    },
  };
  return {
    tx,
    finish: () => {
      active = false;
    },
  };
}

function serialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const result = tail.then(fn);
    // A failed transaction must not poison later operations.
    tail = result.catch(() => {});
    return result;
  };
}

function validateCursor(after: number) {
  if (!Number.isSafeInteger(after) || after < 0)
    throw new Error("Event cursor must be a nonnegative safe integer.");
}

/**
 * Open a durable record/event store. PGlite supports one owning process per file directory;
 * use PostgreSQL for separate API/worker processes or multiple replicas.
 */
export async function openStore(config: StoreConfig): Promise<BackendStore> {
  let closed = false;
  function checkOpen() {
    if (closed) throw new Error("The backend store is closed.");
  }
  if (config.mode === "pglite") {
    const db = await PGlite.create(config.path ?? "memory://");
    await db.exec(migrationSql);
    const serial = serialQueue();
    async function run<T>(
      fn: (tx: StoreTx) => Promise<T>,
      readOnly: boolean,
    ): Promise<T> {
      return serial(async () => {
        checkOpen();
        return db.transaction(async (raw) => {
          const scoped = makeTx(
            (sql, params) => raw.query(sql, params),
            readOnly,
          );
          try {
            return await fn(scoped.tx);
          } finally {
            scoped.finish();
          }
        });
      });
    }
    return {
      transaction: (fn) => run(fn, false),
      read: (fn) => run(fn, true),
      async events(taskId, after = 0) {
        validateCursor(after);
        return serial(async () => {
          checkOpen();
          const result = await db.query<{ value: TaskEvent }>(
            "SELECT value FROM jj_events WHERE task_id = $1 AND sequence > $2 ORDER BY sequence",
            [taskId, after],
          );
          return result.rows.map((row) => row.value);
        });
      },
      close: () =>
        serial(async () => {
          if (!closed) {
            closed = true;
            await db.close();
          }
        }),
    };
  }

  if (!config.connectionString?.trim())
    throw new Error("DATABASE_URL is required in PostgreSQL mode.");
  const pool = new Pool({ connectionString: config.connectionString });
  try {
    await pool.query(migrationSql);
  } catch (error) {
    await pool.end();
    throw error;
  }
  async function run<T>(
    fn: (tx: StoreTx) => Promise<T>,
    readOnly: boolean,
  ): Promise<T> {
    checkOpen();
    const client = await pool.connect();
    let scoped: ReturnType<typeof makeTx> | undefined;
    try {
      await client.query(
        readOnly ? "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY" : "BEGIN",
      );
      if (!readOnly)
        await client.query(
          "SELECT id FROM jj_write_lock WHERE id = 1 FOR UPDATE",
        );
      scoped = makeTx((sql, params) => client.query(sql, params), readOnly);
      const value = await fn(scoped.tx);
      await client.query("COMMIT");
      return value;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      scoped?.finish();
      client.release();
    }
  }
  return {
    transaction: (fn) => run(fn, false),
    read: (fn) => run(fn, true),
    async events(taskId, after = 0) {
      checkOpen();
      validateCursor(after);
      const result = await pool.query<{ value: TaskEvent }>(
        "SELECT value FROM jj_events WHERE task_id = $1 AND sequence > $2 ORDER BY sequence",
        [taskId, after],
      );
      return result.rows.map((row) => row.value);
    },
    async close() {
      if (!closed) {
        closed = true;
        await pool.end();
      }
    },
  };
}
