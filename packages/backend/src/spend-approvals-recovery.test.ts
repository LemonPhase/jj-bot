// A worker whose turn ended but was never written back (the worker crashed
// first) recovers while a pending spend approval covers it. The recovery
// keeps its reason: it finishes the ended turn and sends the report, which
// needs no model call, instead of being parked and later woken with nothing
// to do (which left it waiting for an approval already answered).
import type { TaskView } from "@jj/contracts";
import { approvals, sessions } from "@jj/db";
import { ModelRegistry, PiSessionExecutor } from "@jj/runtime";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RunExecutor } from "./ports";
import { promptBot } from "./testing/fake-executor";
import {
  OPEN_TIMEOUT,
  openTestDatabase,
  type TestDatabase,
  type TestEngine,
  testEngine,
  uniqueName,
  untilTask,
} from "./testing/harness";

const PRICED = "scripted/team-priced";
let db: TestDatabase;
const engines: TestEngine[] = [];
beforeAll(async () => {
  db = await openTestDatabase();
}, OPEN_TIMEOUT);
afterEach(async () => {
  for (const engine of engines.splice(0).reverse()) await engine.dispose();
});
afterAll(async () => {
  await db?.close();
});

/** Holds the named bot's first ended run until released, so a crash can fence it before its write-back. */
class HoldEndedTurn implements RunExecutor {
  ended: Promise<void>;
  private seen: () => void = () => {};
  private release: () => void = () => {};
  private readonly released = new Promise<void>((resolve) => {
    this.release = resolve;
  });
  private once = false;
  bot = "";
  constructor(private readonly inner: RunExecutor) {
    this.ended = new Promise<void>((resolve) => {
      this.seen = resolve;
    });
  }
  async run(input: Parameters<RunExecutor["run"]>[0]) {
    const outcome = await this.inner.run(input);
    if (
      !this.once &&
      outcome.kind === "ended" &&
      promptBot(input.systemPrompt) === this.bot
    ) {
      this.once = true;
      this.seen();
      await this.released;
    }
    return outcome;
  }
  letGo() {
    this.release();
  }
}

describe.each([
  ["covers the worker", true],
  ["is absent", false],
])("a recovery while a spend approval %s", (_, cover) => {
  it("finishes the ended turn and sends its report", async () => {
    const models = new ModelRegistry({ env: {}, enableScripted: true });
    const executor = new HoldEndedTurn(new PiSessionExecutor({ models }));
    const first = await testEngine(db.database, {
      models,
      runExecutor: executor,
      config: { leaseMs: 1_500 },
    });
    engines.push(first);
    const { bot: ada } = await first.engine.bots.create({
      name: uniqueName("Ada"),
      model: PRICED,
    });
    const { bot: grace } = await first.engine.bots.create({
      name: uniqueName("Grace"),
      model: PRICED,
    });
    executor.bot = grace.name;
    const { task } = await first.engine.tasks.create({
      goal: "Write the notes.",
      coordinatorBotId: ada.id,
      participantBotIds: [grace.id],
      spendCapUsd: 5,
      approveSpendPastThreshold: true,
    });
    await executor.ended;
    const worker = (
      await db.database.db
        .select()
        .from(sessions)
        .where(eq(sessions.taskId, task.id))
    ).find((session) => session.botId === grace.id);
    expect(worker).toBeDefined();
    if (cover)
      // The pending approval a teammate's call past 80% would record; it
      // covers every session of the task.
      await db.database.db.insert(approvals).values({
        id: uniqueName("approval_recovery"),
        kind: "spend",
        taskId: task.id,
        sessionId: (worker as typeof sessions.$inferSelect).id,
        runId: "run_recovery",
        botId: grace.id,
        spend: { scope: "task", spentUsd: 4.1, capUsd: 5, thresholdUsd: 4 },
        createdAt: new Date(),
      } as typeof approvals.$inferInsert);
    // A crash: the run is fenced, its ended turn never written back.
    const crash = first.engine.worker.abandon();
    executor.letGo();
    await crash;
    engines.splice(engines.indexOf(first), 1);

    const second = await testEngine(db.database, {
      models,
      runExecutor: new PiSessionExecutor({ models }),
      config: { leaseMs: 1_500 },
    });
    engines.push(second);
    const workerId = (worker as typeof sessions.$inferSelect).id;
    let parkedBots: string[] = [];
    if (cover) {
      // Whichever session the approval holds, the user approves.
      const parked = await untilTask(
        second.engine,
        task.id,
        (view) =>
          view.sessions.some((session) => session.waitingFor === "approval"),
        "the park",
      );
      parkedBots = parked.sessions
        .filter((session) => session.waitingFor === "approval")
        .map((session) => session.botId);
      const pending = parked.approvals.find(
        (approval) => approval.status === "pending",
      );
      await second.engine.tasks.decideApproval(task.id, pending?.id as string, {
        decision: "approve",
      });
    }
    let last: TaskView | undefined;
    const done = await untilTask(
      second.engine,
      task.id,
      (view) => {
        last = view;
        return view.task.status === "completed";
      },
      "the task's completion",
      15_000,
    ).catch((error: Error) => {
      const states = last?.sessions.map(
        (session) =>
          `${session.botId === ada.id ? "coordinator" : "worker"} ${session.status}/${session.waitingFor ?? "-"}`,
      );
      throw new Error(
        `${error.message}: task ${last?.task.status}, ${states?.join(", ")}, approvals ${last?.approvals.map((approval) => approval.status).join(", ")}`,
      );
    });
    expect(
      done.sessions.filter((session) => session.waitingFor === "approval"),
    ).toEqual([]);
    // The worker's report reached the coordinator, from the one recovery run
    // that finished its turn.
    expect(
      done.messages.some(
        (message) =>
          message.sessionId === workerId && message.authorKind === "bot",
      ),
    ).toBe(true);
    expect(
      done.events
        .filter(
          (event) =>
            event.type === "run.started" && event.sessionId === workerId,
        )
        .map((event) => (event.payload as { reason: string }).reason),
    ).toEqual(["start", "recovery"]);
    // The approval held the coordinator, woken by the report, and not the
    // recovering worker.
    expect(parkedBots).toEqual(cover ? [ada.id] : []);
  }, 90_000);
});
