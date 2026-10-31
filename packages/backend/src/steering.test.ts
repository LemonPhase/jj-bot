import { claim, jobs, runs, taskGoalVersions } from "@jj/db";
import { LocalSandboxDriver } from "@jj/sandbox";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDriverRegistry } from "./drivers";
import { DomainError } from "./errors";
import { type Brain, said } from "./testing/fake-executor";
import {
  countingDriver,
  OPEN_TIMEOUT,
  openTestDatabase,
  type TestDatabase,
  type TestEngine,
  testEngine,
  until,
  untilTask,
} from "./testing/harness";
import { createTeam, lastResult, writingWorker } from "./testing/scenarios";

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

const status = (value: string) => (view: { task: { status: string } }) =>
  view.task.status === value;

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DomainError);
  return error as DomainError;
}

describe("steering", () => {
  it("injects steering into a running session, which changes what it does next", async () => {
    const { engine, executor } = await setup();
    const team = await createTeam(engine, ["Ada"]);
    const [ada] = team.names as [string];
    executor.brain(ada, (view) => {
      switch (said.turns(view)) {
        case 0:
          return {
            calls: [{ name: "bash", args: { command: "echo v1 > out.txt" } }],
          };
        case 1:
          return { calls: [{ name: "gate", args: { name: "steer" } }] };
        case 2: {
          const version = said.heard(view, "Message from the user:\nuse v2")
            ? "v2"
            : "v1-final";
          return {
            calls: [
              { name: "bash", args: { command: `echo ${version} > out.txt` } },
            ],
          };
        }
        default:
          return lastResult(view)?.name === "complete_task"
            ? { text: "done" }
            : {
                calls: [{ name: "complete_task", args: { result: "written" } }],
              };
      }
    });
    const { task } = await engine.tasks.create({
      goal: "Write out.txt",
      coordinatorBotId: team.byName[ada] as string,
    });
    await executor.gate("steer").reached;
    const { message } = await engine.tasks.postMessage(task.id, {
      text: "use v2",
    });
    expect(message).toMatchObject({
      intent: "steering",
      authorKind: "user",
      recipientBotIds: [team.byName[ada]],
    });
    const steered = await engine.tasks.get(task.id);
    expect(
      steered.events.find((e) => e.type === "steering.received")?.payload,
    ).toEqual({
      messageId: message.id,
      goalVersion: 1,
      delivered: "injected",
    });
    executor.gate("steer").open();
    const view = await untilTask(engine, task.id, status("completed"));
    expect(executor.executed.map((entry) => entry.command)).toEqual([
      "echo v1 > out.txt",
      "echo v2 > out.txt",
    ]);
    // One session, one run, one executor call: steering did not restart anything.
    expect(view.sessions).toHaveLength(1);
    expect(view.sessions[0]?.runCount).toBe(1);
    expect(
      executor.inputs.filter(
        (input) => input.sessionId === view.sessions[0]?.id,
      ),
    ).toHaveLength(1);
    const file = view.artifacts.find((a) => a.path === "out.txt");
    const content = await engine.tasks.artifactContent(
      task.id,
      file?.id as string,
    );
    expect(Buffer.from(content.content).toString()).toBe("v2\n");
  });

  it("versions goal changes, refuses stale edits and stale completion", async () => {
    const { engine, executor } = await setup({
      config: { maxGoalVersions: 2 },
    });
    const team = await createTeam(engine, ["Ada"]);
    const [ada] = team.names as [string];
    executor.brain(ada, (view) => {
      if (said.turns(view) === 0)
        return {
          calls: [
            { name: "gate", args: { name: "goal" } },
            { name: "complete_task", args: { result: "old goal done" } },
          ],
        };
      if (
        lastResult(view)?.name === "complete_task" &&
        !lastResult(view)?.isError
      )
        return { text: "done" };
      return {
        calls: [{ name: "complete_task", args: { result: "new goal done" } }],
      };
    });
    const { task } = await engine.tasks.create({
      goal: "Old goal",
      coordinatorBotId: team.byName[ada] as string,
    });
    await executor.gate("goal").reached;
    const stale = await refusal(
      engine.tasks.postMessage(task.id, {
        text: "x",
        goal: "New goal",
        observedGoalVersion: 2,
      }),
    );
    expect(stale.code).toBe("STALE_GOAL_VERSION");
    await engine.tasks.postMessage(task.id, {
      text: "Change of plan",
      goal: "New goal",
      observedGoalVersion: 1,
    });
    executor.gate("goal").open();
    const view = await untilTask(engine, task.id, status("completed"));
    expect(view.task).toMatchObject({
      goal: "New goal",
      goalVersion: 2,
      result: "new goal done",
    });
    expect(view.sessions[0]?.goalVersion).toBe(2);
    // The view drops output previews; the event page has them.
    const page = await engine.tasks.events(task.id);
    const completions = page.events.filter(
      (e) => e.type === "tool.finished" && e.payload.tool === "complete_task",
    );
    expect(
      completions.map((e) => e.type === "tool.finished" && e.payload.ok),
    ).toEqual([false, true]);
    const refused = completions[0];
    expect(
      refused?.type === "tool.finished" ? refused.payload.output : "",
    ).toContain("The goal changed to version 2");
    expect(
      view.events.find((e) => e.type === "task.goal_changed")?.payload,
    ).toEqual({
      goal: "New goal",
      goalVersion: 2,
    });
    const versions = await db.database.db
      .select()
      .from(taskGoalVersions)
      .where(eq(taskGoalVersions.taskId, task.id));
    expect(versions.map((row) => [row.version, row.goal, row.author])).toEqual([
      [1, "Old goal", "user"],
      [2, "New goal", "user"],
    ]);
    const budget = await refusal(
      engine.tasks.postMessage(task.id, {
        text: "again",
        goal: "Third goal",
        observedGoalVersion: 2,
      }),
    );
    expect(budget.code).toBe("GOAL_VERSION_BUDGET");
    const plan = await refusal(
      engine.tasks.postMessage(task.id, {
        text: "verify",
        verificationPlan: [
          { id: "c1", description: "d", method: "m", expectedEvidence: "e" },
        ],
      }),
    );
    expect(plan.code).toBe("VERIFICATION_UNAVAILABLE");
  });
});

describe("stop", () => {
  it("stops running work, records what was interrupted and never launches queued work", async () => {
    const counting = countingDriver(
      new LocalSandboxDriver({ killGraceMs: 200 }),
    );
    const { engine, executor } = await setup({
      config: { concurrency: 2 },
      registry: createDriverRegistry([
        { driver: counting.driver, label: "Local" },
      ]),
    });
    const team = await createTeam(engine, ["Ada", "Bob", "Cy", "Dee"]);
    const [ada, bob, cy, dee] = team.names as [string, string, string, string];
    executor
      .brain(ada, (view) =>
        said.turns(view) === 0
          ? {
              calls: [bob, cy, dee].map((bot) => ({
                name: "delegate",
                args: { bot, brief: `part for ${bot}` },
              })),
            }
          : { text: "waiting" },
      )
      .brain(bob, (view) =>
        said.turns(view) === 0
          ? {
              calls: [
                { name: "bash", args: { command: "echo done > bob.txt" } },
              ],
            }
          : { calls: [{ name: "bash", args: { command: "sleep 30" } }] },
      )
      .brain(cy, () => ({ calls: [{ name: "gate", args: { name: "cy" } }] }))
      .brain(dee, writingWorker(dee));
    const { task } = await engine.tasks.create({
      goal: "Stop me",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    await executor.gate("cy").reached;
    await untilTask(
      engine,
      task.id,
      (view) =>
        view.events.some(
          (e) => e.type === "tool.started" && e.payload.summary === "sleep 30",
        ) &&
        view.sessions.find((s) => s.parentSessionId === null)?.status ===
          "waiting",
      "the sleep to start",
    );
    const before = await engine.tasks.get(task.id);
    const deeSession = before.sessions.find(
      (s) => s.botId === team.byName[dee],
    );
    expect(deeSession?.status).toBe("queued");

    const { task: stopping } = await engine.tasks.stop(task.id, {
      reason: "changed my mind",
    });
    expect(stopping.cancelRequestedAt).not.toBeNull();
    expect(stopping.cancelReason).toBe("changed my mind");
    const terminal = await refusal(
      engine.tasks.postMessage(task.id, { text: "more" }),
    );
    expect(terminal.code).toBe("TASK_TERMINAL");

    const view = await untilTask(engine, task.id, status("cancelled"));
    const completed = view.events.find(
      (e) => e.type === "cancellation.completed",
    );
    const bobSession = view.sessions.find((s) => s.botId === team.byName[bob]);
    const cySession = view.sessions.find((s) => s.botId === team.byName[cy]);
    expect(completed?.payload).toEqual({
      stopped: expect.arrayContaining([
        {
          sessionId: bobSession?.id,
          botId: team.byName[bob],
          interrupted: "yes",
          command: "sleep 30",
        },
        {
          sessionId: cySession?.id,
          botId: team.byName[cy],
          interrupted: "yes",
          command: "cy",
        },
      ]),
      neverStarted: [deeSession?.id],
    });
    expect(
      completed?.type === "cancellation.completed" && completed.payload.stopped,
    ).toHaveLength(2);
    // The command that finished before the stop is recorded as not interrupted.
    expect(
      view.events.find(
        (e) =>
          e.type === "tool.finished" &&
          e.payload.summary === "echo done > bob.txt",
      )?.payload,
    ).toMatchObject({ ok: true, interrupted: "no" });
    expect(view.sessions.every((s) => s.status === "cancelled")).toBe(true);
    const requested = view.events.find(
      (e) => e.type === "cancellation.requested",
    );
    expect(requested?.payload).toEqual({ reason: "changed my mind" });
    expect(
      view.events.filter(
        (e) =>
          e.type === "run.started" && e.sequence > (requested?.sequence ?? 0),
      ),
    ).toEqual([]);
    expect(executor.executed.some((entry) => entry.bot === dee)).toBe(false);
    expect(view.events.at(-1)).toMatchObject({
      type: "task.finished",
      payload: { status: "cancelled" },
    });
    await until(() => counting.counts.released === counting.counts.acquired, {
      what: "the sandbox to be released",
    });
    expect(counting.counts.acquired).toBe(1);
    // Stop is idempotent once cancelled; finished tasks have nothing to stop.
    expect((await engine.tasks.stop(task.id)).task.status).toBe("cancelled");
  });

  it("completes at once when nothing runs, and refuses a finished task", async () => {
    const { engine, executor } = await setup();
    const team = await createTeam(engine, ["Ada"]);
    const [ada] = team.names as [string];
    executor.brain(ada, (view) =>
      said.heard(view, "Message from the user:")
        ? lastResult(view)?.name === "complete_task"
          ? { text: "ok" }
          : { calls: [{ name: "complete_task", args: { result: "r" } }] }
        : { text: "Question?" },
    );
    const { task } = await engine.tasks.create({
      goal: "Ask",
      coordinatorBotId: team.byName[ada] as string,
    });
    await untilTask(engine, task.id, status("waiting"));
    const { task: stopped } = await engine.tasks.stop(task.id, {});
    expect(stopped.status).toBe("cancelled");
    const view = await engine.tasks.get(task.id);
    expect(
      view.events.find((e) => e.type === "cancellation.completed")?.payload,
    ).toEqual({
      stopped: [],
      neverStarted: [],
    });
    const { task: other } = await engine.tasks.create({
      goal: "Ask",
      coordinatorBotId: team.byName[ada] as string,
    });
    await untilTask(engine, other.id, status("waiting"));
    await engine.tasks.postMessage(other.id, { text: "go" });
    await untilTask(engine, other.id, status("completed"));
    expect((await refusal(engine.tasks.stop(other.id))).code).toBe("CONFLICT");
  });

  it("never launches a job that was claimed before the stop", async () => {
    const { engine, executor } = await setup({
      start: false,
      config: { leaseMs: 300 },
    });
    const team = await createTeam(engine, ["Ada"]);
    const [ada] = team.names as [string];
    executor.brain(ada, () => ({ text: "should not run" }));
    const { task } = await engine.tasks.create({
      goal: "Race",
      coordinatorBotId: team.byName[ada] as string,
    });
    // Another worker claims the job and then dies before starting the run.
    const claimed = await claim(db.database.db, "ghost", 1, 50);
    expect(claimed.jobs.map((job) => job.taskId)).toContain(task.id);
    const { task: stopped } = await engine.tasks.stop(task.id);
    expect(stopped.status).toBe("cancelled");
    await engine.worker.start();
    // The worker reclaims the expired lease and the launch guard completes the job.
    await until(
      async () => {
        const rows = await db.database.db
          .select()
          .from(jobs)
          .where(eq(jobs.taskId, task.id));
        return (
          rows.length === 1 &&
          rows[0]?.status === "done" &&
          rows[0].attempts === 2
        );
      },
      { what: "the reclaimed job to finish" },
    );
    const view = await engine.tasks.get(task.id);
    expect(view.events.filter((e) => e.type === "run.started")).toEqual([]);
    expect(
      await db.database.db.select().from(runs).where(eq(runs.taskId, task.id)),
    ).toEqual([]);
    expect(executor.inputs).toEqual([]);
  });
});
