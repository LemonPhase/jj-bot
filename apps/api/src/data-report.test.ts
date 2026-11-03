// The data check behind the restore check: a database's migration level
// against this build, its records, and the stored secrets the configured
// JJ_SECRET_KEY cannot open, read without migrating or writing anything.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type SchemaLevel, shippedMigrations } from "@jj/db";
import { PREVIOUS_RELEASE, seedPreviousRelease } from "@jj/db/testing";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { dockerNamespace, secretKeys } from "./config";
import {
  formatEnv,
  formatReport,
  readDataReport,
  stateOf,
} from "./data-report";
import { OPEN_TIMEOUT, testApp } from "./testing";

const directories: string[] = [];
afterAll(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "jj-data-report-"));
  directories.push(path);
  return path;
}

const level = (overrides: Partial<SchemaLevel>): SchemaLevel => ({
  recorded: true,
  applied: 9,
  shipped: 9,
  shippedLatest: "0008_secrets",
  pending: 0,
  newer: 0,
  ...overrides,
});

describe("stateOf", () => {
  it("names the schema empty, behind, current or newer", () => {
    expect(stateOf(level({ recorded: false, applied: 0, pending: 9 }))).toBe(
      "empty",
    );
    expect(stateOf(level({ applied: 5, pending: 4 }))).toBe("behind");
    expect(stateOf(level({}))).toBe("current");
    expect(stateOf(level({ applied: 10, newer: 1 }))).toBe("newer");
  });
});

describe("readDataReport", () => {
  it(
    `reads the ${PREVIOUS_RELEASE.name} database as behind, without migrating it`,
    async () => {
      const path = await directory();
      await seedPreviousRelease({ mode: "pglite", path });
      const setting = { mode: "pglite" as const, path };
      const report = await readDataReport(setting, {});
      const shipped = shippedMigrations();
      expect(report.schema).toEqual({
        state: "behind",
        applied: 5,
        latest: PREVIOUS_RELEASE.migration,
        latestAt: expect.any(String),
        pending: shipped.length - 5,
        newer: 0,
      });
      expect(report.build.latestMigration).toBe(shipped.at(-1)?.tag);
      expect(report.records).toEqual({
        bots: 3,
        tasks: 3,
        artifacts: 5,
        artifactBytes: expect.any(Number),
      });
      // Before the secrets store, there is nothing to report on secrets.
      expect(report.secrets).toBeUndefined();
      expect(formatReport(report)).toContain(
        `Schema: older than this build (5 migrations applied, the newest ${PREVIOUS_RELEASE.migration}). The server applies the ${shipped.length - 5} newer migrations when it starts`,
      );
      expect(formatEnv(report)).toContain("\nschema_state=behind\n");
      // Read only: a second read finds the same level.
      expect((await readDataReport(setting, {})).schema.applied).toBe(5);
    },
    OPEN_TIMEOUT,
  );

  it(
    "reports the stored secrets another JJ_SECRET_KEY sealed as unreadable",
    async () => {
      const path = await directory();
      const sealedWith = randomBytes(32).toString("base64");
      const other = randomBytes(32).toString("base64");
      const t = await testApp({
        startWorker: false,
        database: { mode: "pglite", path },
        secretKeys: secretKeys({ JJ_SECRET_KEY: sealedWith }),
      });
      try {
        expect(
          (
            await t.call("PUT", "/api/secrets/GITHUB_TOKEN", {
              value: "ghp_dataReportToken0123456789abcdef",
            })
          ).status,
        ).toBe(201);
        expect(
          (
            await t.call("PUT", "/api/models/providers/openai/key", {
              value: "sk-data-report-0123456789abcdefghij",
            })
          ).status,
        ).toBe(200);
      } finally {
        await t.dispose();
      }
      const setting = { mode: "pglite" as const, path };
      const read = (env: Record<string, string>) =>
        readDataReport(setting, env);

      const same = await read({ JJ_SECRET_KEY: sealedWith });
      expect(same.schema.state).toBe("current");
      expect(same.secrets).toEqual({
        stored: 2,
        keyConfigured: true,
        unreadable: [],
      });
      expect(formatReport(same)).toContain(
        "Secrets: 2 stored values, all readable with the configured JJ_SECRET_KEY.",
      );

      const another = await read({ JJ_SECRET_KEY: other });
      expect(another.secrets?.keyConfigured).toBe(true);
      expect(
        another.secrets?.unreadable.map((entry) => entry.name).sort(),
      ).toEqual(["GITHUB_TOKEN", "openai"]);
      const text = formatReport(another);
      expect(text).toContain(
        "Secrets: 2 of 2 stored values cannot be read with the configured JJ_SECRET_KEY",
      );
      expect(text).toContain("the openai key");
      expect(text).toContain("GITHUB_TOKEN");
      expect(formatEnv(another)).toContain("\nsecrets_unreadable=2\n");

      const none = await read({});
      expect(none.secrets).toMatchObject({ stored: 2, keyConfigured: false });
      expect(formatReport(none)).toContain(
        "but JJ_SECRET_KEY is not set, so none can be read",
      );

      // During a rotation the old key, kept as previous, still opens them.
      const rotating = await read({
        JJ_SECRET_KEY: other,
        JJ_SECRET_KEY_PREVIOUS: sealedWith,
      });
      expect(rotating.secrets?.unreadable).toEqual([]);

      // Read with SQL, not this build's schema: a `secrets` table of another
      // shape (an older release's, or one a later migration changed) still
      // reports which rows the key opens.
      const database = await openDatabase({ mode: "pglite", path });
      await database.db.execute(
        sql`alter table secrets drop column hint, drop column created_at, drop column updated_at`,
      );
      await database.close();
      const reshaped = await read({ JJ_SECRET_KEY: other });
      expect(reshaped.secrets?.stored).toBe(2);
      expect(
        reshaped.secrets?.unreadable.map((entry) => entry.name).sort(),
      ).toEqual(["GITHUB_TOKEN", "openai"]);
      expect(
        (await read({ JJ_SECRET_KEY: sealedWith })).secrets?.unreadable,
      ).toEqual([]);
    },
    OPEN_TIMEOUT,
  );

  it(
    "lists every migration this build ships, for the restore's level check",
    async () => {
      const path = await directory();
      await seedPreviousRelease({ mode: "pglite", path });
      const report = await readDataReport({ mode: "pglite", path }, {});
      const tags = shippedMigrations().map((migration) => migration.tag);
      expect(report.build.migrationTags).toEqual(tags);
      expect(formatEnv(report)).toContain(
        `\nbuild_migration_tags=${tags.join(",")}\n`,
      );
      expect(report.dockerNamespace).toBe("jj-sandbox");
      expect(
        (
          await readDataReport(
            { mode: "pglite", path },
            { JJ_DOCKER_NAMESPACE: "jj-bot" },
          )
        ).dockerNamespace,
      ).toBe(dockerNamespace({ JJ_DOCKER_NAMESPACE: "jj-bot" }));
    },
    OPEN_TIMEOUT,
  );

  it("refuses a PGlite directory that holds no database, creating nothing", async () => {
    const path = join(await directory(), "missing");
    await expect(readDataReport({ mode: "pglite", path }, {})).rejects.toThrow(
      `No PGlite database at ${path}.`,
    );
    expect(existsSync(path)).toBe(false);
  });
});
