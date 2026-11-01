import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyTaskEvent,
  type TaskEvent,
  type TaskView,
  taskEventPageSchema,
  taskEventSchema,
  taskViewSchema,
} from "@jj/contracts";
import { jobs, runs } from "@jj/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Brain, said } from "./testing/fake-executor";
import {
  OPEN_TIMEOUT,
  openTestDatabase,
  type TestDatabase,
  type TestEngine,
  testEngine,
  until,
  untilTask,
} from "./testing/harness";
import {
  createTeam,
  delegatingCoordinator,
  lastResult,
  writingWorker,
} from "./testing/scenarios";

let db: TestDatabase;
const engines: TestEngine[] = [];
let root: string | undefined;

beforeAll(async () => {
  db = await openTestDatabase();
}, OPEN_TIMEOUT);
afterEach(async () => {
  for (const engine of engines.splice(0).reverse()) await engine.dispose();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});
afterAll(async () => {
  await db?.close();
});

async function setup(options: Parameters<typeof testEngine>[1] = {}) {
  const engine = await testEngine(db.database, options);
  engines.push(engine);
  return engine;
}

/** Workers over one database and one workspace root, as across a restart. */
async function worker(options: Parameters<typeof testEngine>[1] = {}) {
  root ??= await mkdtemp(join(tmpdir(), "jj-artifacts-"));
  return setup({ workspaceRoot: root, ...options });
}

/** The clock of a worker that resumes the work a minute later. */
const aMinuteLater = () => new Date(Date.now() + 60_000);

/** A run's reason and status. */
const runSummary = (run?: typeof runs.$inferSelect) => [
  run?.reason,
  run?.status,
];

/** The task's runs in start order. */
const runRows = (taskId: string) =>
  db.database.db
    .select()
    .from(runs)
    .where(eq(runs.taskId, taskId))
    .orderBy(asc(runs.startedAt));

/** File artifacts by path, with who they are credited to. */
const fileCredits = (view: TaskView) =>
  view.artifacts
    .filter((a) => a.kind === "file")
    .map((a) => ({ path: a.path, sessionId: a.sessionId, runId: a.runId }))
    .sort((a, b) => a.path.localeCompare(b.path));

/**
 * Writes one file with its own tool and one with bash, then waits at a gate
 * (where the stop or crash lands), then completes.
 */
const writesThenHolds: Brain = (view) => {
  switch (said.turns(view)) {
    case 0:
      return {
        calls: [
          { name: "write", args: { path: "notes.md", content: "# Notes\n" } },
          { name: "bash", args: { command: "echo built > out.txt" } },
        ],
      };
    case 1:
      return { calls: [{ name: "gate", args: { name: "hold" } }] };
    default:
      return lastResult(view)?.name === "complete_task"
        ? { text: "done" }
        : { calls: [{ name: "complete_task", args: { result: "ok" } }] };
  }
};

const completed = (view: { task: { status: string } }) =>
  view.task.status === "completed";

const completeAfter =
  (calls: { name: string; args: Record<string, unknown> }[][]) =>
  (view: Parameters<Parameters<TestEngine["executor"]["brain"]>[1]>[0]) => {
    const turn = said.turns(view);
    if (turn < calls.length) return { calls: calls[turn] };
    return lastResult(view)?.name === "complete_task"
      ? { text: "done" }
      : { calls: [{ name: "complete_task", args: { result: "ok" } }] };
  };

/** Every event of the task, paging through the event endpoint. */
async function allEvents(
  engine: TestEngine["engine"],
  taskId: string,
  after = 0,
) {
  const events: TaskEvent[] = [];
  for (let cursor = after; ; ) {
    const page = taskEventPageSchema.parse(
      await engine.tasks.events(taskId, { after: cursor, limit: 50 }),
    );
    events.push(...(page.events as TaskEvent[]));
    cursor = page.cursor;
    if (!page.hasMore) return events;
  }
}

const withoutOutput = (view: TaskView) => ({
  ...view,
  events: view.events.map((event) =>
    event.type === "tool.finished"
      ? { ...event, payload: { ...event.payload, output: undefined } }
      : event,
  ),
});

describe("artifacts", () => {
  it("stores oversized output as an artifact and keeps the event preview within the cap", async () => {
    const { engine, executor } = await setup({
      config: { outputCapBytes: 4096 },
    });
    const team = await createTeam(engine, ["Ada"]);
    const [ada] = team.names as [string];
    executor.brain(
      ada,
      completeAfter([
        [
          {
            name: "bash",
            args: { command: "head -c 100000 /dev/zero | tr '\\0' x" },
          },
        ],
        [{ name: "raw_output", args: { bytes: 70_000 } }],
      ]),
    );
    const { task } = await engine.tasks.create({
      goal: "Loud",
      coordinatorBotId: team.byName[ada] as string,
    });
    const view = await untilTask(engine, task.id, completed);
    const outputs = view.artifacts.filter((a) => a.kind === "output");
    expect(outputs).toHaveLength(2);
    const events = (await allEvents(engine, task.id)).filter(
      (e): e is Extract<TaskEvent, { type: "tool.finished" }> =>
        e.type === "tool.finished" &&
        (e.payload.tool === "bash" || e.payload.tool === "raw_output"),
    );
    for (const event of events) {
      expect(event.payload.truncated).toBe(true);
      expect(Buffer.byteLength(event.payload.output ?? "")).toBeLessThanOrEqual(
        4096,
      );
      const artifact = outputs.find((a) => a.id === event.payload.artifactId);
      expect(artifact).toBeDefined();
      const { content } = await engine.tasks.artifactContent(
        task.id,
        artifact?.id as string,
      );
      expect(content.byteLength).toBe(
        event.payload.tool === "bash" ? 100_000 : 70_000,
      );
    }
    // The runtime spilled the bash output itself; the engine spilled the raw one.
    expect(outputs.map((a) => a.path)).toEqual([
      "bash output: head -c 100000 /dev/zero | tr '\\0' x",
      "raw_output output",
    ]);
  });

  it("snapshots files a run changed as downloadable artifacts", async () => {
    const { engine, executor } = await setup();
    const team = await createTeam(engine, ["Ada", "Bob"]);
    const [ada, bob] = team.names as [string, string];
    executor
      .brain(
        ada,
        completeAfter([
          [{ name: "delegate", args: { bot: bob, brief: "write files" } }],
          [{ name: "bash", args: { command: "true" } }],
        ]),
      )
      .brain(bob, (view) => {
        if (said.turns(view) > 0) return { text: "files written" };
        return {
          calls: [
            {
              name: "write",
              args: { path: "report.md", content: "# Report\n" },
            },
            {
              name: "write",
              args: { path: "src/app.js", content: "console.log(1);\n" },
            },
            {
              name: "write",
              args: { path: "node_modules/pkg/index.js", content: "ignored" },
            },
            {
              name: "bash",
              args: { command: "printf '\\000\\001' > blob.bin" },
            },
          ],
        };
      });
    // The coordinator waits for Bob, so its delegate turn ends with the work open.
    executor.brain(ada, (view) => {
      if (said.turns(view) === 0)
        return {
          calls: [
            { name: "delegate", args: { bot: bob, brief: "write files" } },
          ],
        };
      if (!said.heard(view, `Result from ${bob} (session`))
        return { text: "waiting" };
      if (said.results(view).some((r) => r.name === "bash"))
        return lastResult(view)?.name === "complete_task"
          ? { text: "done" }
          : { calls: [{ name: "complete_task", args: { result: "ok" } }] };
      // Rewrites one file unchanged and changes another.
      return {
        calls: [
          {
            name: "bash",
            args: {
              command:
                "printf '# Report\\n' > report.md && echo 2 > src/app.js",
            },
          },
        ],
      };
    });
    const { task } = await engine.tasks.create({
      goal: "Files",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    const view = await untilTask(engine, task.id, completed);
    const files = view.artifacts.filter((a) => a.kind === "file");
    expect(files.map((a) => a.path).sort()).toEqual([
      "blob.bin",
      "report.md",
      "src/app.js",
      "src/app.js",
    ]);
    const bobSession = view.sessions.find((s) => s.botId === team.byName[bob]);
    const report = files.find((a) => a.path === "report.md");
    expect(report).toMatchObject({
      name: "report.md",
      contentType: "text/markdown; charset=utf-8",
      sessionId: bobSession?.id,
    });
    expect(files.find((a) => a.path === "blob.bin")?.contentType).toBe(
      "application/octet-stream",
    );
    const versions = files.filter((a) => a.path === "src/app.js");
    const contents = await Promise.all(
      versions.map(async (a) =>
        Buffer.from(
          (await engine.tasks.artifactContent(task.id, a.id)).content,
        ).toString(),
      ),
    );
    expect(contents).toEqual(["console.log(1);\n", "2\n"]);
    await expect(
      engine.tasks.artifactContent(task.id, "art_missing"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("leaves a running teammate's write to its own snapshot while its result is recorded", async () => {
    // The coordinator's run ends, and snapshots, between Bob's file landing
    // on disk and his call's result being recorded: under load, the window
    // a snapshot of "files a run changed" can fall into.
    const { engine, executor } = await setup();
    const team = await createTeam(engine, ["Ada", "Bob"]);
    const [ada, bob] = team.names as [string, string];
    executor
      .brain(bob, (view) =>
        said.turns(view) === 0
          ? {
              calls: [
                {
                  name: "write",
                  args: {
                    path: "report.md",
                    content: "# Report\n",
                    holdAt: "bob-wrote",
                  },
                },
              ],
            }
          : { text: "report written" },
      )
      .brain(ada, async (view) => {
        if (said.turns(view) === 0)
          return {
            calls: [{ name: "delegate", args: { bot: bob, brief: "report" } }],
          };
        if (!said.heard(view, `Result from ${bob} (session`)) {
          await executor.gate("bob-wrote").reached;
          return { text: "waiting" };
        }
        return lastResult(view)?.name === "complete_task"
          ? { text: "done" }
          : { calls: [{ name: "complete_task", args: { result: "ok" } }] };
      });
    const { task } = await engine.tasks.create({
      goal: "Report",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    const waiting = await untilTask(engine, task.id, (view) =>
      view.sessions.some(
        (s) => s.botId === team.byName[ada] && s.status === "waiting",
      ),
    );
    // Ada's snapshot saw report.md and left it to Bob.
    expect(fileCredits(waiting)).toEqual([]);
    executor.gate("bob-wrote").open();
    const view = await untilTask(engine, task.id, completed);
    const [, bobRun] = await runRows(task.id);
    expect(fileCredits(view)).toEqual([
      { path: "report.md", sessionId: bobRun?.sessionId, runId: bobRun?.id },
    ]);
  });

  it("folds snapshot + events, and snapshot + stream, into a fresh snapshot", async () => {
    const { engine, executor } = await setup();
    const team = await createTeam(engine, ["Ada", "Bob", "Cy"]);
    const [ada, bob, cy] = team.names as [string, string, string];
    executor
      .brain(ada, delegatingCoordinator([bob, cy]))
      .brain(bob, writingWorker(bob))
      .brain(cy, (view) =>
        said.turns(view) === 0
          ? {
              calls: [
                { name: "message", args: { to: ada, text: "note" } },
                { name: "bash", args: { command: "seq 3" } },
              ],
            }
          : { text: "cy done" },
      );
    const { task } = await engine.tasks.create({
      goal: "Fold",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    const initial = taskViewSchema.parse(await engine.tasks.get(task.id));
    const streamed: TaskEvent[] = [];
    const subscription = await engine.tasks.subscribe(task.id, {
      after: initial.cursor,
      onEvent: (event) => {
        streamed.push(taskEventSchema.parse(event));
      },
    });
    const fresh = taskViewSchema.parse(
      await untilTask(engine, task.id, completed),
    );
    await until(() => streamed.at(-1)?.sequence === fresh.cursor, {
      what: "the stream to catch up",
    });
    await subscription.close();

    const events = await allEvents(engine, task.id, initial.cursor);
    expect(events.map((e) => e.sequence)).toEqual(
      streamed.map((e) => e.sequence),
    );
    for (const source of [events, streamed]) {
      const folded = source.reduce(applyTaskEvent, initial);
      expect(withoutOutput(folded)).toEqual(withoutOutput(fresh));
    }
    expect(fresh.usage.total.modelCalls).toBeGreaterThan(0);
    expect(Object.keys(fresh.usage.bySession).sort()).toEqual(
      fresh.sessions.map((s) => s.id).sort(),
    );
    expect(fresh.sessions.every((s) => s.activity === null)).toBe(true);
  });
});

describe("artifacts of runs that ended without a snapshot", () => {
  it("snapshots a run a graceful stop handed back once its session resumes", async () => {
    const first = await worker();
    const team = await createTeam(first.engine, ["Ada"]);
    const [ada] = team.names as [string];
    first.executor.brain(ada, writesThenHolds);
    const { task } = await first.engine.tasks.create({
      goal: "Hand off files",
      coordinatorBotId: team.byName[ada] as string,
    });
    await first.executor.gate("hold").reached;
    await first.engine.worker.stop();
    // The stop stores nothing; the files are still in the workspace.
    expect((await first.engine.tasks.get(task.id)).artifacts).toEqual([]);

    const second = await worker({ clock: aMinuteLater });
    second.executor.brain(ada, writesThenHolds);
    const view = await untilTask(second.engine, task.id, completed);
    const [handed, resumed] = await runRows(task.id);
    expect([handed, resumed].map(runSummary)).toEqual([
      ["start", "cancelled"],
      ["recovery", "completed"],
    ]);
    expect(fileCredits(view)).toEqual([
      { path: "notes.md", sessionId: handed?.sessionId, runId: handed?.id },
      { path: "out.txt", sessionId: null, runId: null },
    ]);
  });

  it("snapshots a run a crash cut off once its session is reclaimed", async () => {
    const first = await worker({ config: { leaseMs: 1_000 } });
    const team = await createTeam(first.engine, ["Ada"]);
    const [ada] = team.names as [string];
    first.executor.brain(ada, writesThenHolds);
    const { task } = await first.engine.tasks.create({
      goal: "Crash with files",
      coordinatorBotId: team.byName[ada] as string,
    });
    await first.executor.gate("hold").reached;
    await first.engine.worker.abandon();

    const second = await worker({
      config: { leaseMs: 1_000 },
      clock: aMinuteLater,
    });
    second.executor.brain(ada, writesThenHolds);
    const view = await untilTask(
      second.engine,
      task.id,
      completed,
      "the recovered task",
      20_000,
    );
    const [crashed, recovered] = await runRows(task.id);
    expect([crashed, recovered].map(runSummary)).toEqual([
      ["start", "failed"],
      ["recovery", "completed"],
    ]);
    expect(fileCredits(view)).toEqual([
      { path: "notes.md", sessionId: crashed?.sessionId, runId: crashed?.id },
      { path: "out.txt", sessionId: null, runId: null },
    ]);
  });

  it("stores nothing twice when the resumed snapshot reaches back over a teammate's files", async () => {
    const first = await worker();
    const team = await createTeam(first.engine, ["Ada", "Bob"]);
    const [ada, bob] = team.names as [string, string];
    const coordinator: Brain = (view) => {
      switch (said.turns(view)) {
        case 0:
          return {
            calls: [
              {
                name: "write",
                args: { path: "notes.md", content: "# Notes\n" },
              },
              {
                name: "delegate",
                args: { bot: bob, brief: "write the report" },
              },
            ],
          };
        case 1:
          return { calls: [{ name: "gate", args: { name: "hold" } }] };
        default:
          if (!said.heard(view, `Result from ${bob} (session`))
            return { text: "" };
          return lastResult(view)?.name === "complete_task"
            ? { text: "done" }
            : { calls: [{ name: "complete_task", args: { result: "ok" } }] };
      }
    };
    const reporter: Brain = (view) =>
      said.turns(view) === 0
        ? {
            calls: [
              {
                name: "write",
                args: { path: "report.md", content: "# Report\n" },
              },
            ],
          }
        : { text: "report written" };
    first.executor.brain(ada, coordinator).brain(bob, reporter);
    const { task } = await first.engine.tasks.create({
      goal: "Report",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    await first.executor.gate("hold").reached;
    // Bob finishes (and stores report.md) while Ada holds; then the worker stops.
    const bobDone = await untilTask(first.engine, task.id, (view) =>
      view.sessions.some(
        (s) => s.botId === team.byName[bob] && s.status === "completed",
      ),
    );
    expect(fileCredits(bobDone).map((file) => file.path)).toEqual([
      "report.md",
    ]);
    await first.engine.worker.stop();

    const second = await worker({ clock: aMinuteLater });
    second.executor.brain(ada, coordinator).brain(bob, reporter);
    const view = await untilTask(second.engine, task.id, completed);
    const adaSession = view.sessions.find((s) => s.botId === team.byName[ada]);
    const bobSession = view.sessions.find((s) => s.botId === team.byName[bob]);
    const adaRuns = (await runRows(task.id)).filter(
      (run) => run.sessionId === adaSession?.id,
    );
    const [bobRun] = (await runRows(task.id)).filter(
      (run) => run.sessionId === bobSession?.id,
    );
    // The resumed run is a wake (Bob's result was already queued for Ada),
    // not a recovery: the pending flag, not the reason, finds the hand-back.
    expect(adaRuns.map(runSummary)).toEqual([
      ["start", "cancelled"],
      ["wake", "completed"],
    ]);
    // Ada's next run reaches back to the handed-back run's start, which also
    // covers report.md: it is already stored and keeps Bob's credit.
    expect(fileCredits(view)).toEqual([
      { path: "notes.md", sessionId: adaSession?.id, runId: adaRuns[0]?.id },
      { path: "report.md", sessionId: bobSession?.id, runId: bobRun?.id },
    ]);
  });

  it("still snapshots a run that ended normally only from its own start", async () => {
    // The first run's records are a minute in the past, so a snapshot that
    // reached back to it would see a change made between the runs.
    let skew = -60_000;
    const engine = await setup({
      clock: () => new Date(Date.now() + skew),
    });
    const team = await createTeam(engine.engine, ["Ada"]);
    const [ada] = team.names as [string];
    engine.executor.brain(ada, (view) => {
      if (!said.heard(view, "one more"))
        return said.turns(view) === 0
          ? {
              calls: [
                { name: "write", args: { path: "a.txt", content: "one\n" } },
              ],
            }
          : { text: "first pass" };
      if (!said.results(view).some((r) => r.text === "Wrote b.txt"))
        return {
          calls: [{ name: "write", args: { path: "b.txt", content: "two\n" } }],
        };
      return lastResult(view)?.name === "complete_task"
        ? { text: "done" }
        : { calls: [{ name: "complete_task", args: { result: "ok" } }] };
    });
    const { task } = await engine.engine.tasks.create({
      goal: "Two passes",
      coordinatorBotId: team.byName[ada] as string,
    });
    await untilTask(engine.engine, task.id, (view) =>
      ["waiting", "completed"].includes(view.task.status),
    );
    skew = 0;
    // Changed outside any run, before the second run's window.
    const outside = join(engine.workspaceRoot, "task", task.id, "a.txt");
    await writeFile(outside, "changed between runs\n");
    const before = new Date(Date.now() - 30_000);
    await utimes(outside, before, before);
    await engine.engine.tasks.postMessage(task.id, { text: "one more" });
    const view = await untilTask(engine.engine, task.id, completed);
    const [firstRun, secondRun] = await runRows(task.id);
    expect([firstRun, secondRun].map(runSummary)).toEqual([
      ["start", "waiting"],
      ["wake", "completed"],
    ]);
    expect(fileCredits(view)).toEqual([
      { path: "a.txt", sessionId: firstRun?.sessionId, runId: firstRun?.id },
      { path: "b.txt", sessionId: secondRun?.sessionId, runId: secondRun?.id },
    ]);
  });

  it("credits a file to the covered run that touched it last", async () => {
    const brain: Brain = (view) => {
      switch (said.turns(view)) {
        case 0:
          return {
            calls: [
              { name: "write", args: { path: "a.md", content: "a\n" } },
              { name: "write", args: { path: "b.md", content: "first\n" } },
            ],
          };
        case 1:
          return { calls: [{ name: "gate", args: { name: "hold" } }] };
        case 2:
          return {
            calls: [
              { name: "write", args: { path: "b.md", content: "second\n" } },
            ],
          };
        default:
          return lastResult(view)?.name === "complete_task"
            ? { text: "done" }
            : { calls: [{ name: "complete_task", args: { result: "ok" } }] };
      }
    };
    const first = await worker();
    const team = await createTeam(first.engine, ["Ada"]);
    const [ada] = team.names as [string];
    first.executor.brain(ada, brain);
    const { task } = await first.engine.tasks.create({
      goal: "Rewrite",
      coordinatorBotId: team.byName[ada] as string,
    });
    await first.executor.gate("hold").reached;
    await first.engine.worker.stop();
    const second = await worker({ clock: aMinuteLater });
    second.executor.brain(ada, brain);
    const view = await untilTask(second.engine, task.id, completed);
    const [handed, resumed] = await runRows(task.id);
    expect(fileCredits(view)).toEqual([
      { path: "a.md", sessionId: handed?.sessionId, runId: handed?.id },
      { path: "b.md", sessionId: resumed?.sessionId, runId: resumed?.id },
    ]);
    const b = view.artifacts.find((a) => a.path === "b.md");
    const { content } = await second.engine.tasks.artifactContent(
      task.id,
      b?.id as string,
    );
    expect(Buffer.from(content).toString()).toBe("second\n");
  });

  it("credits a teammate's write when both sessions were handed back together", async () => {
    const first = await worker();
    const team = await createTeam(first.engine, ["Ada", "Bob"]);
    const [ada, bob] = team.names as [string, string];
    const coordinator: Brain = (view) => {
      switch (said.turns(view)) {
        case 0:
          return {
            calls: [
              { name: "write", args: { path: "notes.md", content: "# N\n" } },
              { name: "delegate", args: { bot: bob, brief: "report" } },
            ],
          };
        case 1:
          return { calls: [{ name: "gate", args: { name: "hold" } }] };
        default:
          if (!said.heard(view, `Result from ${bob} (session`))
            return { text: "" };
          return lastResult(view)?.name === "complete_task"
            ? { text: "done" }
            : { calls: [{ name: "complete_task", args: { result: "ok" } }] };
      }
    };
    const reporterBefore: Brain = (view) =>
      said.turns(view) === 0
        ? {
            calls: [
              { name: "write", args: { path: "report.md", content: "# R\n" } },
            ],
          }
        : { calls: [{ name: "gate", args: { name: "bob-hold" } }] };
    // Resumed, Bob holds at a gate, so Ada's snapshot comes first.
    const reporterAfter: Brain = (view) =>
      said.results(view).some((r) => r.text === "passed bob-resumed")
        ? { text: "report written" }
        : { calls: [{ name: "gate", args: { name: "bob-resumed" } }] };
    first.executor.brain(ada, coordinator).brain(bob, reporterBefore);
    const { task } = await first.engine.tasks.create({
      goal: "Report",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    await first.executor.gate("hold").reached;
    await first.executor.gate("bob-hold").reached;
    await first.engine.worker.stop();

    const second = await worker({ clock: aMinuteLater });
    second.executor.brain(ada, coordinator).brain(bob, reporterAfter);
    await second.executor.gate("bob-resumed").reached;
    const adaWaiting = await untilTask(
      second.engine,
      task.id,
      (view) =>
        view.sessions.some(
          (s) => s.botId === team.byName[ada] && s.status === "waiting",
        ) && view.artifacts.some((a) => a.path === "notes.md"),
    );
    const [adaRun, bobRun] = await runRows(task.id);
    const credited = [
      { path: "notes.md", sessionId: adaRun?.sessionId, runId: adaRun?.id },
      { path: "report.md", sessionId: bobRun?.sessionId, runId: bobRun?.id },
    ];
    // Ada's snapshot found report.md and credited Bob's handed-back run.
    expect(fileCredits(adaWaiting)).toEqual(credited);
    second.executor.gate("bob-resumed").open();
    const view = await untilTask(second.engine, task.id, completed);
    expect(fileCredits(view)).toEqual(credited);
  });

  it("snapshots a handed-back session that never resumes when its task is stopped", async () => {
    const first = await worker();
    const team = await createTeam(first.engine, ["Ada", "Bob"]);
    const [ada, bob] = team.names as [string, string];
    const coordinator: Brain = (view) => {
      if (said.turns(view) === 0)
        return {
          calls: [{ name: "delegate", args: { bot: bob, brief: "report" } }],
        };
      if (said.heard(view, "status?") && lastResult(view)?.name !== "gate")
        return { calls: [{ name: "gate", args: { name: "ada-hold" } }] };
      return { text: "" };
    };
    const reporter: Brain = (view) =>
      said.turns(view) === 0
        ? {
            calls: [
              { name: "write", args: { path: "report.md", content: "# R\n" } },
            ],
          }
        : { calls: [{ name: "gate", args: { name: "bob-hold" } }] };
    first.executor.brain(ada, coordinator).brain(bob, reporter);
    const { task } = await first.engine.tasks.create({
      goal: "Report",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    await first.executor.gate("bob-hold").reached;
    await first.engine.worker.stop();
    const [, bobRun] = await runRows(task.id);
    // Bob's resumption is due later, so the task is stopped before it runs.
    await db.database.db
      .update(jobs)
      .set({ runAfter: sql`now() + interval '10 minutes'` })
      .where(
        and(
          eq(jobs.sessionId, bobRun?.sessionId as string),
          eq(jobs.status, "queued"),
        ),
      );

    const second = await worker({ clock: aMinuteLater });
    second.executor.brain(ada, coordinator).brain(bob, reporter);
    // Ada runs again (the run holds the task's sandbox) and is stopped there.
    await second.engine.tasks.postMessage(task.id, { text: "status?" });
    await second.executor.gate("ada-hold").reached;
    await second.engine.tasks.stop(task.id);
    const view = await untilTask(
      second.engine,
      task.id,
      (v) => v.task.status === "cancelled" && v.artifacts.length > 0,
      "the final snapshot",
    );
    expect(fileCredits(view)).toEqual([
      { path: "report.md", sessionId: bobRun?.sessionId, runId: bobRun?.id },
    ]);
    expect(
      second.executor.inputs.some(
        (input) => input.sessionId === bobRun?.sessionId,
      ),
    ).toBe(false);
  });

  it("applies the per-run file cap after skipping files already stored", async () => {
    const engine = await setup({
      config: { artifacts: { maxFilesPerRun: 2 } },
    });
    const team = await createTeam(engine.engine, ["Ada"]);
    const [ada] = team.names as [string];
    engine.executor.brain(ada, (view) => {
      if (!said.heard(view, "one more"))
        return said.turns(view) === 0
          ? {
              calls: [
                { name: "write", args: { path: "a.txt", content: "a\n" } },
                { name: "write", args: { path: "b.txt", content: "b\n" } },
              ],
            }
          : { text: "first pass" };
      if (!said.results(view).some((r) => r.text === "Wrote z/c.txt"))
        return {
          calls: [
            // Touched again but unchanged, and listed before z/.
            { name: "bash", args: { command: "touch a.txt b.txt" } },
            { name: "write", args: { path: "z/c.txt", content: "c\n" } },
          ],
        };
      return lastResult(view)?.name === "complete_task"
        ? { text: "done" }
        : { calls: [{ name: "complete_task", args: { result: "ok" } }] };
    });
    const { task } = await engine.engine.tasks.create({
      goal: "Cap",
      coordinatorBotId: team.byName[ada] as string,
    });
    await untilTask(engine.engine, task.id, (v) => v.task.status === "waiting");
    await engine.engine.tasks.postMessage(task.id, { text: "one more" });
    const view = await untilTask(engine.engine, task.id, completed);
    expect(fileCredits(view).map((file) => file.path)).toEqual([
      "a.txt",
      "b.txt",
      "z/c.txt",
    ]);
  });
});
