import {
  applyTaskEvent,
  type TaskEvent,
  type TaskView,
  taskEventPageSchema,
  taskEventSchema,
  taskViewSchema,
} from "@jj/contracts";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { said } from "./testing/fake-executor";
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
let current: TestEngine | undefined;

beforeAll(async () => {
  db = await openTestDatabase();
}, OPEN_TIMEOUT);
afterEach(async () => {
  await current?.dispose();
  current = undefined;
});
afterAll(async () => {
  await db?.close();
});

async function setup(options: Parameters<typeof testEngine>[1] = {}) {
  current = await testEngine(db.database, options);
  return current;
}

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
