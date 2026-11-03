// scripts/backup.sh and scripts/restore.sh against a stand-in docker CLI
// (scripts/fake-docker.sh), which answers from a state directory and records
// what changed. The real stack runs them in CI's Compose stack job; these
// cover the paths a stack seldom takes: no workspace at all, a workspace
// that vanishes mid-backup, a damaged or tampered backup, a dump or a schema
// this stack cannot take, and a failing restore check.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const SCRIPTS = fileURLToPath(new URL(".", import.meta.url));
const REPO = join(SCRIPTS, "..");
const TAGS = ["0000_init", "0001_next", "0002_latest"];

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function temp(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

function checkEnv(overrides: Record<string, string | number> = {}) {
  const values: Record<string, string | number> = {
    database_mode: "postgres",
    build_version: "0.1.0",
    build_contract_version: "1.5.0",
    build_migrations: TAGS.length,
    build_latest_migration: TAGS.at(-1) as string,
    build_migration_tags: TAGS.join(","),
    schema_state: "current",
    schema_applied: TAGS.length,
    schema_latest: TAGS.at(-1) as string,
    schema_pending: 0,
    schema_newer: 0,
    bots: 2,
    tasks: 1,
    artifacts: 1,
    artifact_bytes: 10,
    secrets_stored: 0,
    secrets_unreadable: 0,
    docker_namespace: "jj-test",
    ...overrides,
  };
  return `${Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

const EMPTY = checkEnv({
  schema_state: "empty",
  schema_applied: 0,
  schema_latest: "",
  schema_pending: TAGS.length,
  bots: 0,
  tasks: 0,
  artifacts: 0,
  artifact_bytes: 0,
});

const driverLabels = (namespace: string, mode: string, key: string) =>
  `jj.sandbox=1\njj.sandbox.namespace=${namespace}\njj.sandbox.workspace-key=${key}\njj.sandbox.workspace-mode=${mode}\n`;

/** A stack behind the stand-in docker: its state, and the scripts run against it. */
function stack(options: { check?: string } = {}) {
  const root = temp("jj-fake-stack-");
  const bin = join(root, "bin");
  const state = join(root, "state");
  mkdirSync(bin);
  mkdirSync(join(state, "volumes"), { recursive: true });
  chmodSync(join(SCRIPTS, "fake-docker.sh"), 0o755);
  symlinkSync(join(SCRIPTS, "fake-docker.sh"), join(bin, "docker"));
  writeFileSync(join(state, "project"), "jj-test\n");
  writeFileSync(join(state, "check.env"), options.check ?? checkEnv());
  writeFileSync(join(state, "dump"), "PGDMP fake dump\n");
  writeFileSync(join(state, "postgres_running"), "");
  const file = (name: string) => join(state, name);
  return {
    root,
    state,
    file,
    volume(name: string, labels: string, data = `files of ${name}`) {
      mkdirSync(file(`volumes/${name}`), { recursive: true });
      writeFileSync(file(`volumes/${name}/labels`), labels);
      writeFileSync(file(`volumes/${name}/data`), data);
    },
    hasVolume: (name: string) => existsSync(file(`volumes/${name}`)),
    volumeData: (name: string) =>
      readFileSync(file(`volumes/${name}/data`), "utf8"),
    volumeLabels: (name: string) =>
      readFileSync(file(`volumes/${name}/labels`), "utf8"),
    events: () =>
      existsSync(file("events")) ? readFileSync(file("events"), "utf8") : "",
    run(script: "backup.sh" | "restore.sh", args: string[], cwd = REPO) {
      const result = spawnSync("bash", [join(SCRIPTS, script), ...args], {
        cwd,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${bin}:${process.env.PATH}`,
          FAKE_DOCKER_STATE: state,
        },
      });
      return {
        status: result.status,
        output: `${result.stdout}${result.stderr}`,
      };
    },
  };
}

type Stack = ReturnType<typeof stack>;

/** A backup of a stack with one task workspace, at `dir`. */
function backupOf(source: Stack, dir: string) {
  const result = source.run("backup.sh", [dir]);
  expect(result.output).toContain("Backed up:");
  expect(result.status).toBe(0);
  return dir;
}

function withTaskWorkspace() {
  const source = stack();
  source.volume(
    "jj-test-task-task_1",
    driverLabels("jj-test", "task", "task_1"),
  );
  return source;
}

/** Rewrites a backup file and its checksum, as a tamperer would. */
function tamper(dir: string, file: string, content: string) {
  writeFileSync(join(dir, file), content);
  const sums = spawnSync(
    "bash",
    ["-c", "cut -d' ' -f3 SHA256SUMS | xargs sha256sum"],
    {
      cwd: dir,
      encoding: "utf8",
    },
  );
  writeFileSync(join(dir, "SHA256SUMS"), sums.stdout);
}

function addToSums(dir: string, file: string) {
  const sum = spawnSync("sha256sum", [file], { cwd: dir, encoding: "utf8" });
  writeFileSync(
    join(dir, "SHA256SUMS"),
    `${readFileSync(join(dir, "SHA256SUMS"), "utf8")}${sum.stdout}`,
  );
}

const NOTHING_CHANGED = /(recreated|restored|removed|wrote|created|stopped)/;

describe("scripts/backup.sh", () => {
  it("backs up a stack that has no workspace volume", () => {
    const source = stack();
    const dir = join(temp("jj-backup-"), "b");
    backupOf(source, dir);
    const manifest = readFileSync(join(dir, "manifest.json"), "utf8");
    expect(manifest).toContain('"volumes": [],');
    const sums = readFileSync(join(dir, "SHA256SUMS"), "utf8");
    for (const file of [
      "manifest.json",
      "check.env",
      "check.json",
      "database.dump",
    ])
      expect(sums).toContain(`  ${file}\n`);
  });

  it("writes a relative DIR under the directory it was called from", () => {
    const source = stack();
    const caller = temp("jj-caller-");
    const name = `nightly-${Date.now()}`;
    try {
      const result = source.run("backup.sh", [name], caller);
      expect(result.status).toBe(0);
      expect(existsSync(join(caller, name, "manifest.json"))).toBe(true);
      expect(existsSync(join(REPO, name))).toBe(false);
    } finally {
      rmSync(join(REPO, name), { recursive: true, force: true });
    }
  });

  it("skips a workspace that is gone before it is copied, and says so", () => {
    const source = withTaskWorkspace();
    source.volume(
      "jj-test-task-task_2",
      driverLabels("jj-test", "task", "task_2"),
    );
    source.volume(
      "jj-test-task-task_3",
      driverLabels("jj-test", "task", "task_3"),
    );
    writeFileSync(source.file("vanish_on_inspect"), "jj-test-task-task_2\n");
    writeFileSync(source.file("vanish_on_run"), "jj-test-task-task_3\n");
    const dir = join(temp("jj-backup-"), "b");
    const result = source.run("backup.sh", [dir]);
    expect(result.status).toBe(0);
    expect(result.output).toContain(
      "- workspace jj-test-task-task_2: gone before it was copied, skipped",
    );
    expect(result.output).toContain(
      "- workspace jj-test-task-task_3: gone before it was copied, skipped",
    );
    expect(result.output).toContain(
      "workspaces: 1 (2 gone meanwhile, skipped)",
    );
    const manifest = readFileSync(join(dir, "manifest.json"), "utf8");
    expect(manifest).toContain('"jj-test-task-task_1"');
    expect(manifest).not.toContain("task_2");
    expect(manifest).not.toContain("task_3");
    // The empty volume `docker run` made in place of the vanished one is gone.
    expect(source.hasVolume("jj-test-task-task_3")).toBe(false);
  });

  it("leaves ephemeral workspaces out", () => {
    const source = withTaskWorkspace();
    source.volume(
      "jj-test-ephemeral-task_9-abcd1234",
      driverLabels("jj-test", "ephemeral", "task_9"),
    );
    const dir = backupOf(source, join(temp("jj-backup-"), "b"));
    expect(readFileSync(join(dir, "manifest.json"), "utf8")).not.toContain(
      "ephemeral",
    );
  });
});

describe("scripts/restore.sh", () => {
  it("restores a backup into an empty stack, workspaces relabelled under its namespace", () => {
    const dir = backupOf(withTaskWorkspace(), join(temp("jj-backup-"), "b"));
    const target = stack({ check: EMPTY.replace("=jj-test\n", "=jj-other\n") });
    writeFileSync(
      target.file("after_restore.env"),
      checkEnv({ docker_namespace: "jj-other" }),
    );
    const caller = join(dir, "..");
    const result = target.run("restore.sh", ["b"], caller);
    expect(result.output).toContain(
      "Records match the backup's data check. Workspaces restored: 1.",
    );
    expect(result.status).toBe(0);
    expect(readFileSync(target.file("restored_dump"), "utf8")).toBe(
      "PGDMP fake dump\n",
    );
    expect(target.volumeData("jj-other-task-task_1")).toBe(
      "files of jj-test-task-task_1",
    );
    expect(
      target.volumeLabels("jj-other-task-task_1").split("\n").sort(),
    ).toEqual(driverLabels("jj-other", "task", "task_1").split("\n").sort());
  });

  it("refuses a stack that holds data without --force, and replaces it with --force", () => {
    const dir = backupOf(withTaskWorkspace(), join(temp("jj-backup-"), "b"));
    const target = stack();
    target.volume("jj-test-task-old", driverLabels("jj-test", "task", "old"));
    writeFileSync(target.file("app_running"), "");
    const refused = target.run("restore.sh", [dir]);
    expect(refused.status).toBe(1);
    expect(refused.output).toContain("the stack is not empty");
    expect(target.events()).not.toMatch(NOTHING_CHANGED);

    const replaced = target.run("restore.sh", ["--force", dir]);
    expect(replaced.status).toBe(0);
    const events = target.events();
    expect(events).toContain("stopped app");
    expect(events).toContain("removed volume jj-test-task-old");
    expect(events.indexOf("recreated the database")).toBeLessThan(
      events.indexOf("restored the database"),
    );
    expect(target.hasVolume("jj-test-task-old")).toBe(false);
    expect(target.volumeData("jj-test-task-task_1")).toBe(
      "files of jj-test-task-task_1",
    );
  });

  it("refuses, before changing anything, a dump this stack's pg_restore cannot read", () => {
    const dir = backupOf(withTaskWorkspace(), join(temp("jj-backup-"), "b"));
    const target = stack();
    target.volume("jj-test-task-old", driverLabels("jj-test", "task", "old"));
    writeFileSync(target.file("app_running"), "");
    writeFileSync(target.file("pg_restore_list_fail"), "");
    const result = target.run("restore.sh", ["--force", dir]);
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "this stack's pg_restore cannot read the backup's dump (pg_restore: error: unsupported version (1.99) in file header)",
    );
    expect(result.output).toContain("Nothing was changed.");
    expect(target.events()).not.toMatch(NOTHING_CHANGED);
    expect(target.hasVolume("jj-test-task-old")).toBe(true);
  });

  it("refuses, before changing anything, a backup at a migration this build does not ship", () => {
    const source = withTaskWorkspace();
    writeFileSync(
      source.file("check.env"),
      checkEnv({
        build_migration_tags: [...TAGS, "0003_future"].join(","),
        schema_applied: 4,
        schema_latest: "0003_future",
      }),
    );
    const dir = backupOf(source, join(temp("jj-backup-"), "b"));
    const target = stack();
    writeFileSync(target.file("app_running"), "");
    const result = target.run("restore.sh", ["--force", dir]);
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "the backup's database is at migration 0003_future (4 applied), which this build does not ship (its newest is 0002_latest)",
    );
    expect(target.events()).not.toMatch(NOTHING_CHANGED);
  });

  it("refuses a damaged backup, and a data check file the checksums do not cover", () => {
    const dir = backupOf(withTaskWorkspace(), join(temp("jj-backup-"), "b"));
    const target = stack({ check: EMPTY });
    const damaged = join(temp("jj-backup-"), "damaged");
    cpSync(dir, damaged, { recursive: true });
    writeFileSync(
      join(damaged, "check.env"),
      readFileSync(join(damaged, "check.env"), "utf8").replace(
        "bots=2",
        "bots=3",
      ),
    );
    const result = target.run("restore.sh", [damaged]);
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "the backup is damaged: its checksums do not match.",
    );

    const uncovered = join(temp("jj-backup-"), "uncovered");
    cpSync(dir, uncovered, { recursive: true });
    writeFileSync(
      join(uncovered, "SHA256SUMS"),
      readFileSync(join(uncovered, "SHA256SUMS"), "utf8")
        .split("\n")
        .filter((line) => !line.endsWith("  check.env"))
        .join("\n"),
    );
    const refused = target.run("restore.sh", [uncovered]);
    expect(refused.status).toBe(1);
    expect(refused.output).toContain("SHA256SUMS does not cover check.env");
    expect(target.events()).not.toMatch(NOTHING_CHANGED);
  });

  it("writes only into workspace volumes it creates, named and labelled as the driver's", () => {
    const dir = backupOf(withTaskWorkspace(), join(temp("jj-backup-"), "b"));
    const target = stack({ check: EMPTY });
    target.volume(
      "jj-test_jj_postgres",
      "com.docker.compose.project=jj-test\n",
      "PG_DATA",
    );

    // An archive the manifest does not list.
    const extra = join(temp("jj-backup-"), "extra");
    cpSync(dir, extra, { recursive: true });
    writeFileSync(join(extra, "volumes/jj-test_jj_postgres.tar"), "EVIL");
    writeFileSync(join(extra, "volumes/jj-test_jj_postgres.labels"), "");
    addToSums(extra, "volumes/jj-test_jj_postgres.tar");
    addToSums(extra, "volumes/jj-test_jj_postgres.labels");
    let result = target.run("restore.sh", [extra]);
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "volumes/jj-test_jj_postgres.tar is not a workspace its manifest lists",
    );

    // A listed name that is not a driver workspace of the namespace.
    const renamed = join(temp("jj-backup-"), "renamed");
    cpSync(dir, renamed, { recursive: true });
    for (const suffix of ["tar", "labels"])
      cpSync(
        join(renamed, `volumes/jj-test-task-task_1.${suffix}`),
        join(renamed, `volumes/jj-test_jj_postgres.${suffix}`),
      );
    rmSync(join(renamed, "volumes/jj-test-task-task_1.tar"));
    rmSync(join(renamed, "volumes/jj-test-task-task_1.labels"));
    tamper(
      renamed,
      "manifest.json",
      readFileSync(join(renamed, "manifest.json"), "utf8").replace(
        '"jj-test-task-task_1"',
        '"jj-test_jj_postgres"',
      ),
    );
    writeFileSync(
      join(renamed, "SHA256SUMS"),
      readFileSync(join(renamed, "SHA256SUMS"), "utf8").replaceAll(
        "jj-test-task-task_1",
        "jj-test_jj_postgres",
      ),
    );
    result = target.run("restore.sh", [renamed]);
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "jj-test_jj_postgres is not a workspace volume of the namespace jj-test",
    );

    // Labels that are not the driver's.
    const relabelled = join(temp("jj-backup-"), "relabelled");
    cpSync(dir, relabelled, { recursive: true });
    tamper(
      relabelled,
      "volumes/jj-test-task-task_1.labels",
      `${driverLabels("jj-test", "task", "task_1")}extra=1\n`,
    );
    result = target.run("restore.sh", [relabelled]);
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "the labels of jj-test-task-task_1 are not the docker driver's",
    );

    // A volume of the workspace's name that is not one of the stack's workspaces.
    target.volume("jj-test-task-task_1", "", "SOMEONE ELSE'S");
    result = target.run("restore.sh", [dir]);
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "a volume named jj-test-task-task_1 exists outside the namespace jj-test's workspaces",
    );

    expect(target.volumeData("jj-test_jj_postgres")).toBe("PG_DATA");
    expect(target.volumeData("jj-test-task-task_1")).toBe("SOMEONE ELSE'S");
    expect(target.events()).not.toMatch(NOTHING_CHANGED);
  });

  it("reports a restore check that cannot read the database as such, not as a newer schema", () => {
    const dir = backupOf(withTaskWorkspace(), join(temp("jj-backup-"), "b"));
    const target = stack({ check: EMPTY });
    writeFileSync(target.file("fail_after_restore"), "");
    const result = target.run("restore.sh", [dir]);
    expect(result.status).toBe(1);
    expect(result.output).toContain(
      "the restore check could not read the restored database",
    );
    expect(result.output).not.toContain("this build cannot run");

    const newer = stack({ check: EMPTY });
    writeFileSync(
      newer.file("after_restore.env"),
      checkEnv({ schema_state: "newer", schema_newer: 1 }),
    );
    const refused = newer.run("restore.sh", [dir]);
    expect(refused.status).toBe(1);
    expect(refused.output).toContain(
      "this build cannot run the restored database",
    );
  });
});
