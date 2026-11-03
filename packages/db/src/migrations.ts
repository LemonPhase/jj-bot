// The schema's migration level: which of the migrations this build ships a
// database has applied, and whether it records migrations newer than any this
// build knows. Opening refuses such a database (migrations are forward-only, so
// an older build cannot undo them); readiness and the restore check report it.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type SQL, sql } from "drizzle-orm";

/** Runs a raw query: a Drizzle database or transaction, on either driver. */
export interface QueryRunner {
  execute(query: SQL): PromiseLike<unknown>;
}

/** Generated SQL migrations, applied in order on open. */
export const migrationsFolder = fileURLToPath(
  new URL("../migrations", import.meta.url),
);

/** A migration this build ships: its file's tag and its journal timestamp, which the database records. */
export interface ShippedMigration {
  tag: string;
  /** `when` in the journal; the migrator records it as `created_at`. */
  when: number;
}

let shipped: ShippedMigration[] | undefined;

/** The migrations in `migrationsFolder`, oldest first, from its journal. */
export function shippedMigrations(): ShippedMigration[] {
  shipped ??= (
    JSON.parse(
      readFileSync(join(migrationsFolder, "meta", "_journal.json"), "utf8"),
    ) as { entries: ShippedMigration[] }
  ).entries.map(({ tag, when }) => ({ tag, when }));
  return shipped;
}

export interface SchemaLevel {
  /** The database has a migration record (it was opened by JJ Bot before). */
  recorded: boolean;
  /** Migrations recorded as applied. */
  applied: number;
  /** The newest applied migration's tag, when this build ships it. */
  latest?: string;
  /** The newest applied migration's journal timestamp. */
  latestAt?: Date;
  /** Migrations this build ships. */
  shipped: number;
  /** The newest migration this build ships. */
  shippedLatest: string;
  /** Shipped migrations newer than the newest applied one: what opening applies. */
  pending: number;
  /** Applied migrations newer than any this build ships, by a newer version. */
  newer: number;
}

/**
 * Reads the database's migration record against the migrations this build
 * ships, the way the migrator decides what to apply. Reads only.
 */
export async function readSchemaLevel(exec: QueryRunner): Promise<SchemaLevel> {
  const files = shippedMigrations();
  const newest = files.at(-1);
  if (!newest) throw new Error(`No migrations in ${migrationsFolder}.`);
  const present = (await exec.execute(
    sql`select to_regclass('drizzle.__drizzle_migrations') is not null as present`,
  )) as unknown as { rows: { present: boolean }[] };
  const applied = present.rows[0]?.present
    ? (
        (await exec.execute(
          sql`select created_at from drizzle.__drizzle_migrations`,
        )) as unknown as { rows: { created_at: string | number }[] }
      ).rows.map((row) => Number(row.created_at))
    : [];
  const last = applied.length > 0 ? Math.max(...applied) : undefined;
  const latest = files.find((file) => file.when === last)?.tag;
  return {
    recorded: present.rows[0]?.present === true,
    applied: applied.length,
    ...(latest ? { latest } : {}),
    ...(last === undefined ? {} : { latestAt: new Date(last) }),
    shipped: files.length,
    shippedLatest: newest.tag,
    pending: files.filter((file) => last === undefined || file.when > last)
      .length,
    newer: applied.filter((when) => when > newest.when).length,
  };
}

/** The database was migrated by a newer version of JJ Bot than this build. */
export class SchemaTooNewError extends Error {
  override readonly name = "SchemaTooNewError";
  constructor(readonly level: SchemaLevel) {
    super(
      `This database was written by a newer version of JJ Bot: it records ${level.applied} migrations, ${level.newer} of them newer than ${level.shippedLatest}, the newest this version knows (the newest applied is from ${level.latestAt?.toISOString()}). Migrations are forward-only, so this version cannot use it and refuses to start. Run the version that wrote it, or a later one, or restore a backup taken with this version.`,
    );
  }
}

/** Throws `SchemaTooNewError` before anything is migrated on a database newer than this build. */
export async function assertSchemaKnown(
  exec: QueryRunner,
): Promise<SchemaLevel> {
  const level = await readSchemaLevel(exec);
  if (level.newer > 0) throw new SchemaTooNewError(level);
  return level;
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
 * `migrationsFolder`. For readiness checks; `openDatabase` has already applied
 * everything it opened.
 */
export async function migrationStatus(
  exec: QueryRunner,
): Promise<MigrationStatus> {
  const level = await readSchemaLevel(exec);
  return {
    expected: level.shipped,
    applied: level.applied,
    pending: level.pending,
  };
}
