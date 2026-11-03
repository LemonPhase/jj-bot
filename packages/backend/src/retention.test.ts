// Event retention: which tasks a compaction pass may touch, what it deletes,
// rewrites and keeps, that every cursor still folds into the latest view, and
// that what the engine reads back (spend dedupe, gate attempts, lookups,
// continuation) is unchanged after it.
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyTaskEvent,
  emptyUsage,
  TASK_EVENT_TYPES,
  type TaskEvent,
  type TaskView,
} from "@jj/contracts";
import {
  appendEvent,
  approvals,
  type Database,
  jobs,
  openDatabase,
  runs,
  sessionEntries,
  sessions,
  taskEvents,
  tasks,
  usage,
} from "@jj/db";
import { and, count, eq, inArray, or, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Engine } from "./engine";
import { COMPACTION } from "./services/retention";
import { listTaskLog, readTaskState } from "./services/task-log";
import { type Brain, said } from "./testing/fake-executor";
import {
  OPEN_TIMEOUT,
  openTestDatabase,
  postgresUrl,
  quietLogger,
  sleep,
  type TestDatabase,
  type TestEngine,
  testEngine,
  uniqueName,
  until,
  untilTask,
} from "./testing/harness";
import { createTeam, reported, writingWorker } from "./testing/scenarios";

let db: TestDatabase;
const engines: TestEngine[] = [];
const dirs: string[] = [];

beforeAll(async () => {
  db = await openTestDatabase();
}, OPEN_TIMEOUT);
afterEach(async () => {
  for (const engine of engines.splice(0).reverse()) await engine.dispose();
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});
afterAll(async () => {
  await db?.close();
});

async function setup(
  options: Parameters<typeof testEngine>[1] = {},
  database = db.database,
) {
  const engine = await testEngine(database, options);
  engines.push(engine);
  return engine;
}

// The contract's lists, written out here rather than read from the code.
const DELETED = new Set(["model.started", "tool.started", "run.started"]);
const RECORD_OF: Record<string, (event: TaskEvent) => string> = {
  "task.updated": () => "task",
  "session.created": (event) =>
    `session:${(event.payload as { session: { id: string } }).session.id}`,
  "session.updated": (event) =>
    `session:${(event.payload as { session: { id: string } }).session.id}`,
  "approval.requested": (event) =>
    `approval:${(event.payload as { approval: { id: string } }).approval.id}`,
  "approval.updated": (event) =>
    `approval:${(event.payload as { approval: { id: string } }).approval.id}`,
};
const STRIPPED: Record<string, string> = {
  "tool.finished": "output",
  "model.finished": "text",
};

/** What the contract says compaction leaves of `events`, in order. */
function expectedAfter(events: readonly TaskEvent[]): TaskEvent[] {
  const latest = new Map<string, number>();
  for (const event of events) {
    const record = RECORD_OF[event.type]?.(event);
    if (record) latest.set(record, event.sequence);
  }
  return events.flatMap((event) => {
    if (DELETED.has(event.type)) return [];
    const record = RECORD_OF[event.type]?.(event);
    if (record && latest.get(record) !== event.sequence) return [];
    const field = STRIPPED[event.type];
    if (!field || !(field in event.payload)) return [event];
    const { [field]: _dropped, ...payload } = event.payload as Record<
      string,
      unknown
    >;
    return [{ ...event, payload } as TaskEvent];
  });
}

/** Every event of a task, with full previews, through the event pages. */
async function allEvents(engine: Engine, taskId: string) {
  const events: TaskEvent[] = [];
  let after = 0;
  for (;;) {
    const page = await engine.tasks.events(taskId, { after });
    events.push(...page.events);
    after = page.cursor;
    if (!page.hasMore) return events;
  }
}

/** The view at `n`: the log's first n events folded from nothing. */
function viewAt(events: readonly TaskEvent[], n: number): TaskView {
  const created = events[0] as Extract<TaskEvent, { type: "task.created" }>;
  const seed: TaskView = {
    task: created.payload.task,
    sessions: [],
    messages: [],
    artifacts: [],
    approvals: [],
    verificationChecks: [],
    usage: { total: emptyUsage(), bySession: {} },
    events: [],
    firstSequence: 1,
    hasEarlier: false,
    cursor: 0,
    compactedThrough: 0,
  };
  return events
    .filter((event) => event.sequence <= n)
    .reduce(applyTaskEvent, seed);
}

const byCreation = <Row extends { createdAt: string; id: string }>(
  rows: readonly Row[],
) =>
  [...rows].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );
const cents = (value: number) => Math.round(value * 1e9) / 1e9;
const roundUsage = (value: TaskView["usage"]["total"]) => ({
  ...value,
  costUsd: cents(value.costUsd),
});

/** A view's records, in the server's order: what a fold must reproduce. */
function records(view: TaskView) {
  return {
    task: view.task,
    sessions: byCreation(view.sessions),
    messages: [...view.messages].sort((a, b) => a.sequence - b.sequence),
    artifacts: byCreation(view.artifacts),
    approvals: byCreation(view.approvals),
    verificationChecks: [...view.verificationChecks].sort(
      (a, b) =>
        a.goalVersion - b.goalVersion ||
        a.attempt - b.attempt ||
        a.criterionId.localeCompare(b.criterionId),
    ),
    usage: {
      total: roundUsage(view.usage.total),
      bySession: Object.fromEntries(
        Object.entries(view.usage.bySession)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([id, used]) => [id, roundUsage(used)]),
      ),
    },
    cursor: view.cursor,
    compactedThrough: view.compactedThrough,
  };
}

/** A small deterministic generator, so a failing cursor can be replayed. */
function cursors(last: number, picks: number, seed = 0x5eed) {
  // xorshift32: exact in 32-bit integer arithmetic.
  let state = seed | 0 || 1;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  const chosen = new Set([1, 2, last - 1, last]);
  for (
    let tries = 0;
    chosen.size < Math.min(last, picks) && tries < 10_000;
    tries++
  )
    chosen.add(1 + (next() % last));
  return [...chosen].filter((n) => n >= 1 && n <= last).sort((a, b) => a - b);
}

/** Every pass in these tests counts tasks finished up to now. */
const compactNow = (engine: Engine) =>
  engine.maintenance.compactEvents({
    finishedBefore: new Date(Date.now() + 60_000),
  });

/** Until nothing of the task runs, waits or is pending a snapshot. */
async function untilSettled(taskId: string, database: Database = db.database) {
  await until(
    async () => {
      const [open] = await database.db
        .select({ value: count() })
        .from(runs)
        .where(
          and(
            eq(runs.taskId, taskId),
            or(eq(runs.status, "running"), eq(runs.snapshotPending, true)),
          ),
        );
      const [queued] = await database.db
        .select({ value: count() })
        .from(jobs)
        .where(
          and(
            eq(jobs.taskId, taskId),
            inArray(jobs.status, ["queued", "running"]),
          ),
        );
      return (open?.value ?? 0) === 0 && (queued?.value ?? 0) === 0;
    },
    { what: "the task to settle" },
  );
}

/** A finished task with two delegated workers that wrote files, and a command of its own. */
async function finishedTeamTask(test: TestEngine, database = db.database) {
  const { engine, executor } = test;
  const team = await createTeam(engine, ["Ada", "Grace", "Linus"]);
  const [ada, grace, linus] = team.names as [string, string, string];
  executor
    .brain(ada, (view) => {
      const turns = said.turns(view);
      if (turns === 0)
        return { calls: [{ name: "bash", args: { command: "seq 1 50" } }] };
      if (turns === 1)
        return {
          calls: [grace, linus].map((worker) => ({
            name: "delegate",
            args: { bot: worker, brief: `Write ${worker}.txt` },
          })),
        };
      const done = reported(view, [grace, linus]);
      if (done.length < 2) return { text: "" };
      return {
        calls: [
          {
            name: "complete_task",
            args: { result: `Consolidated: ${done.join(", ")}` },
          },
        ],
      };
    })
    .brain(grace, writingWorker(grace))
    .brain(linus, writingWorker(linus));
  const { task } = await engine.tasks.create({
    goal: "Write the files",
    coordinatorBotId: team.byName[ada] as string,
    participantBotIds: [team.byName[grace], team.byName[linus]] as string[],
  });
  await untilTask(
    engine,
    task.id,
    (v) =>
      v.task.status === "completed" &&
      v.sessions.every((session) => session.status === "completed"),
    "the team task",
  );
  await untilSettled(task.id, database);
  return { task, view: await engine.tasks.get(task.id) };
}

/** Transcript entries and usage rows of a task: records compaction never touches. */
async function recordCounts(taskId: string) {
  const [entries] = await db.database.db
    .select({ value: count() })
    .from(sessionEntries)
    .innerJoin(sessions, eq(sessions.id, sessionEntries.sessionId))
    .where(eq(sessions.taskId, taskId));
  const [used] = await db.database.db
    .select({ value: count() })
    .from(usage)
    .where(eq(usage.taskId, taskId));
  return { entries: entries?.value ?? 0, usage: used?.value ?? 0 };
}

describe("event compaction", () => {
  it("classifies every event type", () => {
    expect(Object.keys(COMPACTION).sort()).toEqual(
      [...TASK_EVENT_TYPES].sort(),
    );
    for (const type of DELETED)
      expect(COMPACTION[type as TaskEvent["type"]].action).toBe("delete");
    for (const type of Object.keys(RECORD_OF))
      expect(COMPACTION[type as TaskEvent["type"]].action).toBe("latest");
    for (const [type, field] of Object.entries(STRIPPED))
      expect(COMPACTION[type as TaskEvent["type"]]).toEqual({
        action: "strip",
        field,
      });
  });

  it("deletes activity and superseded snapshots, strips previews, and keeps everything else and every record", async () => {
    const test = await setup();
    const { engine } = test;
    const { task, view: before } = await finishedTeamTask(test);
    const events = await allEvents(engine, task.id);
    expect(events.length).toBe(before.cursor);
    // The scenario holds every kind compaction treats differently.
    for (const type of [
      "model.started",
      "tool.started",
      "run.started",
      "session.created",
      "session.updated",
      "task.updated",
      "tool.finished",
      "model.finished",
      "message.posted",
      "artifact.created",
      "run.finished",
      "task.finished",
    ])
      expect(
        events.some((event) => event.type === type),
        type,
      ).toBe(true);
    const counts = await recordCounts(task.id);
    expect(counts.entries).toBeGreaterThan(0);
    const log = await listTaskLog(db.database.db, task.id, {});
    const state = await readTaskState(db.database.db, task.id);

    const pass = await compactNow(engine);
    const mine = pass.tasks.find((done) => done.taskId === task.id);
    const kept = expectedAfter(events);
    expect(mine).toEqual({
      taskId: task.id,
      through: before.cursor,
      removed: events.length - kept.length,
      stripped: events.filter(
        (event) =>
          STRIPPED[event.type] !== undefined &&
          (STRIPPED[event.type] as string) in event.payload,
      ).length,
    });
    expect(mine?.removed).toBeGreaterThan(events.length / 3);

    const after = await allEvents(engine, task.id);
    const marker = after.at(-1);
    expect(after.slice(0, -1)).toEqual(kept);
    expect(marker).toMatchObject({
      type: "task.compacted",
      sequence: before.cursor + 1,
      payload: {
        through: before.cursor,
        removed: mine?.removed,
        stripped: mine?.stripped,
      },
    });
    // Every tool call is still recorded, without its preview.
    expect(
      after.filter((event) => event.type === "tool.finished"),
    ).toHaveLength(
      events.filter((event) => event.type === "tool.finished").length,
    );

    // The records are untouched; the view says what was compacted.
    const view = await engine.tasks.get(task.id);
    expect(view.compactedThrough).toBe(before.cursor);
    expect((await engine.tasks.events(task.id)).compactedThrough).toBe(
      before.cursor,
    );
    const { cursor: _c, compactedThrough: _t, ...was } = records(before);
    const { cursor: _c2, compactedThrough: _t2, ...is } = records(view);
    expect(is).toEqual(was);
    expect(await recordCounts(task.id)).toEqual(counts);
    expect(await listTaskLog(db.database.db, task.id, {})).toEqual(log);
    expect(await readTaskState(db.database.db, task.id)).toEqual(state);

    // Idempotent: nothing new, nothing done.
    const again = await compactNow(engine);
    expect(again.tasks.map((done) => done.taskId)).not.toContain(task.id);
    expect(await allEvents(engine, task.id)).toEqual(after);
  });

  it("folds the kept events after any cursor into the latest view", async () => {
    const test = await setup();
    const { engine } = test;
    const { task } = await finishedTeamTask(test);
    const original = await allEvents(engine, task.id);
    await compactNow(engine);
    const kept = await allEvents(engine, task.id);
    const latest = records(await engine.tasks.get(task.id));
    const last = original.at(-1)?.sequence ?? 0;
    const deleted = original
      .map((event) => event.sequence)
      .filter((sequence) => !kept.some((event) => event.sequence === sequence));
    expect(deleted.length).toBeGreaterThan(0);
    // Random cursors, and every one a deleted event had: a client may hold any.
    for (const n of new Set([...cursors(last, 40), ...deleted])) {
      const resumed = kept
        .filter((event) => event.sequence > n)
        .reduce(applyTaskEvent, viewAt(original, n));
      expect(records(resumed), `resumed after ${n}`).toEqual(latest);
    }
  });

  it("compacts only tasks that nothing can act on any more, each guard on its own", async () => {
    const test = await setup();
    const { engine } = test;
    const { task } = await finishedTeamTask(test);
    await engine.worker.stop();
    const { db: store } = db.database;
    const [session] = await store
      .select()
      .from(sessions)
      .where(eq(sessions.taskId, task.id));
    const [run] = await store
      .select()
      .from(runs)
      .where(eq(runs.taskId, task.id));
    if (!session || !run) throw new Error("The task ran no session.");
    const [row] = await store.select().from(tasks).where(eq(tasks.id, task.id));
    const finishedAt = row?.finishedAt as Date;
    const compacted = async (
      finishedBefore = new Date(Date.now() + 60_000),
    ) => {
      const pass = await engine.maintenance.compactEvents({ finishedBefore });
      return pass.tasks.some((done) => done.taskId === task.id);
    };

    const guards: {
      name: string;
      block: () => Promise<unknown>;
      unblock: () => Promise<unknown>;
      finishedBefore?: Date;
    }[] = [
      {
        name: "a waiting task",
        block: () =>
          store
            .update(tasks)
            .set({ status: "waiting" })
            .where(eq(tasks.id, task.id)),
        unblock: () =>
          store
            .update(tasks)
            .set({ status: "completed" })
            .where(eq(tasks.id, task.id)),
      },
      {
        name: "finished within the retention",
        block: async () => {},
        unblock: async () => {},
        finishedBefore: new Date(finishedAt.getTime() - 1),
      },
      {
        name: "a queued session",
        block: () =>
          store
            .update(sessions)
            .set({ status: "queued" })
            .where(eq(sessions.id, session.id)),
        unblock: () =>
          store
            .update(sessions)
            .set({ status: session.status })
            .where(eq(sessions.id, session.id)),
      },
      {
        name: "a running session",
        block: () =>
          store
            .update(sessions)
            .set({ status: "running" })
            .where(eq(sessions.id, session.id)),
        unblock: () =>
          store
            .update(sessions)
            .set({ status: session.status })
            .where(eq(sessions.id, session.id)),
      },
      {
        name: "a queued job",
        block: () =>
          store.insert(jobs).values({
            id: "job_retention_guard",
            kind: "session.run",
            taskId: task.id,
            sessionId: session.id,
          }),
        unblock: () =>
          store.delete(jobs).where(eq(jobs.id, "job_retention_guard")),
      },
      {
        name: "an open run",
        block: () =>
          store
            .update(runs)
            .set({ status: "running" })
            .where(eq(runs.id, run.id)),
        unblock: () =>
          store
            .update(runs)
            .set({ status: run.status })
            .where(eq(runs.id, run.id)),
      },
      {
        name: "a run pending a snapshot",
        block: () =>
          store
            .update(runs)
            .set({ snapshotPending: true })
            .where(eq(runs.id, run.id)),
        unblock: () =>
          store
            .update(runs)
            .set({ snapshotPending: false })
            .where(eq(runs.id, run.id)),
      },
      {
        name: "a pending approval",
        block: () =>
          store.insert(approvals).values({
            id: "apr_retention_guard",
            taskId: task.id,
            sessionId: session.id,
            runId: run.id,
            botId: session.botId,
            toolCallId: "guard",
            tool: "bash",
            summary: "git push",
            args: { command: "git push" },
            rule: { tool: "bash" },
            goalVersion: 1,
          }),
        unblock: () =>
          store
            .delete(approvals)
            .where(eq(approvals.id, "apr_retention_guard")),
      },
      {
        name: "a stop in progress",
        block: () =>
          store
            .update(tasks)
            .set({ cancelRequestedAt: new Date() })
            .where(eq(tasks.id, task.id)),
        unblock: () =>
          store
            .update(tasks)
            .set({ cancelRequestedAt: null })
            .where(eq(tasks.id, task.id)),
      },
    ];
    for (const guard of guards) {
      await guard.block();
      expect(await compacted(guard.finishedBefore), guard.name).toBe(false);
      await guard.unblock();
    }
    const [untouched] = await store
      .select({ value: count() })
      .from(taskEvents)
      .where(eq(taskEvents.taskId, task.id));
    expect(untouched?.value).toBe(row?.eventSeq);
    // With none of them, the same task is compacted.
    expect(await compacted()).toBe(true);
  });

  it("never compacts while retention is off", async () => {
    const test = await setup({ config: { eventRetentionDays: 0 } });
    const { task } = await finishedTeamTask(test);
    const pass = await test.engine.maintenance.compactEvents();
    expect(pass.tasks).toEqual([]);
    expect((await test.engine.tasks.get(task.id)).compactedThrough).toBe(0);
  });
});

/**
 * A coordinator that runs `steps` commands, writes done.txt and completes;
 * continued, it completes again.
 */
function steadyCoordinator(steps: number): Brain {
  return (view) => {
    const turns = said.turns(view);
    if (said.heard(view, "Once more"))
      return { calls: [{ name: "complete_task", args: { result: "Again." } }] };
    if (turns < steps)
      return {
        calls: [{ name: "bash", args: { command: `echo step ${turns + 1}` } }],
      };
    if (turns === steps)
      return {
        calls: [{ name: "bash", args: { command: "echo ok > done.txt" } }],
      };
    return { calls: [{ name: "complete_task", args: { result: "Done." } }] };
  };
}

describe("the compaction pass", () => {
  it("logs a task whose compaction fails, skips it, and goes on with the others", async () => {
    // Earlier tests' tasks are compacted first, by an engine of their own.
    const drain = await setup({ start: false });
    while ((await compactNow(drain.engine)).more);
    const test = await setup({ config: { compactionMaxTasks: 1 } });
    const { engine } = test;
    const failing = (await finishedTeamTask(test)).task;
    const other = (await finishedTeamTask(test)).task;
    await engine.worker.stop();
    const { db: store } = db.database;
    // Every delete of the failing task's events fails, as a damaged row would.
    await store.execute(
      sql.raw(`create or replace function jj_test_refuse_delete() returns trigger as $$
        begin
          if old.task_id = '${failing.id}' then raise exception 'refused for the test'; end if;
          return old;
        end $$ language plpgsql`),
    );
    await store.execute(
      sql.raw(
        "create trigger jj_test_refuse_delete before delete on task_events for each row execute function jj_test_refuse_delete()",
      ),
    );
    try {
      const warnings = quietLogger.warnings.length;
      // Only one task a pass: the failing one, the oldest finish, comes first.
      const first = await compactNow(engine);
      expect(first.failed).toEqual([failing.id]);
      expect(first.tasks).toEqual([]);
      expect(quietLogger.warnings.slice(warnings)).toEqual([
        "Compacting a task's events failed; the next passes skip it for a day",
      ]);
      // The next pass skips it, so the other task is not held up.
      const second = await compactNow(engine);
      expect(second.tasks.map((done) => done.taskId)).toEqual([other.id]);
      expect(second.failed).toEqual([]);
      expect((await engine.tasks.get(failing.id)).compactedThrough).toBe(0);
    } finally {
      await store.execute(
        sql.raw("drop trigger jj_test_refuse_delete on task_events"),
      );
      await store.execute(sql.raw("drop function jj_test_refuse_delete()"));
    }
  });

  it("vacuums PGlite only once nothing is left to compact, and at most once a day", async () => {
    // Earlier tests' tasks are compacted first, by an engine of their own.
    const drain = await setup({ start: false });
    while ((await compactNow(drain.engine)).more);
    const test = await setup({ config: { compactionMaxTasks: 1 } });
    const { engine } = test;
    await finishedTeamTask(test);
    await finishedTeamTask(test);
    const pglite = db.database.mode === "pglite";
    // One task a pass: the first pass leaves the other, so it does not vacuum.
    const first = await compactNow(engine);
    expect(first.more).toBe(true);
    expect(first.vacuumed).toBe(false);
    const second = await compactNow(engine);
    expect(second.more).toBe(false);
    expect(second.vacuumed).toBe(pglite);
    // A third task's pass, the same day, does not vacuum again.
    await finishedTeamTask(test);
    const third = await compactNow(engine);
    expect(third.tasks).toHaveLength(1);
    expect(third.vacuumed).toBe(false);
  });

  it("counts the finished tasks a pending snapshot keeps from compaction", async () => {
    const test = await setup();
    const { engine } = test;
    const { task } = await finishedTeamTask(test);
    await engine.worker.stop();
    const { db: store } = db.database;
    const before = (await compactNow(engine)).waitingOnSnapshots;
    // A fresh task that a run pending a snapshot keeps uncompacted.
    const pending = await finishedTeamTask(await setup());
    await store
      .update(runs)
      .set({ snapshotPending: true })
      .where(eq(runs.taskId, pending.task.id));
    const pass = await compactNow(engine);
    expect(pass.tasks.map((done) => done.taskId)).not.toContain(
      pending.task.id,
    );
    expect(pass.waitingOnSnapshots).toBe(before + 1);
    expect(await engine.metrics.text()).toMatch(
      new RegExp(`jj_events_compaction_waiting_tasks ${before + 1}\\b`),
    );
    await store
      .update(runs)
      .set({ snapshotPending: false })
      .where(eq(runs.taskId, pending.task.id));
    const after = await compactNow(engine);
    expect(after.tasks.map((done) => done.taskId)).toContain(pending.task.id);
    expect(after.waitingOnSnapshots).toBe(before);
    expect(task.id).toBeDefined();
  });

  it.skipIf(!postgresUrl)(
    "re-checks under the lock what committed while it waited for it (PostgreSQL)",
    async () => {
      const test = await setup();
      const { engine } = test;
      const { task } = await finishedTeamTask(test);
      await engine.worker.stop();
      const { db: store } = db.database;
      const [session] = await store
        .select()
        .from(sessions)
        .where(eq(sessions.taskId, task.id));
      let locked = () => {};
      const isLocked = new Promise<void>((resolve) => {
        locked = resolve;
      });
      let release = () => {};
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      // Another writer holds the task's row and queues work for it.
      const writer = store.transaction(async (tx) => {
        await tx
          .select({ id: tasks.id })
          .from(tasks)
          .where(eq(tasks.id, task.id))
          .for("update");
        locked();
        await released;
        await tx.insert(jobs).values({
          id: "job_retention_recheck",
          kind: "session.run",
          taskId: task.id,
          sessionId: session?.id as string,
        });
      });
      await isLocked;
      // The pass picks the task, then waits for its row.
      const pass = compactNow(engine);
      await sleep(500);
      release();
      await writer;
      try {
        expect((await pass).tasks.map((done) => done.taskId)).not.toContain(
          task.id,
        );
        expect((await engine.tasks.get(task.id)).compactedThrough).toBe(0);
      } finally {
        await store.delete(jobs).where(eq(jobs.id, "job_retention_recheck"));
      }
    },
  );
});

describe("fold equivalence across passes", () => {
  it("folds from any cursor of a log with verification, a goal change, steering and two passes", async () => {
    const test = await setup();
    const { engine, executor } = test;
    const team = await createTeam(engine, ["Ada"]);
    const [ada] = team.names as [string];
    const gate = executor.gate("steer");
    executor.brain(ada, (view) => {
      const results = said.results(view);
      if (said.heard(view, "Once more"))
        return {
          calls: [{ name: "complete_task", args: { result: "Again." } }],
        };
      if (said.turns(view) === 0)
        return { calls: [{ name: "gate", args: { name: "steer" } }] };
      const completes = results.filter((r) => r.name === "complete_task");
      const failures = said
        .inputs(view)
        .filter((text) => text.startsWith("Verification of goal version"));
      // The first completion fails its check: done.txt is not written yet.
      if (completes.length === 0)
        return {
          calls: [{ name: "complete_task", args: { result: "Done." } }],
        };
      if (failures.length > 0 && !results.some((r) => r.name === "bash"))
        return {
          calls: [{ name: "bash", args: { command: "echo ok > done.txt" } }],
        };
      return {
        calls: [{ name: "complete_task", args: { result: "Done, checked." } }],
      };
    });
    const { task } = await engine.tasks.create({
      goal: "Write done.txt",
      coordinatorBotId: team.byName[ada] as string,
      verificationPlan: [
        {
          id: "done",
          description: "done.txt says ok",
          method: "file",
          path: "done.txt",
          expect: "contains",
          value: "ok",
        },
      ],
    });
    await gate.reached;
    // Steering and a goal change reach the coordinator while it runs.
    await engine.tasks.postMessage(task.id, { text: "Keep it short." });
    await engine.tasks.postMessage(task.id, {
      text: "New goal.",
      goal: "Write done.txt, saying ok",
      observedGoalVersion: 1,
    });
    gate.open();
    await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed",
      "the verified completion",
    );
    await untilSettled(task.id);
    const first = await allEvents(engine, task.id);
    for (const type of [
      "steering.received",
      "task.goal_changed",
      "verification.started",
      "verification.checked",
      "verification.finished",
    ])
      expect(
        first.some((event) => event.type === type),
        type,
      ).toBe(true);
    expect(
      first.some(
        (event) =>
          event.type === "verification.finished" &&
          event.payload.outcome === "failed",
      ),
    ).toBe(true);

    const one = await compactNow(engine);
    const through = one.tasks.find((done) => done.taskId === task.id)?.through;
    expect(through).toBe(first.at(-1)?.sequence);
    await engine.tasks.postMessage(task.id, { text: "Once more, please." });
    await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed" && v.task.result === "Again.",
      "the continuation",
    );
    await untilSettled(task.id);
    // What a client could have seen: the first log, the marker, and every
    // event since, none of them compacted yet.
    const between = await allEvents(engine, task.id);
    const seen = [
      ...first,
      ...between.filter((event) => event.sequence > (through as number)),
    ];
    const two = await compactNow(engine);
    expect(two.tasks.map((done) => done.taskId)).toContain(task.id);
    const kept = await allEvents(engine, task.id);
    // Two passes keep what one pass over the whole log would, marker aside.
    expect(kept.slice(0, -1)).toEqual(expectedAfter(seen));
    expect(kept.at(-1)?.type).toBe("task.compacted");
    const latest = records(await engine.tasks.get(task.id));
    expect(latest.compactedThrough).toBeGreaterThan(through as number);
    const last = seen.at(-1)?.sequence ?? 0;
    const deleted = seen
      .map((event) => event.sequence)
      .filter((sequence) => !kept.some((event) => event.sequence === sequence));
    for (const n of new Set([...cursors(last, 60), ...deleted])) {
      const resumed = kept
        .filter((event) => event.sequence > n)
        .reduce(applyTaskEvent, viewAt(seen, n));
      expect(records(resumed), `resumed after ${n}`).toEqual(latest);
    }
  });
});

describe("a compacted task", () => {
  it("continues to a verified completion, with spend dedupe, gate attempts and lookups unchanged", async () => {
    const test = await setup();
    const { engine, executor } = test;
    const team = await createTeam(engine, ["Ada"]);
    const [ada] = team.names as [string];
    let continued: number | undefined;
    const steady = steadyCoordinator(7);
    executor.brain(ada, (view) => {
      if (said.heard(view, "Once more")) continued = said.turns(view);
      return steady(view);
    });
    // $0.01 a call: the ninth call starts at $0.08, past 80% of $0.095.
    const { task } = await engine.tasks.create({
      goal: "Count, then write done.txt",
      coordinatorBotId: team.byName[ada] as string,
      spendCapUsd: 0.095,
      verificationPlan: [
        {
          id: "done",
          description: "done.txt says ok",
          method: "file",
          path: "done.txt",
          expect: "contains",
          value: "ok",
        },
      ],
    });
    await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed",
      "the first completion",
    );
    await untilSettled(task.id);
    const first = await engine.tasks.get(task.id);
    const thresholds = (view: TaskView) =>
      view.events.filter((event) => event.type === "spend.threshold").length;
    expect(thresholds(first)).toBe(1);
    expect(first.verificationChecks.map((check) => check.attempt)).toEqual([1]);
    // A gate run a crash cut off before its first check: only its
    // `verification.started` says attempt 4 was used.
    await db.database.db.transaction((tx) =>
      appendEvent(tx, {
        taskId: task.id,
        type: "verification.started",
        payload: { goalVersion: 1, attempt: 4, criteria: 1 },
      }),
    );
    const state = await readTaskState(db.database.db, task.id);
    const log = await listTaskLog(db.database.db, task.id, {});

    const pass = await compactNow(engine);
    expect(pass.tasks.map((done) => done.taskId)).toContain(task.id);
    const compacted = await engine.tasks.get(task.id);
    expect(compacted.compactedThrough).toBeGreaterThan(0);
    expect(await readTaskState(db.database.db, task.id)).toEqual(state);
    expect(await listTaskLog(db.database.db, task.id, {})).toEqual(log);

    await engine.tasks.postMessage(task.id, { text: "Once more, please." });
    const done = await untilTask(
      engine,
      task.id,
      (v) =>
        v.task.status === "completed" &&
        v.events.some((event) => event.type === "task.reopened") &&
        v.verificationChecks.some((check) => check.attempt > 1),
      "the verified continuation",
    );
    // The coordinator resumed from its whole transcript, not from events.
    expect(continued).toBeGreaterThanOrEqual(9);
    expect(done.task.result).toBe("Again.");
    // The cut-off attempt's number was not reused, and the check passed.
    expect(done.verificationChecks).toEqual([
      expect.objectContaining({ attempt: 5, outcome: "passed" }),
    ]);
    // Past the soft threshold again at the same cap: not noted twice. The
    // one note is the first stretch's, which compaction kept.
    const all = await allEvents(engine, task.id);
    const notes = all.filter((event) => event.type === "spend.threshold");
    expect(notes).toHaveLength(1);
    expect(notes[0]?.sequence).toBeLessThanOrEqual(compacted.compactedThrough);
    // Its new events age out only after it finishes again.
    const reopened = all.find((event) => event.type === "task.reopened");
    expect(reopened?.sequence).toBeGreaterThan(compacted.compactedThrough);
    expect(
      all.some(
        (event) =>
          event.type === "model.started" &&
          event.sequence > compacted.compactedThrough,
      ),
    ).toBe(true);
    await untilSettled(task.id);
    const second = await compactNow(engine);
    const twice = second.tasks.find((entry) => entry.taskId === task.id);
    expect(twice?.through).toBe((await engine.tasks.get(task.id)).cursor - 1);
    expect(
      (await allEvents(engine, task.id)).filter(
        (event) => event.type === "task.compacted",
      ),
    ).toHaveLength(2);
  });
});

describe("backups", () => {
  it("compacts a restored older backup again, to the same events", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jj-retention-backup-"));
    dirs.push(dir);
    const data = join(dir, "data");
    const backup = join(dir, "backup");
    const open = () =>
      openDatabase({ mode: "pglite", path: data, onError: () => {} });

    let database = await open();
    const running = await testEngine(database);
    const { task } = await finishedTeamTask(running, database);
    const original = await allEvents(running.engine, task.id);
    await running.dispose();
    await database.close();
    // The PGlite backup: a copy of the stopped server's directory.
    await cp(data, backup, { recursive: true });

    const compactOnce = async () => {
      database = await open();
      const idle = await testEngine(database, { start: false });
      try {
        const pass = await compactNow(idle.engine);
        return {
          pass: pass.tasks.find((done) => done.taskId === task.id),
          events: await allEvents(idle.engine, task.id),
        };
      } finally {
        await idle.dispose();
        await database.close();
      }
    };
    const first = await compactOnce();
    expect(first.pass?.removed).toBeGreaterThan(0);

    // Restore the backup over the compacted data.
    await rm(data, { recursive: true, force: true });
    await cp(backup, data, { recursive: true });
    database = await open();
    const restored = await testEngine(database, { start: false });
    expect(await allEvents(restored.engine, task.id)).toEqual(original);
    expect((await restored.engine.tasks.get(task.id)).compactedThrough).toBe(0);
    await restored.dispose();
    await database.close();

    const second = await compactOnce();
    expect(second.pass).toEqual(first.pass);
    const strip = (events: TaskEvent[]) =>
      events.map(({ id, occurredAt, ...rest }) =>
        rest.type === "task.compacted" ? rest : { id, occurredAt, ...rest },
      );
    expect(strip(second.events)).toEqual(strip(first.events));
  });
});

describe("measurement", () => {
  it("reports what compaction saves on a 200-call task", async () => {
    const test = await setup();
    const { engine, executor } = test;
    // Past the default 60 turns a run, so the 200 calls are one run.
    const { profile } = await engine.profiles.create({
      name: uniqueName("Long"),
      sandbox: { driver: "local", network: { mode: "open" } },
      budgets: { maxTurnsPerRun: 250, maxUsdPerTask: null },
    });
    const ada = uniqueName("Ada");
    const { bot } = await engine.bots.create({
      name: ada,
      role: "Lister",
      runtimeProfileId: profile.id,
    });
    executor.brain(ada, (view) =>
      said.turns(view) < 199
        ? // About 1 KB of output a call, reported without a process, so
          // the 200 calls cost database writes alone.
          { calls: [{ name: "raw_output", args: { bytes: 1100 } }] }
        : { calls: [{ name: "complete_task", args: { result: "Listed." } }] },
    );
    const { task } = await engine.tasks.create({
      goal: "List numbers 200 times",
      coordinatorBotId: bot.id,
    });
    await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed",
      "the 200-call task",
      150_000,
    );
    await untilSettled(task.id);
    const size = async () => {
      const [row] = await db.database.db
        .select({
          events: count(),
          bytes: sql<number>`coalesce(sum(octet_length(${taskEvents.payload}::text)), 0)`,
        })
        .from(taskEvents)
        .where(and(eq(taskEvents.taskId, task.id)));
      return { events: Number(row?.events), bytes: Number(row?.bytes) };
    };
    const before = await size();
    await compactNow(engine);
    const after = await size();
    const saved = 1 - after.bytes / before.bytes;
    console.info(
      `200-call task: ${before.events} events, ${before.bytes} payload bytes before compaction; ${after.events} events, ${after.bytes} bytes after (${Math.round(saved * 100)}% saved)`,
    );
    // Measured: 810 events of 299 KB down to 407 of 63 KB (79% saved).
    expect(after.events).toBeLessThan(before.events * 0.55);
    expect(saved).toBeGreaterThan(0.75);
  }, 180_000);
});
