// What a database holds, read without migrating or writing anything: its
// migration level against this build, its records, and whether the configured
// JJ_SECRET_KEY opens its stored secrets and the replaced or removed values it
// keeps for redaction. `scripts/backup.sh` records it in a
// backup's manifest and `scripts/restore.sh` runs it as the restore check;
// `apps/api/src/data-check.ts` is the command.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createKeyring, SecretStore } from "@jj/backend";
import { CONTRACT_VERSION } from "@jj/contracts";
import {
  type Db,
  inspectDatabase,
  LOCAL_OWNER,
  readSchemaLevel,
  type SchemaLevel,
  type SecretKind,
  shippedMigrations,
} from "@jj/db";
import { sql } from "drizzle-orm";
import {
  type DatabaseSetting,
  dockerNamespace,
  type Env,
  REPO_ROOT,
  redactUrl,
  secretKeys,
} from "./config";

/**
 * - `empty`: never opened by JJ Bot (no migration record);
 * - `behind`: an older schema, which the server migrates when it starts;
 * - `current`: this build's schema;
 * - `newer`: migrated by a newer version; this build refuses to start on it.
 */
export type SchemaState = "empty" | "behind" | "current" | "newer";

export interface DataReport {
  database: { mode: DatabaseSetting["mode"]; where: string };
  build: {
    version: string;
    contractVersion: string;
    migrations: number;
    latestMigration: string;
    /** Every migration this build ships, oldest first. */
    migrationTags: string[];
  };
  schema: {
    state: SchemaState;
    applied: number;
    /** The newest applied migration's tag, when this build ships it. */
    latest?: string;
    latestAt?: string;
    pending: number;
    newer: number;
  };
  /** Record counts; absent for an empty database. */
  records?: {
    bots: number;
    tasks: number;
    artifacts: number;
    artifactBytes: number;
    /** Task events, and the UTF-8 bytes of their payloads' JSON. */
    events: number;
    eventBytes: number;
    /** Tasks whose events were compacted (`task.compacted`). */
    compactedTasks: number;
  };
  /** Stored secrets; absent before the secrets store's migration. */
  secrets?: {
    stored: number;
    /** `JJ_SECRET_KEY` is set. */
    keyConfigured: boolean;
    /** Rows the configured keys cannot open, by kind and name. */
    unreadable: { kind: string; name: string }[];
    /**
     * Replaced or removed values kept for redaction (`retired_secrets`), and
     * how many of them the configured keys cannot open: those are no longer
     * redacted. Zero before that table's migration.
     */
    retired: { stored: number; unreadable: number };
  };
  /** The docker driver's namespace: its task workspaces are `<namespace>-task-<taskId>`. */
  dockerNamespace: string;
}

export function stateOf(level: SchemaLevel): SchemaState {
  if (!level.recorded || level.applied === 0) return "empty";
  if (level.newer > 0) return "newer";
  return level.pending > 0 ? "behind" : "current";
}

async function present(exec: Db, table: string): Promise<boolean> {
  const result = (await exec.execute(
    sql`select to_regclass(${`public.${table}`}) is not null as present`,
  )) as unknown as { rows: { present: boolean }[] };
  return result.rows[0]?.present === true;
}

interface SealedRow {
  kind: SecretKind;
  name: string;
  key_id: string;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
}

/** A table's sealed values, read with SQL: the database may be of another schema version. */
async function sealedRows(
  exec: Db,
  table: "secrets" | "retired_secrets",
): Promise<SealedRow[]> {
  const result = (await exec.execute(
    sql`select kind, name, key_id, nonce, ciphertext from ${sql.identifier(table)} where owner_id = ${LOCAL_OWNER} order by kind, name`,
  )) as unknown as { rows: SealedRow[] };
  return result.rows;
}

const sealedOf = (row: SealedRow) => ({
  kind: row.kind,
  name: row.name,
  keyId: row.key_id,
  nonce: new Uint8Array(row.nonce),
  ciphertext: new Uint8Array(row.ciphertext),
});

async function count(exec: Db, query: string): Promise<number> {
  const result = (await exec.execute(sql.raw(query))) as unknown as {
    rows: { n: string | number }[];
  };
  return Number(result.rows[0]?.n ?? 0);
}

/** The report, read through `exec`, which must not have been migrated. */
export async function reportOn(
  exec: Db,
  env: Env,
  database: DataReport["database"],
): Promise<DataReport> {
  const level = await readSchemaLevel(exec);
  const state = stateOf(level);
  const { version } = JSON.parse(
    readFileSync(join(REPO_ROOT, "package.json"), "utf8"),
  ) as { version: string };
  const report: DataReport = {
    database,
    build: {
      version,
      contractVersion: CONTRACT_VERSION,
      migrations: level.shipped,
      latestMigration: level.shippedLatest,
      migrationTags: shippedMigrations().map((migration) => migration.tag),
    },
    schema: {
      state,
      applied: level.applied,
      ...(level.latest ? { latest: level.latest } : {}),
      ...(level.latestAt ? { latestAt: level.latestAt.toISOString() } : {}),
      pending: level.pending,
      newer: level.newer,
    },
    dockerNamespace: dockerNamespace(env),
  };
  if (state === "empty") return report;
  report.records = {
    bots: await count(exec, "select count(*) as n from bots"),
    tasks: await count(exec, "select count(*) as n from tasks"),
    artifacts: await count(exec, "select count(*) as n from artifacts"),
    artifactBytes: await count(
      exec,
      "select coalesce(sum(size_bytes), 0) as n from artifacts",
    ),
    events: await count(exec, "select count(*) as n from task_events"),
    eventBytes: await count(
      exec,
      "select coalesce(sum(octet_length(payload::text)), 0) as n from task_events",
    ),
    // Read as an older schema may hold it: the column came with retention.
    compactedTasks: await count(
      exec,
      "select count(distinct task_id) as n from task_events where type = 'task.compacted'",
    ),
  };
  if (await present(exec, "secrets")) {
    const keys = secretKeys(env);
    const store = new SecretStore({
      db: exec,
      ...(keys ? { keyring: createKeyring(keys.current, keys.previous) } : {}),
      owner: LOCAL_OWNER,
    });
    // Raw SQL, not the current schema: the database may be an older one.
    const rows = await sealedRows(exec, "secrets");
    const retired = (await present(exec, "retired_secrets"))
      ? await sealedRows(exec, "retired_secrets")
      : [];
    report.secrets = {
      stored: rows.length,
      keyConfigured: keys !== undefined,
      unreadable: rows
        .filter((row) => !store.opens(sealedOf(row)))
        .map((row) => ({ kind: row.kind, name: row.name })),
      retired: {
        stored: retired.length,
        unreadable: retired.filter((row) => !store.opensRetired(sealedOf(row)))
          .length,
      },
    };
  }
  return report;
}

/** Reads the report without migrating or writing anything. */
export function readDataReport(
  setting: DatabaseSetting,
  env: Env,
): Promise<DataReport> {
  return setting.mode === "postgres"
    ? inspectDatabase(setting, (db) =>
        reportOn(db, env, {
          mode: "postgres",
          where: redactUrl(setting.connectionString),
        }),
      )
    : inspectDatabase(setting, (db) =>
        reportOn(db, env, { mode: "pglite", where: setting.path }),
      );
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** The report for a person: one line per fact, and what to do about it. */
export function formatReport(report: DataReport): string {
  const { schema, build } = report;
  const lines = [
    `Database: ${report.database.mode === "postgres" ? "PostgreSQL" : "PGlite"} at ${report.database.where}`,
    `This build: JJ Bot ${build.version}, contract ${build.contractVersion}, ${plural(build.migrations, "migration")} up to ${build.latestMigration}`,
  ];
  const level = `${plural(schema.applied, "migration")} applied${schema.latest ? `, the newest ${schema.latest}` : ""}`;
  switch (schema.state) {
    case "empty":
      lines.push(
        "Schema: empty. JJ Bot never opened this database; the server creates the schema when it starts.",
      );
      break;
    case "current":
      lines.push(`Schema: current (${level}).`);
      break;
    case "behind":
      lines.push(
        `Schema: older than this build (${level}). The server applies the ${plural(schema.pending, "newer migration")} when it starts; migrations are forward-only, so keep the backup until the upgraded server works.`,
      );
      break;
    case "newer":
      lines.push(
        `Schema: NEWER than this build (${level}, ${schema.newer} unknown to it, the newest from ${schema.latestAt}). This build refuses to start on it: run the version that wrote it, or a later one.`,
      );
      break;
  }
  if (report.records) {
    const {
      bots,
      tasks,
      artifacts,
      artifactBytes,
      events,
      eventBytes,
      compactedTasks,
    } = report.records;
    lines.push(
      `Records: ${plural(bots, "bot")}, ${plural(tasks, "task")}, ${plural(artifacts, "artifact")} (${artifactBytes} bytes).`,
      `Task events: ${plural(events, "event")} (${eventBytes} payload bytes); ${plural(compactedTasks, "task")} compacted.`,
    );
  }
  if (report.secrets) {
    const { stored, keyConfigured, unreadable } = report.secrets;
    const names = unreadable
      .map((entry) =>
        entry.kind === "provider" ? `the ${entry.name} key` : entry.name,
      )
      .join(", ");
    if (stored === 0) lines.push("Secrets: none stored.");
    else if (unreadable.length === 0)
      lines.push(
        `Secrets: ${plural(stored, "stored value")}, all readable with the configured JJ_SECRET_KEY.`,
      );
    else
      lines.push(
        keyConfigured
          ? `Secrets: ${unreadable.length} of ${plural(stored, "stored value")} cannot be read with the configured JJ_SECRET_KEY (${names}): they were stored under another key. Set the key they were stored with as JJ_SECRET_KEY, or in JJ_SECRET_KEY_PREVIOUS to move them to a new key, or store them again in Settings.`
          : `Secrets: ${plural(stored, "stored value")} (${names}), but JJ_SECRET_KEY is not set, so none can be read. Set the key they were stored with; a backup never holds it.`,
      );
    const { retired } = report.secrets;
    const kept = plural(retired.stored, "value");
    if (retired.stored > 0)
      lines.push(
        retired.unreadable === 0
          ? `Replaced or removed secrets: ${kept} kept for redaction, all readable with the configured JJ_SECRET_KEY.`
          : keyConfigured
            ? `Replaced or removed secrets: ${retired.unreadable} of ${kept} kept for redaction cannot be read with the configured JJ_SECRET_KEY, so they are no longer redacted from task history. Set the key that sealed them as JJ_SECRET_KEY, or in JJ_SECRET_KEY_PREVIOUS to move them to a new key.`
            : `Replaced or removed secrets: ${kept} kept for redaction, but JJ_SECRET_KEY is not set, so none is redacted from task history. Set the key they were sealed with; a backup never holds it.`,
      );
  }
  return lines.join("\n");
}

/** `key=value` lines for shell scripts; no value holds a newline. */
export function formatEnv(report: DataReport): string {
  const entries: [string, string | number][] = [
    ["database_mode", report.database.mode],
    ["build_version", report.build.version],
    ["build_contract_version", report.build.contractVersion],
    ["build_migrations", report.build.migrations],
    ["build_latest_migration", report.build.latestMigration],
    ["build_migration_tags", report.build.migrationTags.join(",")],
    ["schema_state", report.schema.state],
    ["schema_applied", report.schema.applied],
    ["schema_latest", report.schema.latest ?? ""],
    ["schema_pending", report.schema.pending],
    ["schema_newer", report.schema.newer],
    ["bots", report.records?.bots ?? 0],
    ["tasks", report.records?.tasks ?? 0],
    ["artifacts", report.records?.artifacts ?? 0],
    ["artifact_bytes", report.records?.artifactBytes ?? 0],
    ["events", report.records?.events ?? 0],
    ["event_bytes", report.records?.eventBytes ?? 0],
    ["compacted_tasks", report.records?.compactedTasks ?? 0],
    ["secrets_stored", report.secrets?.stored ?? 0],
    ["secrets_unreadable", report.secrets?.unreadable.length ?? 0],
    ["secrets_retired", report.secrets?.retired.stored ?? 0],
    ["secrets_retired_unreadable", report.secrets?.retired.unreadable ?? 0],
    ["docker_namespace", report.dockerNamespace],
  ];
  return entries.map(([key, value]) => `${key}=${value}`).join("\n");
}
