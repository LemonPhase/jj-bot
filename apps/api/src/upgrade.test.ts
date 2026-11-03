// Safe upgrades through the whole server: the previous release's database
// boots on this build and serves every record it holds, through the current
// contract, and its finished task can be continued; a database a newer
// version wrote stops the server at boot with a message that says so.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  botMemorySchema,
  type TaskView,
  taskEventSchema,
  taskViewSchema,
} from "@jj/contracts";
import { openDatabase, shippedMigrations } from "@jj/db";
import { PREVIOUS_RELEASE, seedPreviousRelease } from "@jj/db/testing";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { OPEN_TIMEOUT, type TestApp, testApp, untilTask } from "./testing";

const directories: string[] = [];
afterAll(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

async function directory() {
  const path = await mkdtemp(join(tmpdir(), "jj-api-upgrade-"));
  directories.push(path);
  return path;
}

const API_DIR = fileURLToPath(new URL("..", import.meta.url));

describe(`the ${PREVIOUS_RELEASE.name} database on this build`, () => {
  let t: TestApp | undefined;
  afterAll(() => t?.dispose(), OPEN_TIMEOUT);

  it(
    "serves every bot, profile, task, event and artifact it holds, and continues its task",
    async () => {
      const path = await directory();
      await seedPreviousRelease({ mode: "pglite", path });
      t = await testApp({ database: { mode: "pglite", path } });
      const { call } = t;

      const bootstrap = await call("GET", "/api/bootstrap");
      expect(bootstrap.status).toBe(200);
      expect(
        bootstrap.body.bots.map((bot: { name: string }) => bot.name).sort(),
      ).toEqual(["Ada", "Grace", "Linus"]);
      const ada = bootstrap.body.bots.find(
        (bot: { name: string }) => bot.name === "Ada",
      );
      const memory = await call("GET", `/api/bots/${ada.id}/memory`);
      expect(botMemorySchema.parse(memory.body).text).toBe(
        "Prefer node:test; keep files small.",
      );
      const profiles = await call("GET", "/api/runtime-profiles");
      expect(profiles.body.profiles).toHaveLength(2);

      const listed = await call("GET", "/api/tasks");
      expect(listed.body.tasks).toHaveLength(3);
      let artifacts = 0;
      for (const summary of listed.body.tasks as { id: string }[]) {
        const view = await call("GET", `/api/tasks/${summary.id}`);
        expect(view.status).toBe(200);
        const parsed: TaskView = taskViewSchema.parse(view.body);
        const page = await call(
          "GET",
          `/api/tasks/${summary.id}/events?after=0&limit=500`,
        );
        expect(page.status).toBe(200);
        expect(page.body.events.length).toBe(parsed.cursor);
        for (const event of page.body.events) taskEventSchema.parse(event);
        for (const artifact of parsed.artifacts) {
          const response = await t.app.request(
            `/api/tasks/${summary.id}/artifacts/${artifact.id}/content`,
          );
          expect(response.status).toBe(200);
          const bytes = Buffer.from(await response.arrayBuffer());
          expect(createHash("sha256").update(bytes).digest("hex")).toBe(
            artifact.sha256,
          );
          artifacts += 1;
        }
      }
      expect(artifacts).toBe(5);

      // The finished task continues on this build, from the transcripts
      // that release wrote.
      const penguins = (
        listed.body.tasks as { id: string; title: string; status: string }[]
      ).find((task) => task.title === "Penguin notes");
      expect(penguins?.status).toBe("completed");
      const id = penguins?.id as string;
      const before = taskViewSchema.parse(
        (await call("GET", `/api/tasks/${id}`)).body,
      );
      const posted = await call("POST", `/api/tasks/${id}/messages`, {
        text: "One more note about king penguins, please.",
      });
      expect(posted.status).toBe(201);
      const after = await untilTask(
        t,
        id,
        (view) =>
          view.task.status === "completed" && view.cursor > before.cursor,
        "the continued task to complete",
      );
      expect(
        after.messages.some(
          (message) =>
            message.text === "One more note about king penguins, please.",
        ),
      ).toBe(true);
      const runs = (view: TaskView) =>
        view.sessions.reduce((sum, session) => sum + session.runCount, 0);
      expect(runs(after)).toBeGreaterThan(runs(before));
    },
    OPEN_TIMEOUT * 2,
  );
});

describe("a database a newer version wrote", () => {
  it(
    "stops the server at boot with a message that says so, as the data check does",
    async () => {
      const path = await directory();
      const database = await openDatabase({ mode: "pglite", path });
      const newest = shippedMigrations().at(-1);
      await database.db.execute(
        sql`insert into drizzle.__drizzle_migrations (hash, created_at) values ('from-a-newer-version', ${(newest?.when ?? 0) + 60_000})`,
      );
      await database.close();
      const env = {
        PATH: process.env.PATH,
        API_HOST: "127.0.0.1",
        API_PORT: "0",
        JJ_DATABASE_PATH: path,
        JJ_SANDBOX_DRIVERS: "local",
        JJ_ENABLE_SCRIPTED_MODEL: "true",
      };
      const boot = spawnSync(
        process.execPath,
        ["--import", "tsx", "src/index.ts"],
        { cwd: API_DIR, env, encoding: "utf8", timeout: OPEN_TIMEOUT },
      );
      expect(boot.status).toBe(1);
      expect(boot.stderr).toContain(
        `JJ Bot API failed to start: Could not open the database (PGlite at ${path}): This database was written by a newer version of JJ Bot`,
      );
      expect(boot.stderr).toContain(
        `newer than ${newest?.tag}, the newest this version knows`,
      );
      expect(boot.stdout).not.toContain("JJ Bot API at");

      const check = spawnSync(
        process.execPath,
        ["--import", "tsx", "src/data-check.ts"],
        { cwd: API_DIR, env, encoding: "utf8", timeout: OPEN_TIMEOUT },
      );
      expect(check.status).toBe(1);
      expect(check.stdout).toContain("Schema: NEWER than this build");
      expect(check.stdout).toContain("This build refuses to start on it");
    },
    OPEN_TIMEOUT * 2,
  );
});
