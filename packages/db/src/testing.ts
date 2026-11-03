// Upgrade-test support, shared by the @jj/db and @jj/api suites
// (`@jj/db/testing`): a database at the previous release's schema holding data
// that release wrote. Not used by the app.
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
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle as drizzleNodePg } from "drizzle-orm/node-postgres";
import { migrate as migrateNodePg } from "drizzle-orm/node-postgres/migrator";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { migrate as migratePglite } from "drizzle-orm/pglite/migrator";
import { Client } from "pg";
import { migrationsFolder, shippedMigrations } from "./migrations";

/**
 * The release the upgrade tests start from: its newest migration, and a
 * fixture of the data its build wrote (`fixtures/`, never edited). Move it
 * forward at each release, with a fixture that release's build writes.
 */
export const PREVIOUS_RELEASE = {
  name: "Milestone 1",
  migration: "0004_run_snapshots",
  fixture: fileURLToPath(
    new URL("../fixtures/milestone-1.sql", import.meta.url),
  ),
} as const;

/** Where a database is: a PGlite data directory or a PostgreSQL database. */
export type DatabaseLocation =
  | { mode: "pglite"; path: string }
  | { mode: "postgres"; connectionString: string };

/**
 * A new temporary migrations folder holding the shipped migrations up to and
 * including `tag`. The caller removes it.
 */
export async function migrationsThrough(tag: string): Promise<string> {
  const journal = JSON.parse(
    await readFile(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] };
  const index = shippedMigrations().findIndex((entry) => entry.tag === tag);
  if (index < 0) throw new Error(`No migration ${tag}.`);
  const folder = await mkdtemp(join(tmpdir(), "jj-migrations-"));
  await mkdir(join(folder, "meta"));
  const entries = journal.entries.slice(0, index + 1);
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

/**
 * Brings a new, empty database to the previous release's schema, the way
 * that build migrated it, and loads the data it wrote, in one transaction.
 * The database is closed again when this resolves.
 */
export async function seedPreviousRelease(
  location: DatabaseLocation,
): Promise<void> {
  const fixture = await readFile(PREVIOUS_RELEASE.fixture, "utf8");
  await seedAt(location, PREVIOUS_RELEASE.migration, fixture);
}

/**
 * Brings a new, empty database to the schema of migration `tag`, the way the
 * build that shipped it migrated it, and runs the SQL `rows` on it, in one
 * transaction: data written before the migrations after `tag`, which opening
 * the database applies. The database is closed again when this resolves.
 */
export async function seedAt(
  location: DatabaseLocation,
  tag: string,
  rows: string,
): Promise<void> {
  const folder = await migrationsThrough(tag);
  const script = `begin;\n${rows}\ncommit;`;
  try {
    if (location.mode === "pglite") {
      const client = await PGlite.create(location.path);
      try {
        await migratePglite(drizzlePglite(client), {
          migrationsFolder: folder,
        });
        await client.exec(script);
      } finally {
        await client.close();
      }
      return;
    }
    const client = new Client({ connectionString: location.connectionString });
    await client.connect();
    try {
      await migrateNodePg(drizzleNodePg(client), { migrationsFolder: folder });
      await client.query(script);
    } finally {
      await client.end();
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
