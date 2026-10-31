import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { type ExtractTablesWithRelations, sql } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
import type {
  PgDatabase,
  PgQueryResultHKT,
  PgTransaction,
} from "drizzle-orm/pg-core";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { Pool, type PoolClient } from "pg";
import {
  type Bus,
  type BusOptions,
  createBus,
  pgliteListener,
  postgresListener,
} from "./bus";
import {
  guardDatabase,
  guardNestedCalls,
  lockDataDirectory,
  nodeDataDirectory,
} from "./pglite";
import { tables } from "./schema";

export type Schema = typeof tables;
/** A Drizzle database over either driver. Use the schema tables with the query builder. */
export type Db = PgDatabase<PgQueryResultHKT, Schema>;
/** A Drizzle transaction from `db.transaction(...)`. */
export type Tx = PgTransaction<
  PgQueryResultHKT,
  Schema,
  ExtractTablesWithRelations<Schema>
>;
/** Anything that runs a statement: the database (autocommit) or a transaction. */
export type Executor = Db | Tx;

export type DatabaseMode = "pglite" | "postgres";

export type DatabaseConfig =
  | {
      mode: "pglite";
      /**
       * Data directory, or `memory://` (the default) for an in-memory database.
       * A directory is locked to this process until close.
       */
      path?: string;
      onError?: (error: unknown) => void;
    }
  | {
      mode: "postgres";
      connectionString: string;
      /** Maximum pooled connections (node-postgres default: 10). The bus listener uses one more. */
      poolSize?: number;
      /** `lock_timeout` for pooled connections: a statement waiting longer for a lock fails. Default 10 s; 0 disables. */
      lockTimeoutMs?: number;
      /** `idle_in_transaction_session_timeout`: the server ends a connection left idle in a transaction. Default 60 s; 0 disables. */
      idleInTransactionTimeoutMs?: number;
      bus?: BusOptions;
      onError?: (error: unknown) => void;
    };

export interface Database {
  readonly mode: DatabaseMode;
  readonly db: Db;
  readonly bus: Bus;
  /** Closes the bus, then the pool or embedded database. Idempotent. */
  close(): Promise<void>;
}

/** Generated SQL migrations, applied in order on open. */
export const migrationsFolder = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

/** Session advisory lock key that serializes concurrent migrators on one PostgreSQL database. */
const MIGRATION_LOCK = "jj-bot:migrations";

const defaultOnError = (error: unknown) => {
  console.error("[@jj/db]", error);
};

/**
 * Open the store and bring its schema up to date. PGlite is a single-process
 * embedded database (one owner per data directory); use PostgreSQL for
 * separate API and worker processes. Migrations are applied before this
 * resolves; on PostgreSQL concurrent openers serialize on an advisory lock.
 */
export async function openDatabase(config: DatabaseConfig): Promise<Database> {
  const onError = config.onError ?? defaultOnError;
  if (config.mode === "pglite") return openPglite(config.path, onError);

  if (!config.connectionString?.trim())
    throw new Error("A PostgreSQL connection string is required.");
  const lockTimeoutMs = timeoutSetting(
    config.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS,
    "lockTimeoutMs",
  );
  const idleTimeoutMs = timeoutSetting(
    config.idleInTransactionTimeoutMs ?? DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS,
    "idleInTransactionTimeoutMs",
  );
  const pool = new Pool({
    connectionString: config.connectionString,
    max: config.poolSize,
    // A wait on a lock, or a transaction abandoned mid-way, fails instead of hanging.
    options: `-c lock_timeout=${lockTimeoutMs} -c idle_in_transaction_session_timeout=${idleTimeoutMs}`,
  });
  // An idle client that errors (server restart, network) must not crash the process.
  pool.on("error", onError);
  reportCheckedOutErrors(pool, onError);
  const endPool = trackPool(pool);
  try {
    const db = drizzleNodePg(pool, { schema: tables });
    await migratePostgres(pool);
    const bus = createBus(
      postgresListener(config.connectionString, onError, config.bus),
      onError,
    );
    return finish("postgres", db, bus, endPool);
  } catch (error) {
    await endPool();
    throw error;
  }
}

export interface MigrationStatus {
  /** Migrations in `migrationsFolder`. */
  expected: number;
  /** Migrations recorded as applied in this database. */
  applied: number;
  /** Migrations newer than the last applied one: what `openDatabase` would apply. */
  pending: number;
}

/**
 * Compares the database's migration record with the migrations shipped in
 * `migrationsFolder`, the way the migrator decides what to apply. For
 * readiness checks; `openDatabase` has already applied everything it opened.
 */
export async function migrationStatus(
  exec: Executor,
): Promise<MigrationStatus> {
  const files = readMigrationFiles({ migrationsFolder });
  const result = (await exec.execute(
    sql`select created_at from drizzle.__drizzle_migrations`,
  )) as unknown as { rows: { created_at: string | number }[] };
  const applied = result.rows.map((row) => Number(row.created_at));
  const last = applied.length > 0 ? Math.max(...applied) : -1;
  return {
    expected: files.length,
    applied: applied.length,
    pending: files.filter((file) => file.folderMillis > last).length,
  };
}

export const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
export const DEFAULT_IDLE_IN_TRANSACTION_TIMEOUT_MS = 60_000;

function timeoutSetting(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new RangeError(`${name} must be a nonnegative integer.`);
  return value;
}

async function openPglite(
  path: string | undefined,
  onError: (error: unknown) => void,
): Promise<Database> {
  const dataDir = path ?? "memory://";
  const directory = nodeDataDirectory(dataDir);
  // PGlite cannot share a data directory: refuse a second owner up front.
  const unlock = directory
    ? await lockDataDirectory(directory)
    : async () => {};
  let raw: PGlite | undefined;
  try {
    raw = await PGlite.create(dataDir);
    const client = guardNestedCalls(raw);
    const db = guardDatabase(drizzlePglite(client, { schema: tables }));
    await migratePglite(db, { migrationsFolder });
    const opened = raw;
    return finish(
      "pglite",
      db,
      createBus(pgliteListener(client), onError),
      async () => {
        try {
          await opened.close();
        } finally {
          await unlock();
        }
      },
    );
  } catch (error) {
    await raw?.close().catch(() => {});
    await unlock();
    throw error;
  }
}

/**
 * A pooled client that the server disconnects while it is checked out (for
 * example after `idle_in_transaction_session_timeout`) emits `error` with no
 * pool listener attached, which would crash the process. Report it instead;
 * the caller's next query on it fails and the pool discards it on release.
 */
function reportCheckedOutErrors(pool: Pool, onError: (error: unknown) => void) {
  const checkedOut = new WeakSet<object>();
  pool.on("connect", (client) => {
    client.on("error", (error) => {
      if (checkedOut.has(client)) onError(error);
    });
  });
  pool.on("acquire", (client) => checkedOut.add(client));
  pool.on("release", (_error, client) => checkedOut.delete(client));
}

/**
 * `pool.end()` resolves once it has asked its clients to end, not once their
 * connections have closed. The returned function waits for both, so a closed
 * database holds no server connection.
 */
function trackPool(pool: Pool) {
  const live = new Set<unknown>();
  let drained: (() => void) | undefined;
  pool.on("connect", (client) => live.add(client));
  pool.on("remove", (client) => {
    live.delete(client);
    if (live.size === 0) drained?.();
  });
  return async () => {
    const closed = new Promise<void>((resolve) => {
      drained = resolve;
    });
    await pool.end();
    if (live.size > 0) await closed;
  };
}

function finish(
  mode: DatabaseMode,
  db: Db,
  bus: Bus,
  closeDriver: () => Promise<void>,
): Database {
  let closing: Promise<void> | undefined;
  return {
    mode,
    db,
    bus,
    close() {
      closing ??= (async () => {
        try {
          await bus.close();
        } finally {
          await closeDriver();
        }
      })();
      return closing;
    },
  };
}

async function migratePostgres(pool: Pool) {
  const client: PoolClient = await pool.connect();
  let broken: Error | undefined;
  try {
    // A session lock: released explicitly, or by the server if this connection dies.
    // Wait for another process's migration however long it takes; the pool's
    // lock_timeout is for application statements.
    await client.query("set lock_timeout = 0");
    await client.query("select pg_advisory_lock(hashtext($1))", [
      MIGRATION_LOCK,
    ]);
    try {
      await migrateNodePg(drizzleNodePg(client), { migrationsFolder });
    } finally {
      try {
        await client.query("select pg_advisory_unlock(hashtext($1))", [
          MIGRATION_LOCK,
        ]);
        await client.query("reset lock_timeout");
      } catch (error) {
        broken = error instanceof Error ? error : new Error(String(error));
      }
    }
  } finally {
    // Discard a connection whose unlock failed rather than return it to the pool.
    client.release(broken);
  }
}
