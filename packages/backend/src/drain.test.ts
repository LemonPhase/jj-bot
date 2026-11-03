// A worker's graceful drain: it claims nothing more, lets running sessions
// reach a turn boundary and hands them back there, and interrupts what still
// runs at the timeout as a lost lease does, so the next worker resumes it
// exactly as it would after a crash.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskEvent } from "@jj/contracts";
import { jobs, runs } from "@jj/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Brain, type FakeMessage, said } from "./testing/fake-executor";
import {
  OPEN_TIMEOUT,
  openTestDatabase,
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

/** Workers over one database and one workspace root, as across a restart. */
async function worker(options: Parameters<typeof testEngine>[1] = {}) {
  root ??= await mkdtemp(join(tmpdir(), "jj-drain-"));
  const engine = await testEngine(db.database, {
    workspaceRoot: root,
    ...options,
  });
  engines.push(engine);
  return engine;
}

const status = (value: string) => (view: { task: { status: string } }) =>
  view.task.status === value;

/** Resolves `drain` and reports whether it has settled, without waiting on it. */
function watch(drain: Promise<void>) {
  const state = { settled: false };
  void drain.then(() => {
    state.settled = true;
  });
  return state;
}

/** A gated call, then complete_task once it is answered. */
const gatedThenComplete =
  (gate: string): Brain =>
  (view) => {
    if (said.turns(view) === 0)
      return { calls: [{ name: "gate", args: { name: gate } }] };
    return lastResult(view)?.name === "complete_task"
      ? { text: "done" }
      : { calls: [{ name: "complete_task", args: { result: "resumed" } }] };
  };

async function runRows(taskId: string) {
  return db.database.db
    .select()
    .from(runs)
    .where(eq(runs.taskId, taskId))
    .orderBy(asc(runs.number));
}

async function jobRows(taskId: string) {
  return db.database.db
    .select({
      status: jobs.status,
      attempts: jobs.attempts,
      expired: sql<boolean>`${jobs.leaseUntil} < now()`,
    })
    .from(jobs)
    .where(eq(jobs.taskId, taskId));
}

describe("draining a worker", () => {
  it("lets a run mid-turn finish its turn, hands it back at the boundary, then stops", async () => {
    const first = await worker();
    const team = await createTeam(first.engine, ["Ada"]);
    const [ada] = team.names as [string];
    first.executor.brain(ada, gatedThenComplete("hold"));
    const { task } = await first.engine.tasks.create({
      goal: "Finish the turn",
      coordinatorBotId: team.byName[ada] as string,
    });
    await first.executor.gate("hold").reached;

    const drain = watch(first.engine.worker.drain(30_000));
    expect(first.engine.worker.draining).toBe(true);
    expect(first.engine.worker.lastPollAt).toBeNull();
    // Mid-turn, the run holds the drain up.
    await sleep(300);
    expect(drain.settled).toBe(false);
    expect(first.engine.worker.activeJobs).toBe(1);
    first.executor.gate("hold").open();
    const started = Date.now();
    await until(() => drain.settled, { what: "the drain" });
    // At the boundary, not at the timeout.
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(first.engine.worker.draining).toBe(false);
    expect(first.engine.worker.activeJobs).toBe(0);

    const handed = await first.engine.tasks.get(task.id);
    // The turn finished: its call ran to its end, and no further model call started.
    expect(
      handed.events.find(
        (e) => e.type === "tool.finished" && e.payload.tool === "gate",
      )?.payload,
    ).toMatchObject({ ok: true });
    expect(
      handed.events.filter((e) => e.type === "model.started"),
    ).toHaveLength(1);
    expect(first.executor.inputs).toHaveLength(1);
    expect(handed.sessions[0]?.status).toBe("queued");
    expect(
      handed.events.filter((e) => e.type === "run.finished").at(-1)?.payload,
    ).toEqual({
      outcome: "cancelled",
      error:
        "The worker stopped; the session resumes from its last completed turn.",
    });

    const second = await worker();
    second.executor.brain(ada, gatedThenComplete("hold"));
    const view = await untilTask(second.engine, task.id, status("completed"));
    expect(view.task.result).toBe("resumed");
    expect(
      view.events.filter((e) => e.type === "run.started").map((e) => e.payload),
    ).toEqual([{ reason: "start" }, { reason: "recovery" }]);
    // The resumed session sees the gate's own result, nothing interrupted.
    const resumed = second.executor.inputs[0]?.transcript as FakeMessage[];
    expect(
      resumed
        .filter((entry) => entry.role === "tool")
        .map((entry) => entry.text),
    ).toEqual(["passed hold"]);
  });

  it("claims no new job while it drains", async () => {
    const first = await worker();
    const team = await createTeam(first.engine, ["Ada", "Bea"]);
    const [ada, bea] = team.names as [string, string];
    first.executor.brain(ada, gatedThenComplete("busy"));
    first.executor.brain(bea, gatedThenComplete("never"));
    const { task: busy } = await first.engine.tasks.create({
      goal: "Keep the worker busy",
      coordinatorBotId: team.byName[ada] as string,
    });
    await first.executor.gate("busy").reached;
    const drain = watch(first.engine.worker.drain(30_000));

    // Created while draining: its wake and the polls claim nothing.
    const { task: late } = await first.engine.tasks.create({
      goal: "Arrive during the drain",
      coordinatorBotId: team.byName[bea] as string,
    });
    await sleep(500);
    expect(await jobRows(late.id)).toEqual([
      { status: "queued", attempts: 0, expired: null },
    ]);
    expect(first.executor.inputs).toHaveLength(1);

    first.executor.gate("busy").open();
    await until(() => drain.settled, { what: "the drain" });
    expect(await jobRows(late.id)).toEqual([
      { status: "queued", attempts: 0, expired: null },
    ]);

    // The next worker takes both.
    const second = await worker();
    second.executor.brain(ada, gatedThenComplete("busy"));
    second.executor.brain(bea, (view) =>
      lastResult(view)?.name === "complete_task"
        ? { text: "done" }
        : { calls: [{ name: "complete_task", args: { result: "late" } }] },
    );
    await untilTask(second.engine, busy.id, status("completed"));
    const view = await untilTask(second.engine, late.id, status("completed"));
    expect(view.task.result).toBe("late");
  });

  it("still applies a stop request while it drains", async () => {
    const first = await worker();
    const team = await createTeam(first.engine, ["Ada"]);
    const [ada] = team.names as [string];
    first.executor.brain(ada, gatedThenComplete("stopped"));
    const { task } = await first.engine.tasks.create({
      goal: "Stopped while draining",
      coordinatorBotId: team.byName[ada] as string,
    });
    await first.executor.gate("stopped").reached;
    const drain = watch(first.engine.worker.drain(30_000));
    await first.engine.tasks.stop(task.id);
    await until(() => drain.settled, { what: "the drain" });
    const view = await first.engine.tasks.get(task.id);
    expect(view.task.status).toBe("cancelled");
  });

  it("lets a run whose model ended its turn end as it would have", async () => {
    const first = await worker();
    const team = await createTeam(first.engine, ["Ada"]);
    const [ada] = team.names as [string];
    let answer = () => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    let thinking = () => {};
    const thought = new Promise<void>((resolve) => {
      thinking = resolve;
    });
    first.executor.brain(ada, async () => {
      thinking();
      await answered;
      return { text: "Which colour do you want?" };
    });
    const { task } = await first.engine.tasks.create({
      goal: "Ask first",
      coordinatorBotId: team.byName[ada] as string,
    });
    await thought;
    const drain = watch(first.engine.worker.drain(30_000));
    answer();
    await until(() => drain.settled, { what: "the drain" });
    // Not handed back: the turn's end is the run's end, as without a drain.
    const view = await first.engine.tasks.get(task.id);
    expect(view.task.status).toBe("waiting");
    expect(
      view.events
        .filter((e) => e.type === "run.finished")
        .map((e) => e.payload),
    ).toEqual([{ outcome: "waiting" }]);
    expect(await jobRows(task.id)).toEqual([
      { status: "done", attempts: 1, expired: null },
    ]);
  });

  it("hands back a run whose ended turn has steering waiting, for the next worker to continue", async () => {
    const first = await worker();
    const team = await createTeam(first.engine, ["Ada"]);
    const [ada] = team.names as [string];
    let answer = () => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    let thinking = () => {};
    const thought = new Promise<void>((resolve) => {
      thinking = resolve;
    });
    const brain: Brain = async (view) => {
      if (said.turns(view) === 0) {
        thinking();
        await answered;
        return { text: "Working on it." };
      }
      if (lastResult(view)?.name === "complete_task") return { text: "done" };
      return said.heard(view, "use blue")
        ? { calls: [{ name: "complete_task", args: { result: "blue" } }] }
        : { text: "No steering seen." };
    };
    first.executor.brain(ada, brain);
    const { task } = await first.engine.tasks.create({
      goal: "Paint it",
      coordinatorBotId: team.byName[ada] as string,
    });
    await thought;
    const drain = watch(first.engine.worker.drain(30_000));
    await first.engine.tasks.postMessage(task.id, { text: "use blue" });
    answer();
    await until(() => drain.settled, { what: "the drain" });
    const handed = await first.engine.tasks.get(task.id);
    expect(
      handed.events.filter((e) => e.type === "run.finished").at(-1)?.payload,
    ).toMatchObject({ outcome: "cancelled" });
    expect(first.executor.inputs).toHaveLength(1);

    const second = await worker();
    second.executor.brain(ada, brain);
    const view = await untilTask(second.engine, task.id, status("completed"));
    expect(view.task.result).toBe("blue");
    expect(second.executor.inputs[0]?.inputs.join("\n")).toContain("use blue");
  });
});

/** echo once, then a long command (where the stop lands), then read back and complete. */
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

/** What a task's record says happened, without ids or times. */
const story = (events: TaskEvent[]) =>
  events.flatMap((event) => {
    const p = event.payload as Record<string, unknown>;
    switch (event.type) {
      case "run.started":
        return [`run.started ${p.reason}`];
      case "run.finished":
        return [`run.finished ${p.outcome} ${p.error ?? ""}`.trim()];
      case "tool.started":
        return [`tool.started ${p.summary}`];
      case "tool.finished":
        return [`tool.finished ${p.summary} ok=${p.ok} ${p.interrupted ?? ""}`];
      case "model.started":
      case "task.finished":
        return [event.type];
      default:
        return [];
    }
  });

/**
 * Stops a worker mid-command with `stop`, then resumes the task on a new
 * worker, and returns what happened to it.
 */
async function interruptAndResume(
  stop: (first: TestEngine, taskId: string) => Promise<void>,
) {
  // A lease far longer than the test: only an expired one is reclaimed in time.
  const first = await worker({ config: { leaseMs: 120_000 } });
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
  await stop(first, task.id);

  // Nothing of the cut-off run was written: it is still running, on a lease
  // that has run out, for the next worker to find.
  const left = await first.engine.tasks.get(task.id);
  expect(left.sessions[0]?.status).toBe("running");
  expect(left.events.filter((e) => e.type === "run.finished")).toEqual([]);
  expect((await runRows(task.id)).map((run) => run.status)).toEqual([
    "running",
  ]);
  expect(await jobRows(task.id)).toEqual([
    { status: "running", attempts: 1, expired: true },
  ]);

  const second = await worker({ config: { leaseMs: 120_000 } });
  second.executor.brain(ada, resumable);
  const view = await untilTask(
    second.engine,
    task.id,
    status("completed"),
    "the resumed task",
    20_000,
  );
  return {
    result: view.task.result,
    story: story((await second.engine.tasks.events(task.id)).events),
    runs: (await runRows(task.id)).map((run) => [
      run.number,
      run.reason,
      run.status,
    ]),
    firstRan: first.executor.executed.map((entry) => entry.command),
    secondRan: second.executor.executed.map((entry) => entry.command),
    resumedResults: (
      second.executor.inputs[0]?.transcript as FakeMessage[]
    ).flatMap((entry) => (entry.role === "tool" ? [entry.text] : [])),
  };
}

describe("a run still going when the drain times out", () => {
  it("is interrupted as a lost lease is, and resumes after a restart exactly as one", async () => {
    let drainMs = 0;
    const drained = await interruptAndResume(async (first) => {
      const started = Date.now();
      await first.engine.worker.drain(300);
      drainMs = Date.now() - started;
    });
    // The drain waited for the timeout, then stopped at once.
    expect(drainMs).toBeGreaterThanOrEqual(300);
    expect(drainMs).toBeLessThan(10_000);
    for (const engine of engines.splice(0).reverse()) await engine.dispose();

    // The same task losing its lease: the worker dies and its lease runs out.
    const lost = await interruptAndResume(async (first, taskId) => {
      await first.engine.worker.abandon();
      await db.database.db
        .update(jobs)
        .set({ leaseUntil: sql`now() - interval '1 second'` })
        .where(and(eq(jobs.taskId, taskId), eq(jobs.status, "running")));
    });

    expect(drained).toEqual(lost);
    expect(drained.result).toBe("count: one");
    expect(drained.runs).toEqual([
      [1, "start", "failed"],
      [2, "recovery", "completed"],
    ]);
    expect(drained.story).toContain(
      "run.finished failed Interrupted by a worker restart; the session resumes from its last completed turn.",
    );
    expect(drained.story).toContain("tool.finished sleep 30 ok=false unknown");
    // The command cut off is reported as such and never run again.
    expect(drained.firstRan).toEqual(["echo one >> count.txt", "sleep 30"]);
    expect(drained.secondRan).toEqual(["cat count.txt"]);
    expect(drained.resumedResults).toEqual(["exit 0"]);
  }, 60_000);
});
