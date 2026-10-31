import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";

/** Lock file PGlite mode keeps in its data directory while a process owns it. */
export const LOCK_FILE = "jj-db.lock";

/** Another live process owns the PGlite data directory. */
export class DatabaseInUseError extends Error {
  constructor(
    readonly directory: string,
    readonly pid: number,
  ) {
    super(
      `The database directory ${directory} is in use by pid ${pid}. PGlite supports one process; use PostgreSQL for a separate worker.`,
    );
    this.name = "DatabaseInUseError";
  }
}

/**
 * The node filesystem directory PGlite will use for `dataDir`, or undefined
 * for in-memory and browser storage (`memory://`, `idb://`, `opfs-ahp://`, …).
 */
export function nodeDataDirectory(dataDir: string): string | undefined {
  if (dataDir.startsWith("file://")) return dataDir.slice("file://".length);
  if (!dataDir || /^[a-z][a-z0-9+.-]*:\/\//i.test(dataDir)) return undefined;
  return dataDir;
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const parsePid = (content: string) => {
  const pid = Number(content.split("\n", 1)[0]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
};

/**
 * Take the data directory's lock file (`wx`, holding this pid and a token).
 * A lock whose pid is no longer running is stale and taken over. Returns the
 * release function, which removes the file only while it is still ours.
 */
export async function lockDataDirectory(
  directory: string,
): Promise<() => Promise<void>> {
  await mkdir(directory, { recursive: true });
  const file = join(directory, LOCK_FILE);
  const content = `${process.pid}\n${randomUUID()}\n`;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const handle = await open(file, "wx");
      try {
        await handle.writeFile(content);
      } finally {
        await handle.close();
      }
      return async () => {
        const current = await readFile(file, "utf8").catch(() => undefined);
        if (current === content) await rm(file, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const existing = await readFile(file, "utf8").catch(() => undefined);
    if (existing === undefined) continue; // released meanwhile; retry
    const pid = parsePid(existing);
    if (pid !== undefined && isAlive(pid))
      throw new DatabaseInUseError(directory, pid);
    // Stale. Move it aside and check it is still the stale lock we read, so a
    // concurrent opener's fresh lock is never deleted.
    const aside = `${file}.stale-${randomUUID()}`;
    try {
      await rename(file, aside);
    } catch {
      continue;
    }
    const moved = await readFile(aside, "utf8").catch(() => undefined);
    if (moved !== existing && moved !== undefined) {
      await link(aside, file).catch(() => {});
      await rm(aside, { force: true });
      const owner = parsePid(moved);
      if (owner !== undefined && isAlive(owner))
        throw new DatabaseInUseError(directory, owner);
      continue;
    }
    await rm(aside, { force: true });
  }
  throw new Error(`Could not lock the database directory ${directory}.`);
}

const inTransaction = new AsyncLocalStorage<true>();

export const NESTED_TRANSACTION_MESSAGE =
  "PGlite has one connection and this call is inside a transaction: use the transaction handle (tx), not the database. Calling the database here would wait for the transaction forever.";

function refuseInsideTransaction() {
  if (inTransaction.getStore()) throw new Error(NESTED_TRANSACTION_MESSAGE);
}

/**
 * Wrap a PGlite instance so that a statement, transaction or LISTEN issued on
 * it from inside one of its own transaction callbacks throws instead of
 * waiting forever on its single connection. The transaction handle itself is
 * a separate object and is unaffected.
 */
export function guardNestedCalls(client: PGlite): PGlite {
  return new Proxy(client, {
    get(target, property) {
      if (property === "transaction")
        return (callback: Parameters<PGlite["transaction"]>[0]) => {
          refuseInsideTransaction();
          return target.transaction((tx) =>
            inTransaction.run(true, () => callback(tx)),
          );
        };
      const value: unknown = Reflect.get(target, property, target);
      if (typeof value !== "function" || property === "constructor")
        return value;
      if (
        property === "query" ||
        property === "sql" ||
        property === "exec" ||
        property === "listen" ||
        property === "unlisten" ||
        property === "describeQuery"
      )
        return (...args: unknown[]) => {
          refuseInsideTransaction();
          return (value as (...args: unknown[]) => unknown).apply(target, args);
        };
      return (value as (...args: unknown[]) => unknown).bind(target);
    },
  });
}

const DATABASE_ENTRY_POINTS = new Set<PropertyKey>([
  "select",
  "selectDistinct",
  "selectDistinctOn",
  "insert",
  "update",
  "delete",
  "execute",
  "transaction",
  "with",
  "query",
  "$count",
  "refreshMaterializedView",
]);

/**
 * Wrap the top-level Drizzle database so its query entry points throw the same
 * clear error directly, rather than as the cause of a "Failed query" error.
 */
export function guardDatabase<T extends object>(db: T): T {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (DATABASE_ENTRY_POINTS.has(property)) refuseInsideTransaction();
      return Reflect.get(target, property, receiver);
    },
  });
}
