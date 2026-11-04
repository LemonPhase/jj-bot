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
  applyTaskEvent,
  botMemorySchema,
  type TaskEvent,
  type TaskView,
  taskEventSchema,
  taskViewSchema,
} from "@jj/contracts";
import { openDatabase, shippedMigrations } from "@jj/db";
import { PREVIOUS_RELEASE, seedPreviousRelease } from "@jj/db/testing";
import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { readDataReport } from "./data-report";
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

  it(
    "compacts its finished tasks, whose records and folded views stay the same",
    async () => {
      const path = await directory();
      await seedPreviousRelease({ mode: "pglite", path });
      const setting = { mode: "pglite" as const, path };
      const before = await readDataReport(setting, {});
      const upgraded = await testApp({
        startWorker: false,
        database: { mode: "pglite", path },
      });
      const compacted: string[] = [];
      try {
        const { call } = upgraded;
        const listed = (await call("GET", "/api/tasks")).body.tasks as {
          id: string;
          status: string;
        }[];
        const views = new Map<string, TaskView>();
        const logs = new Map<string, TaskEvent[]>();
        for (const { id } of listed) {
          views.set(
            id,
            taskViewSchema.parse((await call("GET", `/api/tasks/${id}`)).body),
          );
          logs.set(
            id,
            (await call("GET", `/api/tasks/${id}/events?after=0&limit=500`))
              .body.events,
          );
        }
        const pass = await upgraded.engine.maintenance.compactEvents({
          finishedBefore: new Date(Date.now() + 60_000),
        });
        compacted.push(...pass.tasks.map((done) => done.taskId));
        // Its completed task is compacted; whatever it holds, nothing breaks.
        const done = listed.filter((task) => task.status === "completed");
        expect(done.length).toBeGreaterThan(0);
        for (const task of done) expect(compacted).toContain(task.id);
        for (const id of compacted) {
          const view = taskViewSchema.parse(
            (await call("GET", `/api/tasks/${id}`)).body,
          );
          const was = views.get(id) as TaskView;
          const recordsOf = ({
            events: _events,
            firstSequence: _first,
            hasEarlier: _earlier,
            cursor: _cursor,
            compactedThrough: _through,
            ...rest
          }: TaskView) => rest;
          expect(recordsOf(view)).toEqual(recordsOf(was));
          expect(view.compactedThrough).toBe(was.cursor);
          // A client holding the old view folds the kept events into the new one.
          const kept = (
            await call("GET", `/api/tasks/${id}/events?after=0&limit=500`)
          ).body.events as TaskEvent[];
          expect(kept.length).toBeLessThan((logs.get(id) ?? []).length);
          const folded = kept.reduce(applyTaskEvent, was);
          expect(recordsOf(folded)).toEqual(recordsOf(view));
          expect(folded.compactedThrough).toBe(view.compactedThrough);
        }
      } finally {
        await upgraded.dispose();
      }
      const after = await readDataReport(setting, {});
      expect(after.records?.events).toBeLessThan(
        before.records?.events as number,
      );
      expect(after.records?.eventBytes).toBeLessThan(
        before.records?.eventBytes as number,
      );
      expect(after.records?.compactedTasks).toBe(compacted.length);
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
