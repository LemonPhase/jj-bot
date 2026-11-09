// Schedules end to end on a fake clock: saves and their refusals, the
// scheduler pass (exactly once per due time, also under two concurrent
// passes, the grace for missed times, skip on overlap, refusals at a cap and
// pauses on a template problem), chat updates and the workspaces a schedule
// keeps. Runs on PGlite, and on PostgreSQL with JJ_TEST_DATABASE_URL.
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ApprovalRule,
  type CreateScheduleCommand,
  MAX_ENABLED_SCHEDULES,
  MAX_SCHEDULES,
  type Schedule,
  scheduleListSchema,
  scheduleSchema,
  type TaskView,
  templateInUseDetailsSchema,
  type WorkspaceHint,
} from "@jj/contracts";
import {
  approvals,
  artifacts,
  chatTaskUpdates,
  instanceSettings,
  type ScheduleFireRow,
  scheduleFires,
  schedules,
  sessionEntries,
  sessionInbox,
  tasks,
  usage,
} from "@jj/db";
import { ModelRegistry, PiSessionExecutor } from "@jj/runtime";
import {
  callTool,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@jj/runtime/testing";
import { LocalSandboxDriver } from "@jj/sandbox";
import { and, asc, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDriverRegistry } from "./drivers";
import type { Engine } from "./engine";
import { DomainError } from "./errors";
import type { EngineDriver } from "./ports";
import { workspaceRemovedNotice } from "./services/messages";
import {
  type BrainView,
  FAKE_MODEL,
  type FakeMessage,
  said,
} from "./testing/fake-executor";
import {
  OPEN_TIMEOUT,
  openTestDatabase,
  quietLogger,
  type TestDatabase,
  type TestEngine,
  type TestEngineOptions,
  testEngine,
  uniqueName,
  until,
  untilTask,
} from "./testing/harness";
import { lastResult } from "./testing/scenarios";

/** The tool results after the last input that contains `text`. */
const resultsSince = (view: BrainView, text: string) => {
  let at = -1;
  view.messages.forEach((message, index) => {
    if (message.role === "user" && message.text.includes(text)) at = index;
  });
  return view.messages
    .slice(at + 1)
    .filter(
      (message): message is Extract<FakeMessage, { role: "tool" }> =>
        message.role === "tool",
    );
};

let db: TestDatabase;
const opened: TestEngine[] = [];
const roots: string[] = [];

beforeAll(async () => {
  db = await openTestDatabase();
}, OPEN_TIMEOUT);
afterEach(async () => {
  for (const engine of opened.splice(0)) await engine.dispose();
  // Schedules count against server-wide limits: each test starts with none.
  await db.database.db.delete(schedules);
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
afterAll(async () => {
  await db?.close();
});

/**
 * A clock the test moves; every engine of a test shares it. Its times lie in
 * the past: artifact snapshots credit files changed since a run started, by
 * the files' real modification times.
 */
function fakeClock(start: string) {
  let now = new Date(start);
  return {
    clock: () => new Date(now),
    set(at: string) {
      now = new Date(at);
    },
  };
}

type Clock = ReturnType<typeof fakeClock>;

/** An engine whose worker does not run unless asked, on the test's clock. */
async function setup(clock: Clock, options: TestEngineOptions = {}) {
  const engine = await testEngine(db.database, {
    start: false,
    clock: clock.clock,
    ...options,
    config: { schedulerIntervalMs: 3_600_000, ...options.config },
  });
  opened.push(engine);
  return engine;
}

/** A bot (on a profile with these budgets, when given) and a template it coordinates. */
async function templateFor(
  engine: Engine,
  options: {
    spendCapUsd?: number | null;
    budgets?: {
      maxUsdPerTask?: number | null;
      maxUsdPerBotPerDay?: number | null;
    };
    approvals?: ApprovalRule[];
    base?: string;
  } = {},
) {
  const profile =
    options.budgets || options.approvals
      ? (
          await engine.profiles.create({
            name: uniqueName("Sched profile"),
            sandbox: { driver: "local", network: { mode: "open" } },
            ...(options.budgets ? { budgets: options.budgets } : {}),
            ...(options.approvals ? { approvals: options.approvals } : {}),
          })
        ).profile
      : undefined;
  const { bot } = await engine.bots.create({
    name: uniqueName(options.base ?? "Sched"),
    ...(profile ? { runtimeProfileId: profile.id } : {}),
  });
  const { template } = await engine.templates.create({
    title: "Morning digest",
    goal: "Write the digest.",
    coordinatorBotId: bot.id,
    ...(options.spendCapUsd !== undefined
      ? { spendCapUsd: options.spendCapUsd }
      : { spendCapUsd: 2 }),
  });
  return { bot, template, profile };
}

const daily = (
  templateId: string,
  extra: Partial<CreateScheduleCommand> = {},
): CreateScheduleCommand => ({
  name: "Digest",
  templateId,
  trigger: { kind: "cron", cron: "0 9 * * *", timeZone: "UTC" },
  ...extra,
});

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DomainError);
  return error as DomainError;
}

async function firesOf(scheduleId: string): Promise<ScheduleFireRow[]> {
  return db.database.db
    .select()
    .from(scheduleFires)
    .where(eq(scheduleFires.scheduleId, scheduleId))
    .orderBy(asc(scheduleFires.scheduledFor), asc(scheduleFires.recordedAt));
}

async function tasksOf(scheduleId: string) {
  return db.database.db
    .select()
    .from(tasks)
    .where(eq(tasks.scheduleId, scheduleId))
    .orderBy(asc(tasks.createdAt), asc(tasks.id));
}

const pass = (engine: TestEngine) => engine.engine.worker.runSchedulerPass();

describe("saving a schedule", () => {
  it("stores the zone in canonical form and the next fire from now, and sends the hint", async () => {
    const clock = fakeClock("2026-01-13T08:00:00Z");
    const { engine } = await setup(clock);
    const { template } = await templateFor(engine);
    const hints: WorkspaceHint[] = [];
    const stop = await engine.subscribeHints((hint) => hints.push(hint));
    const { schedule } = await engine.schedules.create(
      daily(template.id, {
        name: "  Morning digest ",
        trigger: {
          kind: "cron",
          cron: "0  9 * * 1-5",
          timeZone: "europe/london",
        },
      }),
    );
    expect(scheduleSchema.parse(schedule)).toEqual(schedule);
    expect(schedule).toMatchObject({
      name: "Morning digest",
      trigger: { kind: "cron", cron: "0 9 * * 1-5", timeZone: "Europe/London" },
      enabled: true,
      overlap: "skip",
      keepWorkspaces: 10,
      chatUpdates: "attention",
      instructions: "",
      nextFireAt: "2026-01-13T09:00:00.000Z",
      pausedReason: null,
      lastFire: null,
    });
    await until(() => hints.some((hint) => hint.type === "schedules.changed"));
    await stop();
    const list = scheduleListSchema.parse(await engine.schedules.list());
    expect(list.schedules.map((entry) => entry.id)).toEqual([schedule.id]);
    expect(list.scheduler).toEqual({
      lastPassAt: null,
      minIntervalMinutes: 60,
      graceMinutes: 60,
    });
  });

  it("refuses a bad trigger, a gap under the minimum, a schedule that never runs, and a template without a cap", async () => {
    const clock = fakeClock("2026-01-13T08:00:00Z");
    const { engine } = await setup(clock);
    const { template } = await templateFor(engine);
    const cases: [CreateScheduleCommand["trigger"], RegExp][] = [
      [
        { kind: "cron", cron: "*/30 * * * *", timeZone: "UTC" },
        /30 minutes apart at times, under this server's minimum of 60/,
      ],
      [
        { kind: "cron", cron: "0 0 30 2 *", timeZone: "UTC" },
        /never runs: no time in the next 8 years/,
      ],
      [{ kind: "cron", cron: "@daily", timeZone: "UTC" }, /Macros/],
      [
        { kind: "cron", cron: "0 9 * * *", timeZone: "Mars/Base" },
        /not a time zone/,
      ],
    ];
    for (const [trigger, message] of cases) {
      const error = await refusal(
        engine.schedules.create(daily(template.id, { trigger })),
      );
      expect(error.code).toBe("VALIDATION_FAILED");
      expect(error.message).toMatch(message);
    }
    const uncapped = await templateFor(engine, { spendCapUsd: null });
    expect(
      (await refusal(engine.schedules.create(daily(uncapped.template.id))))
        .message,
    ).toMatch(/no spend cap, and a scheduled task needs one/);
    // A template that takes its coordinator's profile cap, which is none.
    const inherited = await templateFor(engine, {
      budgets: { maxUsdPerTask: null },
    });
    await engine.templates.update(inherited.template.id, {
      spendCapUsd: "profile",
    });
    expect(
      (await refusal(engine.schedules.create(daily(inherited.template.id))))
        .code,
    ).toBe("VALIDATION_FAILED");
    expect(
      (await refusal(engine.schedules.create(daily("tmpl_missing")))).message,
    ).toMatch(/unknown task template/);
    expect((await engine.schedules.list()).schedules).toEqual([]);
  });

  it(`keeps at most ${MAX_SCHEDULES} schedules and ${MAX_ENABLED_SCHEDULES} enabled`, async () => {
    const clock = fakeClock("2026-01-13T08:00:00Z");
    const { engine } = await setup(clock);
    const { template } = await templateFor(engine);
    const saved: Schedule[] = [];
    for (let index = 0; index < MAX_SCHEDULES; index += 1)
      saved.push(
        (
          await engine.schedules.create(
            daily(template.id, {
              name: `Digest ${index}`,
              enabled: index < MAX_ENABLED_SCHEDULES,
            }),
          )
        ).schedule,
      );
    expect(
      (
        await refusal(
          engine.schedules.create(daily(template.id, { enabled: false })),
        )
      ).code,
    ).toBe("CONFLICT");
    const disabled = saved[MAX_ENABLED_SCHEDULES] as Schedule;
    const tooMany = await refusal(
      engine.schedules.update(disabled.id, { enabled: true }),
    );
    expect(tooMany.code).toBe("CONFLICT");
    expect(tooMany.message).toMatch(/At most 20 schedules can be enabled/);
    // One enabled schedule less, and enabling another fits.
    await engine.schedules.update((saved[0] as Schedule).id, {
      enabled: false,
    });
    const enabled = await engine.schedules.update(disabled.id, {
      enabled: true,
    });
    expect(enabled.schedule.nextFireAt).toBe("2026-01-13T09:00:00.000Z");
  });

  it("refuses to delete a template a schedule starts, with TEMPLATE_IN_USE", async () => {
    const clock = fakeClock("2026-01-13T08:00:00Z");
    const { engine } = await setup(clock);
    const { template } = await templateFor(engine);
    const { schedule } = await engine.schedules.create(daily(template.id));
    const error = await refusal(engine.templates.delete(template.id));
    expect(error.code).toBe("TEMPLATE_IN_USE");
    expect(error.status).toBe(409);
    expect(templateInUseDetailsSchema.parse(error.details)).toEqual({
      schedules: [{ id: schedule.id, name: "Digest" }],
    });
    await engine.schedules.delete(schedule.id);
    await engine.templates.delete(template.id);
    expect((await refusal(engine.schedules.get(schedule.id))).code).toBe(
      "NOT_FOUND",
    );
  });
});

describe("the scheduler pass", () => {
  it("starts one task per due time through the template's start, attributed and briefed", async () => {
    const clock = fakeClock("2026-01-13T08:00:00Z");
    const engine = await setup(clock);
    const { template, bot } = await templateFor(engine.engine);
    const { schedule } = await engine.engine.schedules.create(
      daily(template.id, {
        name: "Digest",
        instructions: "Cover the weekend too.",
        trigger: { kind: "cron", cron: "0 9 * * *", timeZone: "Europe/London" },
      }),
    );
    clock.set("2026-01-13T08:59:59Z");
    expect((await pass(engine)).outcomes).toEqual([]);
    clock.set("2026-01-13T09:00:30Z");
    expect((await pass(engine)).outcomes).toEqual([
      { scheduleId: schedule.id, outcome: "started" },
    ]);
    // A second pass in the same minute finds nothing due.
    expect((await pass(engine)).outcomes).toEqual([]);

    const [task] = await tasksOf(schedule.id);
    expect(task).toMatchObject({
      templateId: template.id,
      scheduleId: schedule.id,
      coordinatorBotId: bot.id,
      goal: "Write the digest.\n\nInstructions for this run:\nCover the weekend too.",
      spendCapUsd: 2,
      chatUpdates: "attention",
    });
    const view = await engine.engine.tasks.get(task?.id as string);
    expect(view.task.scheduleId).toBe(schedule.id);
    const [brief] = await db.database.db
      .select()
      .from(sessionInbox)
      .where(eq(sessionInbox.taskId, task?.id as string));
    expect(brief?.text).toMatch(
      /\n\nStarted by schedule "Digest" for 2026-01-13 09:00 Europe\/London; the user may not be watching\.$/,
    );

    const [fire] = await firesOf(schedule.id);
    expect(fire).toMatchObject({
      outcome: "started",
      taskId: task?.id,
      missedCount: 0,
      reason: null,
    });
    expect(fire?.scheduledFor.toISOString()).toBe("2026-01-13T09:00:00.000Z");
    const { schedule: after, fires } = await engine.engine.schedules.get(
      schedule.id,
    );
    expect(after.nextFireAt).toBe("2026-01-14T09:00:00.000Z");
    expect(after.lastFire?.id).toBe(fire?.id);
    expect(fires.map((entry) => entry.outcome)).toEqual(["started"]);
    expect((await engine.engine.schedules.list()).scheduler.lastPassAt).toBe(
      "2026-01-13T09:00:30.000Z",
    );
  });

  it("starts exactly one task per due time when two workers pass at once", async () => {
    const clock = fakeClock("2026-01-13T08:00:00Z");
    const first = await setup(clock);
    const second = await setup(clock);
    const { template } = await templateFor(first.engine);
    const ids: string[] = [];
    for (let index = 0; index < 12; index += 1)
      ids.push(
        (
          await first.engine.schedules.create(
            daily(template.id, { name: `Race ${index}` }),
          )
        ).schedule.id,
      );
    const warned = quietLogger.warnings.length;
    for (const round of ["2026-01-13T09:00:05Z", "2026-01-14T09:00:05Z"]) {
      clock.set(round);
      // Each round, the tasks of the last finish first: nothing is skipped.
      await db.database.db
        .update(tasks)
        .set({ status: "completed" })
        .where(inArray(tasks.scheduleId, ids));
      const [a, b] = await Promise.all([pass(first), pass(second)]);
      const handled = [...(a?.outcomes ?? []), ...(b?.outcomes ?? [])];
      // Each schedule handled once, by one of the two passes...
      expect(handled.map((entry) => entry.scheduleId).sort()).toEqual(
        [...ids].sort(),
      );
    }
    // ...which never took one the other held: no transaction lost a race.
    expect(
      quietLogger.warnings
        .slice(warned)
        .filter((line) => line.includes("could not handle schedule")),
    ).toEqual([]);
    for (const id of ids) {
      const fires = await firesOf(id);
      expect(fires.map((fire) => fire.outcome)).toEqual(["started", "started"]);
      const started = await tasksOf(id);
      expect(started).toHaveLength(2);
      expect(fires.map((fire) => fire.taskId)).toEqual(
        started.map((task) => task.id),
      );
    }
  });

  it("starts the latest due time after a downtime within the grace, and records the earlier ones missed", async () => {
    const clock = fakeClock("2026-01-13T08:00:00Z");
    const engine = await setup(clock);
    const { template } = await templateFor(engine.engine);
    const { schedule } = await engine.engine.schedules.create(
      daily(template.id),
    );
    // Down across three due times; back 20 minutes after the third.
    clock.set("2026-01-15T09:20:00Z");
    expect((await pass(engine)).outcomes).toEqual([
      { scheduleId: schedule.id, outcome: "started" },
    ]);
    const fires = await firesOf(schedule.id);
    expect(
      fires.map((fire) => [
        fire.outcome,
        fire.scheduledFor.toISOString(),
        fire.missedCount,
      ]),
    ).toEqual([
      ["missed", "2026-01-13T09:00:00.000Z", 2],
      ["started", "2026-01-15T09:00:00.000Z", 0],
    ]);
    expect(fires[0]?.reason).toMatch(
      /did not run within 60 minutes of these 2 times/,
    );
    expect(await tasksOf(schedule.id)).toHaveLength(1);
    expect(
      (await engine.engine.schedules.get(schedule.id)).schedule,
    ).toMatchObject({
      nextFireAt: "2026-01-16T09:00:00.000Z",
      lastFire: { outcome: "started" },
    });
  });

  it("records only missed after a downtime past the grace, and starts nothing", async () => {
    const clock = fakeClock("2026-01-13T08:00:00Z");
    const engine = await setup(clock);
    const { template } = await templateFor(engine.engine);
    const { schedule } = await engine.engine.schedules.create(
      daily(template.id),
    );
    clock.set("2026-01-15T10:30:00Z");
    expect((await pass(engine)).outcomes).toEqual([
      { scheduleId: schedule.id, outcome: "missed" },
    ]);
    const fires = await firesOf(schedule.id);
    expect(
      fires.map((fire) => [
        fire.outcome,
        fire.scheduledFor.toISOString(),
        fire.missedCount,
      ]),
    ).toEqual([["missed", "2026-01-13T09:00:00.000Z", 3]]);
    expect(await tasksOf(schedule.id)).toEqual([]);
    expect(
      (await engine.engine.schedules.get(schedule.id)).schedule.nextFireAt,
    ).toBe("2026-01-16T09:00:00.000Z");
  });

  it("never back-fills: enabling or editing computes the next fire from now", async () => {
    const clock = fakeClock("2026-01-13T08:00:00Z");
    const engine = await setup(clock);
    const { template } = await templateFor(engine.engine);
    const { schedule } = await engine.engine.schedules.create(
      daily(template.id, { enabled: false }),
    );
    expect(schedule.nextFireAt).toBeNull();
    clock.set("2026-01-15T12:00:00Z");
    expect((await pass(engine)).outcomes).toEqual([]);
    const enabled = await engine.engine.schedules.update(schedule.id, {
      enabled: true,
    });
    expect(enabled.schedule.nextFireAt).toBe("2026-01-16T09:00:00.000Z");
    // Due, then edited before a pass: the edit moves it past now.
    clock.set("2026-01-16T09:00:10Z");
    const edited = await engine.engine.schedules.update(schedule.id, {
      name: "Renamed",
    });
    expect(edited.schedule.nextFireAt).toBe("2026-01-17T09:00:00.000Z");
    expect((await pass(engine)).outcomes).toEqual([]);
    expect(await firesOf(schedule.id)).toEqual([]);
  });

  it("follows the zone's wall clock across daylight saving, firing a repeated time once", async () => {
    // 01:30 in London happens twice on 25 October 2026.
    const clock = fakeClock("2026-10-24T12:00:00Z");
    const engine = await setup(clock);
    const { template } = await templateFor(engine.engine);
    const { schedule } = await engine.engine.schedules.create(
      daily(template.id, {
        trigger: {
          kind: "cron",
          cron: "30 1 * * *",
          timeZone: "Europe/London",
        },
      }),
    );
    expect(schedule.nextFireAt).toBe("2026-10-25T00:30:00.000Z");
    clock.set("2026-10-25T00:30:10Z");
    expect((await pass(engine)).outcomes).toEqual([
      { scheduleId: schedule.id, outcome: "started" },
    ]);
    // The second 01:30 (01:30 GMT) is not a fire: the next is a day later.
    expect(
      (await engine.engine.schedules.get(schedule.id)).schedule.nextFireAt,
    ).toBe("2026-10-26T01:30:00.000Z");
  });

  it("skips a due time while the previous task has not finished", async () => {
    const clock = fakeClock("2026-01-13T08:00:00Z");
    const engine = await setup(clock);
    const { template } = await templateFor(engine.engine);
    const { schedule } = await engine.engine.schedules.create(
      daily(template.id),
    );
    clock.set("2026-01-13T09:00:01Z");
    await pass(engine);
    const [first] = await tasksOf(schedule.id);
    // No worker runs it, so it is still queued a day later.
    clock.set("2026-01-14T09:00:01Z");
    expect((await pass(engine)).outcomes).toEqual([
      { scheduleId: schedule.id, outcome: "skipped" },
    ]);
    const fires = await firesOf(schedule.id);
    expect(fires.at(-1)).toMatchObject({
      outcome: "skipped",
      taskId: first?.id,
      reason: "The previous run has not finished.",
    });
    expect(await tasksOf(schedule.id)).toHaveLength(1);
  });

  it("refuses a fire at a bot's cap with SPEND_CAP_REACHED's details, and stays enabled", async () => {
    const clock = fakeClock("2026-01-13T08:00:00Z");
    const engine = await setup(clock);
    const { template, bot } = await templateFor(engine.engine, {
      budgets: { maxUsdPerBotPerDay: 0.01 },
    });
    const { schedule } = await engine.engine.schedules.create(
      daily(template.id),
    );
    await db.database.db.insert(usage).values({
      id: `use_sched_${Date.now()}`,
      botId: bot.id,
      model: FAKE_MODEL,
      costUsd: 0.01,
      createdAt: new Date("2026-01-13T08:30:00Z"),
    });
    clock.set("2026-01-13T09:00:01Z");
    expect((await pass(engine)).outcomes).toEqual([
      { scheduleId: schedule.id, outcome: "refused" },
    ]);
    const { schedule: after, fires } = await engine.engine.schedules.get(
      schedule.id,
    );
    expect(fires[0]).toMatchObject({
      outcome: "refused",
      code: "SPEND_CAP_REACHED",
      details: { scope: "bot", spentUsd: 0.01, capUsd: 0.01, botId: bot.id },
      taskId: null,
    });
    expect(fires[0]?.reason).toMatch(/reached its daily spend cap/);
    expect(after).toMatchObject({
      enabled: true,
      pausedReason: null,
      nextFireAt: "2026-01-14T09:00:00.000Z",
    });
    expect(await tasksOf(schedule.id)).toEqual([]);
  });

  it("refuses and pauses on an archived bot; enabling again never back-fills", async () => {
    const clock = fakeClock("2026-01-13T08:00:00Z");
    const engine = await setup(clock);
    const { template, bot } = await templateFor(engine.engine);
    const { schedule } = await engine.engine.schedules.create(
      daily(template.id),
    );
    await engine.engine.bots.archive(bot.id);
    clock.set("2026-01-13T09:00:01Z");
    expect((await pass(engine)).outcomes).toEqual([
      { scheduleId: schedule.id, outcome: "refused" },
    ]);
    const { schedule: paused, fires } = await engine.engine.schedules.get(
      schedule.id,
    );
    expect(fires[0]).toMatchObject({
      outcome: "refused",
      code: "TEMPLATE_UNUSABLE",
      details: { problems: [{ kind: "bot_archived", botId: bot.id }] },
    });
    expect(paused).toMatchObject({
      enabled: false,
      pausedReason: "template_unusable",
      nextFireAt: null,
    });
    // Days later, enabled again: the next fire is from now.
    clock.set("2026-01-16T12:00:00Z");
    expect((await pass(engine)).outcomes).toEqual([]);
    const { schedule: enabled } = await engine.engine.schedules.update(
      schedule.id,
      { enabled: true },
    );
    expect(enabled).toMatchObject({
      enabled: true,
      pausedReason: null,
      nextFireAt: "2026-01-17T09:00:00.000Z",
    });
    expect(await firesOf(schedule.id)).toHaveLength(1);
  });

  it("refuses and pauses when the profile's task cap becomes none, and re-checks the minimum interval", async () => {
    const clock = fakeClock("2026-01-13T08:00:00Z");
    const engine = await setup(clock);
    const { template, profile } = await templateFor(engine.engine, {
      budgets: { maxUsdPerTask: 3 },
    });
    await engine.engine.templates.update(template.id, {
      spendCapUsd: "profile",
    });
    const { schedule } = await engine.engine.schedules.create(
      daily(template.id),
    );
    await engine.engine.profiles.update(profile?.id as string, {
      budgets: { maxUsdPerTask: null },
    });
    clock.set("2026-01-13T09:00:01Z");
    await pass(engine);
    const [refused] = await firesOf(schedule.id);
    expect(refused).toMatchObject({
      outcome: "refused",
      code: "VALIDATION_FAILED",
    });
    expect(refused?.reason).toMatch(/no spend cap/);
    expect(
      (await engine.engine.schedules.get(schedule.id)).schedule,
    ).toMatchObject({
      enabled: false,
      pausedReason: "template_unusable",
    });

    // An hourly schedule saved at a 60-minute minimum, fired by a server whose minimum is now 120.
    const { template: hourlyTemplate } = await templateFor(engine.engine);
    const { schedule: hourly } = await engine.engine.schedules.create(
      daily(hourlyTemplate.id, {
        trigger: { kind: "cron", cron: "0 * * * *", timeZone: "UTC" },
      }),
    );
    const strict = await setup(clock, {
      config: { scheduleMinIntervalMinutes: 120 },
    });
    clock.set("2026-01-13T10:00:01Z");
    await pass(strict);
    const [tooOften] = await firesOf(hourly.id);
    expect(tooOften).toMatchObject({
      outcome: "refused",
      code: "VALIDATION_FAILED",
    });
    expect(tooOften?.reason).toMatch(
      /60 minutes apart at times, under this server's minimum of 120/,
    );
    expect(await tasksOf(hourly.id)).toEqual([]);
  });

  it("deletes a schedule's fires with it, and leaves its tasks running with their scheduleId", async () => {
    const clock = fakeClock("2026-01-13T08:00:00Z");
    const engine = await setup(clock);
    const { template } = await templateFor(engine.engine);
    const { schedule } = await engine.engine.schedules.create(
      daily(template.id),
    );
    clock.set("2026-01-13T09:00:01Z");
    await pass(engine);
    await engine.engine.schedules.delete(schedule.id);
    expect(await firesOf(schedule.id)).toEqual([]);
    const [task] = await tasksOf(schedule.id);
    expect(task).toMatchObject({ scheduleId: schedule.id, status: "queued" });
  });

  it("records the pass in instance settings even with nothing due", async () => {
    const clock = fakeClock("2026-01-13T08:00:00Z");
    const engine = await setup(clock);
    await pass(engine);
    const [row] = await db.database.db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.key, "scheduler.last_pass_at"));
    expect(row?.value).toBe("2026-01-13T08:00:00.000Z");
  });
});

describe("a schedule that no longer passes the save checks", () => {
  /** An hourly schedule, saved at a 60-minute minimum, and an engine whose minimum is now 120. */
  async function tooOften() {
    const clock = fakeClock("2026-01-13T08:00:00Z");
    const engine = await setup(clock);
    const { template } = await templateFor(engine.engine);
    const { schedule } = await engine.engine.schedules.create(
      daily(template.id, {
        trigger: { kind: "cron", cron: "0 * * * *", timeZone: "UTC" },
      }),
    );
    const strict = await setup(clock, {
      config: { scheduleMinIntervalMinutes: 120 },
    });
    return { clock, schedule, strict };
  }

  it("can still be renamed, retuned and turned off", async () => {
    const { schedule, strict } = await tooOften();
    const { schedule: renamed } = await strict.engine.schedules.update(
      schedule.id,
      { name: "Renamed", chatUpdates: "all", keepWorkspaces: 2 },
    );
    expect(renamed).toMatchObject({
      name: "Renamed",
      enabled: true,
      chatUpdates: "all",
      keepWorkspaces: 2,
      nextFireAt: "2026-01-13T09:00:00.000Z",
    });
    const { schedule: off } = await strict.engine.schedules.update(
      schedule.id,
      { enabled: false },
    );
    expect(off).toMatchObject({ enabled: false, nextFireAt: null });
    // Turning it on again is checked as a save.
    expect(
      (
        await refusal(
          strict.engine.schedules.update(schedule.id, { enabled: true }),
        )
      ).code,
    ).toBe("VALIDATION_FAILED");
  });

  it("applies a patch that repeats its trigger and template unchanged, as an editor sends them", async () => {
    const { schedule, strict } = await tooOften();
    const repeated = {
      templateId: schedule.templateId,
      // The stored trigger, spelled loosely: the same times.
      trigger: { kind: "cron" as const, cron: " 0  * * * * ", timeZone: "utc" },
      instructions: schedule.instructions,
      keepWorkspaces: schedule.keepWorkspaces,
      chatUpdates: schedule.chatUpdates,
    };
    const { schedule: renamed } = await strict.engine.schedules.update(
      schedule.id,
      { ...repeated, name: "Hourly", enabled: true },
    );
    expect(renamed).toMatchObject({
      name: "Hourly",
      enabled: true,
      trigger: { kind: "cron", cron: "0 * * * *", timeZone: "UTC" },
    });
    const { schedule: off } = await strict.engine.schedules.update(
      schedule.id,
      { ...repeated, name: "Hourly", enabled: false },
    );
    expect(off).toMatchObject({ enabled: false, nextFireAt: null });
    // Times that do change are checked, on a disabled schedule too.
    expect(
      (
        await refusal(
          strict.engine.schedules.update(schedule.id, {
            ...repeated,
            trigger: { kind: "cron", cron: "30 * * * *", timeZone: "UTC" },
          }),
        )
      ).code,
    ).toBe("VALIDATION_FAILED");
  });

  it("pauses at its next due time with the reason, instead of refusing every one", async () => {
    const { clock, schedule, strict } = await tooOften();
    clock.set("2026-01-13T09:00:01Z");
    await pass(strict);
    clock.set("2026-01-13T10:00:01Z");
    await pass(strict);
    const fires = await firesOf(schedule.id);
    expect(fires.map((fire) => [fire.outcome, fire.code])).toEqual([
      ["refused", "VALIDATION_FAILED"],
    ]);
    const { schedule: paused } = await strict.engine.schedules.get(schedule.id);
    expect(paused).toMatchObject({
      enabled: false,
      pausedReason: "interval_too_short",
      nextFireAt: null,
    });
    expect(await tasksOf(schedule.id)).toEqual([]);
  });

  it("can be turned off while its template's task cap resolves to none", async () => {
    const clock = fakeClock("2026-01-13T08:00:00Z");
    const engine = await setup(clock);
    const { template, profile } = await templateFor(engine.engine, {
      budgets: { maxUsdPerTask: 3 },
    });
    await engine.engine.templates.update(template.id, {
      spendCapUsd: "profile",
    });
    const { schedule } = await engine.engine.schedules.create(
      daily(template.id),
    );
    await engine.engine.profiles.update(profile?.id as string, {
      budgets: { maxUsdPerTask: null },
    });
    const { schedule: off } = await engine.engine.schedules.update(
      schedule.id,
      { enabled: false },
    );
    expect(off).toMatchObject({ enabled: false, nextFireAt: null });
    // Changing its template or turning it on is checked as a save.
    expect(
      (
        await refusal(
          engine.engine.schedules.update(schedule.id, { enabled: true }),
        )
      ).message,
    ).toMatch(/no spend cap/);
  });
});

describe("a schedule's tasks", () => {
  it("tell their chat only what needs the user with attention, and every update with all", async () => {
    const clock = fakeClock("2026-01-13T08:00:00Z");
    const engine = await setup(clock);
    const { template, bot } = await templateFor(engine.engine);
    engine.executor.brain(bot.name, (view) =>
      view.input.systemPrompt.includes("Ask the user")
        ? { text: "Which week should I cover?" }
        : lastResult(view)?.name === "complete_task"
          ? { text: "done" }
          : {
              calls: [
                { name: "complete_task", args: { result: "Digest written." } },
              ],
            },
    );
    engine.chat.brain(bot.name, () => ({ text: "Noted." }));
    const { schedule: quiet } = await engine.engine.schedules.create(
      daily(template.id, { name: "Quiet" }),
    );
    const { template: asking } = await engine.engine.templates.create({
      title: "Ask",
      goal: "Ask the user which week to cover.",
      coordinatorBotId: bot.id,
      spendCapUsd: 2,
    });
    const { schedule: askingSchedule } = await engine.engine.schedules.create(
      daily(asking.id, { name: "Asking" }),
    );
    const { template: loud } = await engine.engine.templates.create({
      title: "Loud",
      goal: "Write the digest, loudly.",
      coordinatorBotId: bot.id,
      spendCapUsd: 2,
    });
    const { schedule: loudSchedule } = await engine.engine.schedules.create(
      daily(loud.id, { name: "Loud", chatUpdates: "all" }),
    );
    clock.set("2026-01-13T09:00:01Z");
    await pass(engine);
    await engine.engine.worker.start();
    const [quietTask] = await tasksOf(quiet.id);
    const [askingTask] = await tasksOf(askingSchedule.id);
    const [loudTask] = await tasksOf(loudSchedule.id);
    await untilTask(
      engine.engine,
      quietTask?.id as string,
      (v) => v.task.status === "completed",
    );
    await untilTask(
      engine.engine,
      askingTask?.id as string,
      (v) => v.task.status === "waiting",
    );
    await untilTask(
      engine.engine,
      loudTask?.id as string,
      (v) => v.task.status === "completed",
    );
    const updates = await db.database.db
      .select()
      .from(chatTaskUpdates)
      .where(
        inArray(chatTaskUpdates.taskId, [
          quietTask?.id as string,
          askingTask?.id as string,
          loudTask?.id as string,
        ]),
      );
    const told = (taskId: string | undefined) =>
      updates.filter((update) => update.taskId === taskId).map((u) => u.event);
    expect(told(quietTask?.id)).toEqual([]);
    expect(told(askingTask?.id)).toEqual(["waiting"]);
    expect(told(loudTask?.id)).toEqual(["completed"]);
  });

  it("keep the newest keepWorkspaces finished workspaces; an older one is removed, its record kept, and a continuation starts fresh and says so", async () => {
    const clock = fakeClock("2026-01-13T08:00:00Z");
    const root = await mkdtemp(join(tmpdir(), "jj-sched-"));
    roots.push(root);
    const engine = await setup(clock, { workspaceRoot: root });
    const { template, bot } = await templateFor(engine.engine);
    engine.executor.brain(bot.name, (view) => {
      if (said.heard(view, "workspace was removed")) {
        const since = resultsSince(view, "workspace was removed");
        const last = since.at(-1);
        if (!last)
          return {
            calls: [
              {
                name: "bash",
                args: {
                  command: "test -e notes.md && echo kept || echo fresh",
                },
              },
            ],
          };
        return last.name === "complete_task"
          ? { text: "done" }
          : {
              calls: [
                { name: "complete_task", args: { result: last.text.trim() } },
              ],
            };
      }
      if (said.turns(view) === 0)
        return {
          calls: [
            { name: "write", args: { path: "notes.md", content: "# Notes\n" } },
          ],
        };
      return lastResult(view)?.name === "complete_task"
        ? { text: "done" }
        : { calls: [{ name: "complete_task", args: { result: "ok" } }] };
    });
    const { schedule } = await engine.engine.schedules.create(
      daily(template.id, { keepWorkspaces: 1 }),
    );
    const finishRun = async (at: string) => {
      clock.set(at);
      await pass(engine);
      await engine.engine.worker.start();
      const started = await tasksOf(schedule.id);
      await untilTask(
        engine.engine,
        started.at(-1)?.id as string,
        (v) =>
          v.task.status === "completed" &&
          v.artifacts.some((artifact) => artifact.path === "notes.md"),
      );
      // Stopping releases every sandbox, so nothing holds a workspace.
      await engine.engine.worker.stop();
    };
    await finishRun("2026-01-13T09:00:01Z");
    await finishRun("2026-01-14T09:00:01Z");
    const [oldest, newer] = await tasksOf(schedule.id);
    const dir = (taskId: string | undefined) =>
      join(root, "task", taskId as string);
    expect(existsSync(join(dir(oldest?.id), "notes.md"))).toBe(true);
    expect(existsSync(join(dir(newer?.id), "notes.md"))).toBe(true);

    // The third start removes the oldest finished workspace beyond one.
    clock.set("2026-01-15T09:00:01Z");
    expect((await pass(engine)).outcomes).toEqual([
      { scheduleId: schedule.id, outcome: "started" },
    ]);
    expect(existsSync(dir(oldest?.id))).toBe(false);
    expect(existsSync(join(dir(newer?.id), "notes.md"))).toBe(true);
    const [marked] = await db.database.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, oldest?.id as string));
    expect(marked?.workspaceRemovedAt?.toISOString()).toBe(
      "2026-01-15T09:00:01.000Z",
    );
    const view: TaskView = await engine.engine.tasks.get(oldest?.id as string);
    expect(
      view.events.filter((event) => event.type === "workspace.removed"),
    ).toEqual([
      expect.objectContaining({
        payload: { scheduleId: schedule.id, keepWorkspaces: 1 },
      }),
    ]);
    // The record stays: artifacts and transcripts.
    expect(
      (
        await db.database.db
          .select({ id: artifacts.id })
          .from(artifacts)
          .where(eq(artifacts.taskId, oldest?.id as string))
      ).length,
    ).toBeGreaterThan(0);
    expect(
      (
        await db.database.db
          .select({ sessionId: sessionEntries.sessionId })
          .from(sessionEntries)
          .where(
            inArray(
              sessionEntries.sessionId,
              view.sessions.map((session) => session.id),
            ),
          )
      ).length,
    ).toBeGreaterThan(0);

    // Continued: the coordinator is told first, and the workspace is fresh.
    await engine.engine.worker.start();
    await engine.engine.tasks.postMessage(oldest?.id as string, {
      text: "Check the notes again.",
    });
    const continued = await untilTask(
      engine.engine,
      oldest?.id as string,
      (v) => v.task.status === "completed" && v.task.result !== "ok",
      "the continued task",
    );
    expect(continued.task.result).toBe("fresh");
    const [steering] = await db.database.db
      .select()
      .from(sessionInbox)
      .where(
        and(
          eq(sessionInbox.taskId, oldest?.id as string),
          eq(sessionInbox.kind, "steering"),
        ),
      );
    expect(steering?.text).toBe(
      `${workspaceRemovedNotice(new Date("2026-01-15T09:00:01Z"))}\n\nMessage from the user:\nCheck the notes again.`,
    );
    const [cleared] = await db.database.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, oldest?.id as string));
    expect(cleared?.workspaceRemovedAt).toBeNull();
  });
});

describe("a held approval", () => {
  it("skips the next due time while the call waits, never runs the call for it, and starts again once answered and finished", async () => {
    // Ahead of real time: the pi runtime ends a run at its deadline (the
    // run's start on this clock plus its budget) by the real clock.
    const clock = fakeClock("2027-01-13T08:00:00Z");
    const root = await mkdtemp(join(tmpdir(), "jj-sched-approval-"));
    roots.push(root);
    const push = "echo ran >> pushed.txt # git push";
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("bash", { command: push }, { id: "push" }),
        {
          stopReason: "toolUse",
        },
      ),
      () => callTool("complete_task", { result: "Pushed." }),
      () => callTool("complete_task", { result: "Second run." }),
      () => fauxAssistantMessage(fauxText("done")),
    ]);
    const engine = await setup(clock, {
      workspaceRoot: root,
      runExecutor: new PiSessionExecutor({
        models: new ModelRegistry({ env: {}, extraProviders: [faux.provider] }),
      }),
    });
    const { template } = await templateFor(engine.engine, {
      approvals: [{ tool: "bash", match: "git push" }],
    });
    const { schedule } = await engine.engine.schedules.create(
      daily(template.id, {
        trigger: { kind: "cron", cron: "0 * * * *", timeZone: "UTC" },
      }),
    );
    clock.set("2027-01-13T09:00:01Z");
    await pass(engine);
    await engine.engine.worker.start();
    const [first] = await tasksOf(schedule.id);
    const held = await untilTask(
      engine.engine,
      first?.id as string,
      (v) =>
        v.task.status === "waiting" &&
        v.approvals.some((approval) => approval.status === "pending"),
      "the held call",
    );
    const approval = held.approvals[0];
    const pushes = () =>
      existsSync(join(root, "task", first?.id as string, "pushed.txt"));

    clock.set("2027-01-13T10:00:01Z");
    expect((await pass(engine)).outcomes).toEqual([
      { scheduleId: schedule.id, outcome: "skipped" },
    ]);
    const skipped = (await firesOf(schedule.id)).at(-1);
    expect(skipped).toMatchObject({
      outcome: "skipped",
      taskId: first?.id,
      reason: "The previous run is waiting for your approval.",
    });
    // The call still waits, and never ran.
    const [stillPending] = await db.database.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approval?.id as string));
    expect(stillPending).toMatchObject({ status: "pending", startedAt: null });
    expect(pushes()).toBe(false);
    expect(await tasksOf(schedule.id)).toHaveLength(1);

    await engine.engine.tasks.decideApproval(
      first?.id as string,
      approval?.id as string,
      {
        decision: "approve",
      },
    );
    await untilTask(
      engine.engine,
      first?.id as string,
      (v) => v.task.status === "completed",
    );
    expect(pushes()).toBe(true);
    clock.set("2027-01-13T11:00:01Z");
    expect((await pass(engine)).outcomes).toEqual([
      { scheduleId: schedule.id, outcome: "started" },
    ]);
    const all = await tasksOf(schedule.id);
    expect(all).toHaveLength(2);
    await untilTask(
      engine.engine,
      all[1]?.id as string,
      (v) => v.task.status === "completed",
    );
  });
});

describe("no next fire, and clocks that disagree", () => {
  it("finds a leap-day schedule's next fire four years on, and stays enabled", async () => {
    // Ahead of real time: nothing runs, so no run deadline applies.
    const clock = fakeClock("2027-06-01T00:00:00Z");
    const engine = await setup(clock);
    const { template } = await templateFor(engine.engine);
    const { schedule } = await engine.engine.schedules.create(
      daily(template.id, {
        trigger: { kind: "cron", cron: "0 0 29 2 *", timeZone: "UTC" },
      }),
    );
    expect(schedule.nextFireAt).toBe("2028-02-29T00:00:00.000Z");
    clock.set("2028-02-29T00:00:10Z");
    expect((await pass(engine)).outcomes).toEqual([
      { scheduleId: schedule.id, outcome: "started" },
    ]);
    expect(
      (await engine.engine.schedules.get(schedule.id)).schedule,
    ).toMatchObject({
      enabled: true,
      pausedReason: null,
      nextFireAt: "2032-02-29T00:00:00.000Z",
    });
  });

  it("pauses a schedule whose times can no longer be computed, rather than leave it enabled and dormant", async () => {
    const clock = fakeClock("2026-01-13T08:00:00Z");
    const engine = await setup(clock);
    const { template } = await templateFor(engine.engine);
    // As a build with another ICU would leave it: a zone this one does not know.
    const id = `sched_unknown_zone_${Date.now()}`;
    await db.database.db.insert(schedules).values({
      id,
      name: "Elsewhere",
      templateId: template.id,
      trigger: { kind: "cron", cron: "0 9 * * *", timeZone: "Mars/Base" },
      nextFireAt: new Date("2026-01-13T09:00:00Z"),
    });
    clock.set("2026-01-13T09:00:10Z");
    await pass(engine);
    const { schedule, fires } = await engine.engine.schedules.get(id);
    expect(fires.map((fire) => fire.outcome)).toEqual(["refused"]);
    expect(schedule).toMatchObject({
      enabled: false,
      pausedReason: "no_next_fire",
      nextFireAt: null,
    });
  });

  it("moves past a due time recorded already, which an edit on a clock behind the worker's set again", async () => {
    const clock = fakeClock("2026-01-13T08:00:00Z");
    const engine = await setup(clock);
    const { template } = await templateFor(engine.engine);
    const { schedule } = await engine.engine.schedules.create(
      daily(template.id),
    );
    clock.set("2026-01-13T09:00:01Z");
    await pass(engine);
    // An API 30 s behind the worker edits it: from its now, 09:00 is next.
    const behind = await setup(fakeClock("2026-01-13T08:59:30Z"));
    expect(
      (await behind.engine.schedules.update(schedule.id, { name: "Renamed" }))
        .schedule.nextFireAt,
    ).toBe("2026-01-13T09:00:00.000Z");
    const warned = quietLogger.warnings.length;
    clock.set("2026-01-13T09:00:40Z");
    await pass(engine);
    expect(
      quietLogger.warnings
        .slice(warned)
        .filter((line) => line.includes("could not handle schedule")),
    ).toEqual([]);
    expect(
      (await engine.engine.schedules.get(schedule.id)).schedule.nextFireAt,
    ).toBe("2026-01-14T09:00:00.000Z");
    expect((await firesOf(schedule.id)).map((fire) => fire.outcome)).toEqual([
      "started",
    ]);
    expect(await tasksOf(schedule.id)).toHaveLength(1);
  });
});

describe("removing the workspaces a schedule does not keep", () => {
  /** A bot whose tasks write a file, then complete; continued, it reports whether the file is still there. */
  function writingBrain(engine: TestEngine, name: string) {
    engine.executor.brain(name, (view) => {
      const since = resultsSince(view, "Check the notes again.");
      if (said.heard(view, "Check the notes again.")) {
        const last = since.at(-1);
        if (!last)
          return {
            calls: [
              {
                name: "bash",
                args: {
                  command: "test -e notes.md && echo kept || echo fresh",
                },
              },
            ],
          };
        return last.name === "complete_task"
          ? { text: "done" }
          : {
              calls: [
                { name: "complete_task", args: { result: last.text.trim() } },
              ],
            };
      }
      if (said.turns(view) === 0)
        return {
          calls: [
            { name: "write", args: { path: "notes.md", content: "# Notes\n" } },
          ],
        };
      return lastResult(view)?.name === "complete_task"
        ? { text: "done" }
        : { calls: [{ name: "complete_task", args: { result: "ok" } }] };
    });
  }

  /** Fires the schedule at `at`, runs its task to completion, and stops the worker. */
  async function finishRun(
    engine: TestEngine,
    clock: Clock,
    scheduleId: string,
    at: string,
  ) {
    clock.set(at);
    await pass(engine);
    await engine.engine.worker.start();
    const started = await tasksOf(scheduleId);
    await untilTask(
      engine.engine,
      started.at(-1)?.id as string,
      (v) => v.task.status === "completed",
    );
    await engine.engine.worker.stop();
    return started.at(-1)?.id as string;
  }

  it("neither counts nor removes an ephemeral workspace, and tells a continuation nothing", async () => {
    const clock = fakeClock("2026-01-13T08:00:00Z");
    const engine = await setup(clock);
    const { profile } = await engine.engine.profiles.create({
      name: uniqueName("Ephemeral"),
      sandbox: {
        driver: "local",
        network: { mode: "open" },
        workspace: "ephemeral",
      },
    });
    const { bot } = await engine.engine.bots.create({
      name: uniqueName("Eph"),
      runtimeProfileId: profile.id,
    });
    const { template } = await engine.engine.templates.create({
      title: "Notes",
      goal: "Write the notes.",
      coordinatorBotId: bot.id,
      spendCapUsd: 2,
    });
    writingBrain(engine, bot.name);
    const { schedule } = await engine.engine.schedules.create(
      daily(template.id, { keepWorkspaces: 0 }),
    );
    const first = await finishRun(
      engine,
      clock,
      schedule.id,
      "2026-01-13T09:00:01Z",
    );
    clock.set("2026-01-14T09:00:01Z");
    await pass(engine);
    const [row] = await db.database.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, first));
    expect(row).toMatchObject({
      workspaceDriver: null,
      workspaceRemovedAt: null,
      workspaceRemovingAt: null,
    });
    const view = await engine.engine.tasks.get(first);
    expect(
      view.events.filter((event) => event.type === "workspace.removed"),
    ).toEqual([]);
    await engine.engine.tasks.postMessage(first, {
      text: "Check the notes again.",
    });
    const [steering] = await db.database.db
      .select()
      .from(sessionInbox)
      .where(
        and(eq(sessionInbox.taskId, first), eq(sessionInbox.kind, "steering")),
      );
    expect(steering?.text).toBe(
      "Message from the user:\nCheck the notes again.",
    );
  });

  it("retries a removal its driver could not make, on a later pass with no fire", async () => {
    const clock = fakeClock("2026-01-13T08:00:00Z");
    const root = await mkdtemp(join(tmpdir(), "jj-sched-trim-"));
    roots.push(root);
    const local = new LocalSandboxDriver({ root, killGraceMs: 200 });
    let available = true;
    const toggled: EngineDriver = Object.assign(
      Object.create(local) as LocalSandboxDriver,
      {
        probe: async () =>
          available ? local.probe() : { ok: false, detail: "down" },
      },
    );
    const engine = await setup(clock, {
      workspaceRoot: root,
      registry: createDriverRegistry([{ driver: toggled, label: "Local" }], {
        ttlMs: 0,
      }),
    });
    const { template, bot } = await templateFor(engine.engine);
    writingBrain(engine, bot.name);
    const { schedule } = await engine.engine.schedules.create(
      daily(template.id, { keepWorkspaces: 0 }),
    );
    const first = await finishRun(
      engine,
      clock,
      schedule.id,
      "2026-01-13T09:00:01Z",
    );
    const dir = join(root, "task", first);
    expect(existsSync(join(dir, "notes.md"))).toBe(true);
    const [recorded] = await db.database.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, first));
    expect(recorded?.workspaceDriver).toBe("local");

    // The next fire starts while the driver is down: nothing is removed or marked.
    available = false;
    clock.set("2026-01-14T09:00:01Z");
    await pass(engine);
    expect(existsSync(dir)).toBe(true);
    const [kept] = await db.database.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, first));
    expect(kept).toMatchObject({
      workspaceRemovedAt: null,
      workspaceRemovingAt: null,
    });

    // Back up: a pass with nothing due removes it, and records it.
    available = true;
    clock.set("2026-01-14T09:05:00Z");
    expect((await pass(engine)).outcomes).toEqual([]);
    expect(existsSync(dir)).toBe(false);
    const [removed] = await db.database.db
      .select()
      .from(tasks)
      .where(eq(tasks.id, first));
    expect(removed?.workspaceRemovedAt?.toISOString()).toBe(
      "2026-01-14T09:05:00.000Z",
    );
    const view = await engine.engine.tasks.get(first);
    expect(
      view.events.filter((event) => event.type === "workspace.removed"),
    ).toHaveLength(1);
  });

  it("refuses a continuation while the removal is under way", async () => {
    const clock = fakeClock("2026-01-13T08:00:00Z");
    const engine = await setup(clock);
    const { template, bot } = await templateFor(engine.engine);
    writingBrain(engine, bot.name);
    const { schedule } = await engine.engine.schedules.create(
      daily(template.id),
    );
    const first = await finishRun(
      engine,
      clock,
      schedule.id,
      "2026-01-13T09:00:01Z",
    );
    await db.database.db
      .update(tasks)
      .set({ workspaceRemovingAt: new Date("2026-01-13T09:30:00Z") })
      .where(eq(tasks.id, first));
    const error = await refusal(
      engine.engine.tasks.postMessage(first, { text: "One more thing." }),
    );
    expect(error.code).toBe("CONFLICT");
    expect(error.message).toMatch(/workspace is being removed/);
    expect((await engine.engine.tasks.get(first)).task.status).toBe(
      "completed",
    );
  });
});
