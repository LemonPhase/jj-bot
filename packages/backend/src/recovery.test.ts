import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claim, jobs, runs } from "@jj/db";
import { LocalSandboxDriver } from "@jj/sandbox";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDriverRegistry } from "./drivers";
import type { EngineDriver } from "./ports";
import { type Brain, said } from "./testing/fake-executor";
import {
  OPEN_TIMEOUT,
  openTestDatabase,
  quietLogger,
  sleep,
  type TestDatabase,
  type TestEngine,
  testEngine,
  until,
  untilTask,
} from "./testing/harness";
import { createTeam, lastResult } from "./testing/scenarios";

let db: TestDatabase;
const engines: TestEngine[] = [];
let root: string;

beforeAll(async () => {
  db = await openTestDatabase();
}, OPEN_TIMEOUT);
afterEach(async () => {
  for (const engine of engines.splice(0).reverse()) await engine.dispose();
  if (root) await rm(root, { recursive: true, force: true });
});
afterAll(async () => {
  await db?.close();
});

/** Two workers over one database and one workspace root, as across a restart. */
async function worker(options: Parameters<typeof testEngine>[1] = {}) {
  root ??= await mkdtemp(join(tmpdir(), "jj-recovery-"));
  const engine = await testEngine(db.database, {
    workspaceRoot: root,
    ...options,
  });
  engines.push(engine);
  return engine;
}

const status = (value: string) => (view: { task: { status: string } }) =>
  view.task.status === value;

/** echo once, then a long command (where the crash lands), then read back and complete. */
const resumable: Brain = (view) => {
  switch (said.turns(view)) {
    case 0:
      return {
        calls: [{ name: "bash", args: { command: "echo one >> count.txt" } }],
      };
    case 1:
      return { calls: [{ name: "bash", args: { command: "sleep 30" } }] };
    case 2:
      return { calls: [{ name: "bash", args: { command: "cat count.txt" } }] };
    default:
      return lastResult(view)?.name === "complete_task"
        ? { text: "done" }
        : {
            calls: [
              {
                name: "complete_task",
                args: {
                  result: `count: ${said.results(view).at(-1)?.text.trim()}`,
                },
              },
            ],
          };
  }
};

describe("recovery", () => {
  it("resumes a killed worker's session from its last completed turn", async () => {
    const first = await worker({ config: { leaseMs: 1_000 } });
    const team = await createTeam(first.engine, ["Ada"]);
    const [ada] = team.names as [string];
    first.executor.brain(ada, resumable);
    const { task } = await first.engine.tasks.create({
      goal: "Count once",
      coordinatorBotId: team.byName[ada] as string,
    });
    await untilTask(
      first.engine,
      task.id,
      (view) =>
        view.events.some(
          (e) => e.type === "tool.started" && e.payload.summary === "sleep 30",
        ),
      "the long command",
    );
    await first.engine.worker.abandon();

    const second = await worker({ config: { leaseMs: 1_000 } });
    second.executor.brain(ada, resumable);
    const view = await untilTask(
      second.engine,
      task.id,
      status("completed"),
      "the resumed task",
      20_000,
    );
    expect(view.task.result).toBe("count: one");
    // The completed command ran once, before the crash; nothing was re-run.
    expect(first.executor.executed.map((e) => e.command)).toEqual([
      "echo one >> count.txt",
      "sleep 30",
    ]);
    expect(second.executor.executed.map((e) => e.command)).toEqual([
      "cat count.txt",
    ]);
    const runRows = await db.database.db
      .select()
      .from(runs)
      .where(eq(runs.taskId, task.id))
      .orderBy(asc(runs.number));
    expect(runRows.map((run) => [run.number, run.reason, run.status])).toEqual([
      [1, "start", "failed"],
      [2, "recovery", "completed"],
    ]);
    const page = await second.engine.tasks.events(task.id);
    const cut = page.events.find(
      (e) => e.type === "tool.finished" && e.payload.summary === "sleep 30",
    );
    expect(cut?.payload).toMatchObject({ ok: false, interrupted: "unknown" });
    expect(
      page.events.find(
        (e) => e.type === "run.finished" && e.runId === runRows[0]?.id,
      )?.payload,
    ).toMatchObject({
      outcome: "failed",
      error: expect.stringContaining("worker restart"),
    });
    // The resumed model saw the interrupted call as such.
    const resumed = second.executor.inputs[0]?.transcript as {
      role: string;
      text?: string;
    }[];
    expect(resumed.some((entry) => entry.role === "tool")).toBe(true);
    expect(view.sessions[0]?.runCount).toBe(2);
    expect(
      await readFile(
        join(second.workspaceRoot, "task", task.id, "count.txt"),
        "utf8",
      ),
    ).toBe("one\n");
  });

  it("hands running work to the next worker on a graceful stop", async () => {
    const first = await worker();
    const team = await createTeam(first.engine, ["Ada"]);
    const [ada] = team.names as [string];
    const brain: Brain = (view) => {
      switch (said.turns(view)) {
        case 0:
          return { calls: [{ name: "gate", args: { name: "hold" } }] };
        default:
          return lastResult(view)?.name === "complete_task"
            ? { text: "done" }
            : {
                calls: [{ name: "complete_task", args: { result: "resumed" } }],
              };
      }
    };
    first.executor.brain(ada, brain);
    const { task } = await first.engine.tasks.create({
      goal: "Hand off",
      coordinatorBotId: team.byName[ada] as string,
    });
    await first.executor.gate("hold").reached;
    await first.engine.worker.stop();
    const handed = await first.engine.tasks.get(task.id);
    expect(handed.sessions[0]?.status).toBe("queued");
    expect(
      handed.events.filter((e) => e.type === "run.finished").at(-1)?.payload,
    ).toMatchObject({
      outcome: "cancelled",
      error: expect.stringContaining("resumes"),
    });
    const second = await worker();
    second.executor.brain(ada, brain);
    const view = await untilTask(second.engine, task.id, status("completed"));
    expect(view.task.result).toBe("resumed");
    expect(
      view.events.filter((e) => e.type === "run.started").map((e) => e.payload),
    ).toEqual([{ reason: "start" }, { reason: "recovery" }]);
  });

  it("fails a session visibly when its ephemeral workspace did not survive", async () => {
    const first = await worker({ config: { leaseMs: 1_000 } });
    const { profile } = await first.engine.profiles.create({
      name: "Ephemeral",
      sandbox: {
        driver: "local",
        network: { mode: "open" },
        workspace: "ephemeral",
      },
    });
    const team = await createTeam(first.engine, ["Ada"]);
    const [ada] = team.names as [string];
    await first.engine.bots.update(team.byName[ada] as string, {
      runtimeProfileId: profile.id,
    });
    first.executor.brain(ada, resumable);
    const { task } = await first.engine.tasks.create({
      goal: "Ephemeral",
      coordinatorBotId: team.byName[ada] as string,
    });
    await untilTask(
      first.engine,
      task.id,
      (view) =>
        view.events.some(
          (e) => e.type === "tool.started" && e.payload.summary === "sleep 30",
        ),
      "the long command",
    );
    await first.engine.worker.abandon();
    const second = await worker({ config: { leaseMs: 1_000 } });
    second.executor.brain(ada, resumable);
    const view = await untilTask(
      second.engine,
      task.id,
      status("failed"),
      "the failure",
      20_000,
    );
    expect(view.sessions[0]?.error).toContain(
      "ephemeral workspace did not survive",
    );
    expect(view.task.error).toContain("ephemeral workspace did not survive");
    expect(second.executor.inputs).toEqual([]);
  });

  it("fails a session whose job kept losing its lease", async () => {
    const engine = await worker({ start: false });
    const team = await createTeam(engine.engine, ["Ada"]);
    const [ada] = team.names as [string];
    engine.executor.brain(ada, () => ({ text: "never" }));
    const { task } = await engine.engine.tasks.create({
      goal: "Flaky worker",
      coordinatorBotId: team.byName[ada] as string,
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const { jobs } = await claim(db.database.db, `ghost-${attempt}`, 5, 1);
      expect(jobs.some((job) => job.taskId === task.id)).toBe(true);
      await sleep(20);
    }
    await engine.engine.worker.start();
    const view = await untilTask(engine.engine, task.id, status("failed"));
    expect(view.sessions[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("interrupted too many times"),
    });
    expect(engine.executor.inputs).toEqual([]);
  });

  it("reaps driver orphans once at start and treats a failure as a warning", async () => {
    let reaped = 0;
    const local = new LocalSandboxDriver();
    const reaping: EngineDriver = Object.assign(
      Object.create(local) as LocalSandboxDriver,
      {
        reapOrphans: async () => {
          reaped += 1;
          return { removed: ["jj-sandbox-orphan-1"] };
        },
      },
    );
    const broken: EngineDriver = {
      id: "broken",
      capabilities: local.capabilities,
      validateSpec: (spec) => local.validateSpec(spec),
      probe: async () => ({ ok: false, detail: "down" }),
      acquire: () => Promise.reject(new Error("down")),
      reapOrphans: () => Promise.reject(new Error("daemon unreachable")),
    };
    quietLogger.infos.length = 0;
    quietLogger.warnings.length = 0;
    const engine = await worker({
      registry: createDriverRegistry([
        { driver: reaping, label: "Local" },
        { driver: broken, label: "Broken" },
      ]),
    });
    expect(reaped).toBe(1);
    expect(
      quietLogger.infos.some((line) =>
        line.includes("Removed 1 orphaned local"),
      ),
    ).toBe(true);
    expect(
      quietLogger.warnings.some((line) =>
        line.includes("Reaping orphaned broken"),
      ),
    ).toBe(true);
    await engine.engine.worker.stop();
    await engine.engine.worker.start();
    expect(reaped).toBe(2);
  });

  it("stops a run that lost its lease without writing anything more", async () => {
    const engine = await worker({ config: { leaseMs: 600 } });
    const team = await createTeam(engine.engine, ["Ada"]);
    const [ada] = team.names as [string];
    engine.executor.brain(ada, (view) =>
      said.turns(view) === 0
        ? { calls: [{ name: "gate", args: { name: "stolen" } }] }
        : { text: "must not be written" },
    );
    const { task } = await engine.engine.tasks.create({
      goal: "Lose the lease",
      coordinatorBotId: team.byName[ada] as string,
    });
    await engine.executor.gate("stolen").reached;
    // Another worker takes the job over, as after a missed heartbeat.
    const stolen = await db.database.db.transaction(async (tx) => {
      await tx
        .update(jobs)
        .set({ leaseUntil: sql`now() - interval '1 second'` })
        .where(and(eq(jobs.taskId, task.id), eq(jobs.status, "running")));
      return claim(tx, "thief", 5, 60_000);
    });
    expect(stolen.jobs.map((job) => job.taskId)).toContain(task.id);
    const before = (await engine.engine.tasks.events(task.id)).cursor;
    await until(() => engine.engine.worker.activeJobs === 0, {
      what: "the run to stop",
    });
    const after = await engine.engine.tasks.events(task.id, { after: before });
    expect(after.events).toEqual([]);
    const [run] = await db.database.db
      .select()
      .from(runs)
      .where(eq(runs.taskId, task.id));
    expect(run?.status).toBe("running");
  });
});
