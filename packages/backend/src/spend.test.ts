// Spend caps: no model call starts once the task's, the bot's or the
// instance's cap is reached; the work stops visibly and the API refuses what
// would start more. The fake executor charges FAKE_USAGE ($0.01) per call.
import {
  conversationViewSchema,
  DEFAULT_MAX_USD_PER_TASK,
  type TaskEvent,
  type TaskView,
  usageReportSchema,
} from "@jj/contracts";
import { usage } from "@jj/db";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Engine } from "./engine";
import { type Brain, FAKE_MODEL, said } from "./testing/fake-executor";
import {
  OPEN_TIMEOUT,
  openTestDatabase,
  type TestDatabase,
  type TestEngine,
  testEngine,
  until,
  untilTask,
} from "./testing/harness";
import { createTeam, delegatingCoordinator } from "./testing/scenarios";

let db: TestDatabase;
const engines: TestEngine[] = [];
const extraDatabases: TestDatabase[] = [];

beforeAll(async () => {
  db = await openTestDatabase();
}, OPEN_TIMEOUT);
afterEach(async () => {
  for (const engine of engines.splice(0).reverse()) await engine.dispose();
  for (const extra of extraDatabases.splice(0)) await extra.close();
});
afterAll(async () => {
  await db?.close();
});

async function setup(options: Parameters<typeof testEngine>[1] = {}) {
  const engine = await testEngine(db.database, options);
  engines.push(engine);
  return engine;
}

/** Runs one command per turn and never finishes on its own. */
const tireless: Brain = (view) => ({
  calls: [
    { name: "bash", args: { command: `echo turn ${said.turns(view) + 1}` } },
  ],
});

const ofType = <Type extends TaskEvent["type"]>(view: TaskView, type: Type) =>
  view.events.filter(
    (event): event is Extract<TaskEvent, { type: Type }> => event.type === type,
  );

const modelCalls = (view: TaskView) => ofType(view, "model.finished").length;

/** A local profile with these budgets. */
async function profileWith(
  engine: Engine,
  budgets: {
    maxUsdPerTask?: number | null;
    maxUsdPerBotPerDay?: number | null;
  },
) {
  const { profile } = await engine.profiles.create({
    name: `Capped ${Math.random().toString(36).slice(2, 8)}`,
    sandbox: { driver: "local", network: { mode: "open" } },
    budgets,
  });
  return profile;
}

const waitingForUser = (view: TaskView) =>
  view.task.status === "waiting" &&
  view.sessions.every((session) => session.status !== "running");

describe("the task's spend cap", () => {
  it("stops the task before the call past its cap, refuses messages until it is raised, then continues", async () => {
    const { engine, executor } = await setup();
    const team = await createTeam(engine, ["Ada"]);
    const [ada] = team.names as [string];
    executor.brain(ada, tireless);
    const { task } = await engine.tasks.create({
      goal: "Count forever.",
      coordinatorBotId: team.ids[0] as string,
      spendCapUsd: 0.035,
    });
    expect(task.spendCapUsd).toBe(0.035);

    const stopped = await untilTask(engine, task.id, waitingForUser);
    // Four calls reach $0.04; the fifth is never made.
    expect(modelCalls(stopped)).toBe(4);
    expect(stopped.usage.total.costUsd).toBeCloseTo(0.04);
    const capped = ofType(stopped, "spend.capped");
    expect(capped).toHaveLength(1);
    expect(capped[0]?.payload).toMatchObject({ scope: "task", capUsd: 0.035 });
    expect(capped[0]?.sessionId).toBe(stopped.sessions[0]?.id);
    // The soft threshold (80%) was noted once, before the cap.
    const threshold = ofType(stopped, "spend.threshold");
    expect(threshold).toHaveLength(1);
    expect(threshold[0]?.payload.capUsd).toBe(0.035);
    expect(threshold[0]?.sequence).toBeLessThan(capped[0]?.sequence ?? 0);
    const system = stopped.messages.filter(
      (message) => message.authorKind === "system",
    );
    expect(system.at(-1)?.text).toMatch(
      /^Stopped: The task reached its spend cap: \$0\.04 of \$0\.035 spent\. Raise the task's spend cap to continue\.$/,
    );
    expect(stopped.sessions[0]).toMatchObject({
      status: "waiting",
      waitingFor: "user",
    });

    await expect(
      engine.tasks.postMessage(task.id, { text: "Keep going." }),
    ).rejects.toMatchObject({
      code: "SPEND_CAP_REACHED",
      details: { scope: "task", capUsd: 0.035 },
    });

    const { task: raised } = await engine.tasks.update(task.id, {
      spendCapUsd: 0.055,
    });
    expect(raised.spendCapUsd).toBe(0.055);
    await engine.tasks.postMessage(task.id, { text: "Keep going." });
    const again = await untilTask(
      engine,
      task.id,
      (view) =>
        ofType(view, "spend.capped").length === 2 && waitingForUser(view),
    );
    // Two more calls reach $0.06; the threshold of the new cap is noted once.
    expect(modelCalls(again)).toBe(6);
    expect(
      ofType(again, "spend.threshold").map((event) => event.payload.capUsd),
    ).toEqual([0.035, 0.055]);
  });

  it("takes the coordinator's profile cap, or the one the creator gives", async () => {
    const { engine } = await setup({ start: false });
    const profile = await profileWith(engine, { maxUsdPerTask: 1.5 });
    const { bot } = await engine.bots.create({
      name: `Capped${Date.now()}`,
      runtimeProfileId: profile.id,
    });
    const team = await createTeam(engine, ["Bob"]);
    const fromProfile = await engine.tasks.create({
      goal: "Work.",
      coordinatorBotId: bot.id,
    });
    expect(fromProfile.task.spendCapUsd).toBe(1.5);
    const fromDefault = await engine.tasks.create({
      goal: "Work.",
      coordinatorBotId: team.ids[0] as string,
    });
    expect(fromDefault.task.spendCapUsd).toBe(DEFAULT_MAX_USD_PER_TASK);
    const uncapped = await engine.tasks.create({
      goal: "Work.",
      coordinatorBotId: bot.id,
      spendCapUsd: null,
    });
    expect(uncapped.task.spendCapUsd).toBeNull();
    // The view and summaries carry the cap too.
    expect((await engine.tasks.get(uncapped.task.id)).task.spendCapUsd).toBe(
      null,
    );
    const { tasks } = await engine.tasks.list();
    expect(
      tasks.find((summary) => summary.id === fromProfile.task.id)?.spendCapUsd,
    ).toBe(1.5);
  });

  it("validates cap changes and refuses them on a stopped task", async () => {
    const { engine } = await setup({ start: false });
    const team = await createTeam(engine, ["Ada"]);
    const { task } = await engine.tasks.create({
      goal: "Work.",
      coordinatorBotId: team.ids[0] as string,
    });
    await expect(engine.tasks.update(task.id, {})).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
    });
    await expect(
      engine.tasks.update(task.id, { spendCapUsd: -1 }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(
      (await engine.tasks.update(task.id, { spendCapUsd: null })).task
        .spendCapUsd,
    ).toBeNull();
    await engine.tasks.stop(task.id);
    await expect(
      engine.tasks.update(task.id, { spendCapUsd: 10 }),
    ).rejects.toMatchObject({ code: "TASK_TERMINAL" });
  });

  it("bounds the overshoot of parallel sessions to the calls already in flight", async () => {
    const { engine, executor } = await setup();
    const team = await createTeam(engine, ["Ada", "Bob", "Cy"]);
    const [ada, bob, cy] = team.names as [string, string, string];
    executor.brain(ada, delegatingCoordinator([bob, cy]));
    executor.brain(bob, tireless);
    executor.brain(cy, tireless);
    const { task } = await engine.tasks.create({
      goal: "Count in parallel.",
      coordinatorBotId: team.ids[0] as string,
      participantBotIds: team.ids,
      spendCapUsd: 0.055,
    });
    const view = await untilTask(
      engine,
      task.id,
      (next) =>
        next.task.status !== "running" &&
        next.sessions.every(
          (session) => !["running", "queued"].includes(session.status),
        ),
    );
    expect(view.task.status).toBe("waiting");
    // $0.06 crosses the cap; each of the three sessions may have had one call in flight.
    expect(modelCalls(view)).toBeGreaterThanOrEqual(6);
    expect(modelCalls(view)).toBeLessThanOrEqual(8);
    const workers = view.sessions.filter(
      (session) => session.role === "worker",
    );
    expect(workers).toHaveLength(2);
    for (const worker of workers) {
      expect(worker.status).toBe("completed");
      expect(worker.result).toContain(
        "(Stopped before finishing: The task reached its spend cap",
      );
    }
    expect(view.messages.at(-1)).toMatchObject({
      authorKind: "system",
      text: expect.stringMatching(/^Stopped: The task reached its spend cap/),
    });
  });

  it("still holds after a restart", async () => {
    const first = await setup();
    const team = await createTeam(first.engine, ["Ada"]);
    first.executor.brain(team.names[0] as string, tireless);
    const { task } = await first.engine.tasks.create({
      goal: "Count forever.",
      coordinatorBotId: team.ids[0] as string,
      spendCapUsd: 0.015,
    });
    await untilTask(first.engine, task.id, waitingForUser);
    await first.dispose();
    engines.splice(engines.indexOf(first), 1);
    const second = await setup();
    await expect(
      second.engine.tasks.postMessage(task.id, { text: "Again." }),
    ).rejects.toMatchObject({ code: "SPEND_CAP_REACHED" });
  });
});

describe("a bot's daily spend cap", () => {
  it("stops only that bot's sessions; the coordinator carries on with its result", async () => {
    const { engine, executor } = await setup();
    const profile = await profileWith(engine, { maxUsdPerBotPerDay: 0.02 });
    const team = await createTeam(engine, ["Ada"]);
    const [ada] = team.names as [string];
    const { bot: worker } = await engine.bots.create({
      name: `Penny${Date.now()}`,
      runtimeProfileId: profile.id,
    });
    executor.brain(ada, delegatingCoordinator([worker.name]));
    executor.brain(worker.name, tireless);
    const { task } = await engine.tasks.create({
      goal: "Delegate the counting.",
      coordinatorBotId: team.ids[0] as string,
      participantBotIds: [worker.id],
    });
    const view = await untilTask(
      engine,
      task.id,
      (next) => next.task.status === "completed",
    );
    const session = view.sessions.find((entry) => entry.botId === worker.id);
    expect(session?.result).toContain(
      `(Stopped before finishing: ${worker.name} reached its daily spend cap: $0.02 of $0.02 in the last 24 hours.)`,
    );
    expect(
      ofType(view, "model.finished").filter(
        (event) => event.botId === worker.id,
      ),
    ).toHaveLength(2);
    expect(
      ofType(view, "spend.capped").map((event) => [
        event.payload.scope,
        event.botId,
      ]),
    ).toEqual([["bot", worker.id]]);

    // A task it would coordinate, and its direct chat, are refused while it is at its cap.
    await expect(
      engine.tasks.create({ goal: "More.", coordinatorBotId: worker.id }),
    ).rejects.toMatchObject({
      code: "SPEND_CAP_REACHED",
      details: { scope: "bot", botId: worker.id },
    });
    await expect(
      engine.bots.sendMessage(worker.id, { text: "Hi" }),
    ).rejects.toMatchObject({ code: "SPEND_CAP_REACHED" });
  });

  it("fails a chat reply that reaches the worker after the cap, and records the usage of failed replies", async () => {
    const { engine, chat } = await setup({ start: false });
    const profile = await profileWith(engine, { maxUsdPerBotPerDay: 0.01 });
    const { bot } = await engine.bots.create({
      name: `Chatty${Date.now()}`,
      runtimeProfileId: profile.id,
    });
    chat.brain(bot.name, () => ({ text: "Hello!" }));
    await engine.bots.sendMessage(bot.id, { text: "Hi" });
    // Spend that lands after the message was accepted, before the reply runs.
    await db.database.db.insert(usage).values({
      id: `use_${Date.now()}`,
      botId: bot.id,
      model: FAKE_MODEL,
      costUsd: 0.01,
    });
    await engine.worker.start();
    const failed = await until(async () => {
      const view = conversationViewSchema.parse(
        await engine.bots.conversation(bot.id),
      );
      return view.lastReplyError ? view : undefined;
    });
    expect(failed.lastReplyError?.message).toBe(
      `Not answered: ${bot.name} reached its daily spend cap: $0.01 of $0.01 in the last 24 hours. Raise the cap in ${bot.name}'s runtime profile, or continue once its spend in the last 24 hours is below the cap.`,
    );
    expect(failed.messages.map((message) => message.role)).toEqual(["user"]);

    // A reply that fails after its model call still records the call.
    const { bot: other } = await engine.bots.create({
      name: `Broken${Date.now()}`,
    });
    chat.brain(other.name, () => {
      throw new Error("The model said nothing useful.");
    });
    await engine.bots.sendMessage(other.id, { text: "Hi" });
    const rows = await until(async () => {
      const found = await db.database.db
        .select()
        .from(usage)
        .where(and(eq(usage.botId, other.id), isNull(usage.taskId)));
      return found.length > 0 ? found : undefined;
    });
    expect(rows).toHaveLength(1);
  });
});

describe("direct chat replies and spend", () => {
  /** Completes the task with its first call. */
  const finisher: Brain = (view) =>
    said.turns(view) === 0
      ? { calls: [{ name: "complete_task", args: { result: "Done." } }] }
      : { text: "Done." };

  const chatRows = (botId: string) =>
    db.database.db
      .select()
      .from(usage)
      .where(and(eq(usage.botId, botId), isNull(usage.taskId)));

  it("records each call of a user reply and of an update reply once", async () => {
    const { engine, executor, chat } = await setup();
    const { bot } = await engine.bots.create({ name: `Tally${Date.now()}` });
    executor.brain(bot.name, finisher);
    chat.brain(bot.name, () => ({ text: "Noted." }));
    await engine.bots.sendMessage(bot.id, { text: "Hi" });
    await until(async () => (await chatRows(bot.id)).length === 1);
    const { task } = await engine.tasks.create({
      goal: "Finish.",
      coordinatorBotId: bot.id,
    });
    await untilTask(
      engine,
      task.id,
      (view) => view.task.status === "completed",
    );
    // The completion is told in the chat by an update reply: one more call.
    await until(async () => {
      const view = await engine.bots.conversation(bot.id);
      return view.messages.filter((m) => m.role === "assistant").length === 2;
    });
    const rows = await chatRows(bot.id);
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.priced && row.costUsd === 0.01)).toBe(true);
  });

  it("makes no model call for an update reply at the bot's cap, and tells the update plainly", async () => {
    const { engine, executor, chat } = await setup();
    const profile = await profileWith(engine, { maxUsdPerBotPerDay: 0.01 });
    const { bot } = await engine.bots.create({
      name: `Thrifty${Date.now()}`,
      runtimeProfileId: profile.id,
    });
    executor.brain(bot.name, finisher);
    const asked: string[] = [];
    chat.brain(bot.name, () => {
      asked.push("called");
      return { text: "Told in my words." };
    });
    // The task's one call ($0.01) brings the bot to its daily cap.
    const { task } = await engine.tasks.create({
      goal: "Finish.",
      coordinatorBotId: bot.id,
    });
    await untilTask(
      engine,
      task.id,
      (view) => view.task.status === "completed",
    );
    const view = await until(async () => {
      const current = await engine.bots.conversation(bot.id);
      return current.messages.length > 0 ? current : undefined;
    });
    expect(view.messages[0]?.text).toContain(
      "(Posted automatically: the reply to this update failed.)",
    );
    expect(view.messages[0]?.taskId).toBe(task.id);
    expect(asked).toEqual([]);
    expect(await chatRows(bot.id)).toHaveLength(0);
  });
});

describe("the instance's daily spend cap", () => {
  it("stops every bot once the whole server reached it", async () => {
    const own = await openTestDatabase();
    extraDatabases.push(own);
    const engine = await testEngine(own.database, {
      config: { maxUsdPerDay: 0.02 },
    });
    engines.push(engine);
    const team = await createTeam(engine.engine, ["Ada", "Bob"]);
    engine.executor.brain(team.names[0] as string, tireless);
    const { task } = await engine.engine.tasks.create({
      goal: "Count forever.",
      coordinatorBotId: team.ids[0] as string,
    });
    const view = await untilTask(engine.engine, task.id, waitingForUser);
    expect(modelCalls(view)).toBe(2);
    expect(ofType(view, "spend.capped")[0]?.payload).toMatchObject({
      scope: "instance",
      capUsd: 0.02,
    });
    expect(view.messages.at(-1)?.text).toContain(
      "This server reached its daily spend cap: $0.02 of $0.02 in the last 24 hours. Raise JJ_MAX_USD_PER_DAY",
    );
    // Another bot is refused as well.
    await expect(
      engine.engine.tasks.create({
        goal: "Other work.",
        coordinatorBotId: team.ids[1] as string,
      }),
    ).rejects.toMatchObject({
      code: "SPEND_CAP_REACHED",
      details: { scope: "instance" },
    });
    const report = usageReportSchema.parse(await engine.engine.usage());
    expect(report.instance.capUsdPerDay).toBe(0.02);
    expect(report.instance.last24h).toMatchObject({ modelCalls: 2 });
  });
});

describe("the usage report", () => {
  it("totals usage per window, per bot (chat apart) and per model, unpriced calls counted apart", async () => {
    const own = await openTestDatabase();
    extraDatabases.push(own);
    const engine = await testEngine(own.database);
    engines.push(engine);
    const profile = await profileWith(engine.engine, {
      maxUsdPerBotPerDay: 3,
    });
    const { bot: ada } = await engine.engine.bots.create({
      name: "Ada",
      runtimeProfileId: profile.id,
    });
    const { bot: bob } = await engine.engine.bots.create({ name: "Bob" });
    const now = engine.engine.context.clock().getTime();
    const day = 24 * 60 * 60_000;
    const rows = [
      // Ada: a task call now, a chat call now, an unpriced call and one 3 days ago.
      { botId: ada.id, model: "openai/a", costUsd: 0.5, at: now - 1_000 },
      {
        botId: ada.id,
        model: "openai/a",
        costUsd: 0.25,
        at: now - 2_000,
        chat: true,
      },
      {
        botId: ada.id,
        model: "free/b",
        costUsd: 0,
        at: now - 3_000,
        priced: false,
      },
      { botId: ada.id, model: "openai/a", costUsd: 1, at: now - 3 * day },
      // Bob: 10 days ago only; and something older than 30 days, not counted.
      { botId: bob.id, model: "openai/c", costUsd: 2, at: now - 10 * day },
      { botId: bob.id, model: "openai/c", costUsd: 9, at: now - 31 * day },
    ];
    const { task } = await engine.engine.tasks.create({
      goal: "Anything.",
      coordinatorBotId: ada.id,
      spendCapUsd: null,
    });
    await engine.engine.tasks.stop(task.id);
    for (const [index, row] of rows.entries())
      await own.database.db.insert(usage).values({
        id: `use_report_${index}`,
        taskId: row.chat ? null : task.id,
        botId: row.botId,
        model: row.model,
        inputTokens: 100,
        outputTokens: 10,
        costUsd: row.costUsd,
        priced: row.priced ?? true,
        createdAt: new Date(row.at),
      });

    const report = usageReportSchema.parse(await engine.engine.usage());
    expect(report.instance.last24h).toMatchObject({
      modelCalls: 3,
      costUsd: 0.75,
      unpricedCalls: 1,
      inputTokens: 300,
    });
    expect(report.instance.last7d).toMatchObject({
      modelCalls: 4,
      costUsd: 1.75,
    });
    expect(report.instance.last30d).toMatchObject({
      modelCalls: 5,
      costUsd: 3.75,
    });
    expect(report.instance.capUsdPerDay).toBeNull();
    const byBot = Object.fromEntries(
      report.bots.map((entry) => [entry.name, entry]),
    );
    expect(byBot.Ada).toMatchObject({
      botId: ada.id,
      archived: false,
      capUsdPerDay: 3,
      last24h: { modelCalls: 3, costUsd: 0.75, unpricedCalls: 1 },
      last30d: { modelCalls: 4, costUsd: 1.75 },
      chatLast30d: { modelCalls: 1, costUsd: 0.25 },
    });
    expect(byBot.Bob).toMatchObject({
      capUsdPerDay: 20,
      last24h: { modelCalls: 0, costUsd: 0 },
      last30d: { modelCalls: 1, costUsd: 2 },
    });
    expect(report.models.map((entry) => entry.model)).toEqual([
      "openai/c",
      "openai/a",
      "free/b",
    ]);
    expect(report.models[2]?.last30d).toMatchObject({
      modelCalls: 1,
      unpricedCalls: 1,
      costUsd: 0,
    });
  });
});
