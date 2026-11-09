// Spend approvals (#106) end to end on the pi runtime and the scripted model
// at its fictional price (`scripted/team-priced`): past 80% of a cap whose
// option is on, no model call starts until the user answers; an approval
// lets every held session run on up to the cap, a denial stops the task as
// the cap would, at the threshold, and a cap or option change, a stop and a
// restart behave as agreed. Spend is real (recorded by the runtime), except
// where a test seeds a bot's or task's earlier spend to place it exactly.
import type { SpendApproval, TaskEvent, TaskView } from "@jj/contracts";
import { taskSummarySchema, taskViewSchema } from "@jj/contracts";
import { approvals, usage } from "@jj/db";
import { ModelRegistry, PiSessionExecutor } from "@jj/runtime";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DomainError } from "./errors";
import { updateApproval } from "./services/approvals";
import {
  OPEN_TIMEOUT,
  openTestDatabase,
  sleep,
  type TestDatabase,
  type TestEngine,
  type TestEngineOptions,
  testEngine,
  uniqueName,
  until,
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

/** An engine whose sessions run on the pi runtime with the scripted models. */
async function setup(options: Omit<TestEngineOptions, "runExecutor"> = {}) {
  const models = new ModelRegistry({ env: {}, enableScripted: true });
  const engine = await testEngine(db.database, {
    ...options,
    models,
    runExecutor: new PiSessionExecutor({ models }),
  });
  engines.push(engine);
  return engine;
}

/** A bot on the priced scripted model, on its own profile when budgets are given. */
async function pricedBot(
  engine: TestEngine["engine"],
  base: string,
  budgets?: {
    maxUsdPerTask?: number | null;
    maxUsdPerBotPerDay?: number | null;
    approveSpendPastThreshold?: boolean;
  },
) {
  const profile = budgets
    ? (
        await engine.profiles.create({
          name: uniqueName(`${base} profile`),
          sandbox: { driver: "local", network: { mode: "open" } },
          budgets,
        })
      ).profile
    : undefined;
  const { bot } = await engine.bots.create({
    name: uniqueName(base),
    model: PRICED,
    ...(profile ? { runtimeProfileId: profile.id } : {}),
  });
  return bot;
}

/** A goal the scripted model works through one call at a time, longer than any cap here allows. */
const LONG_WORK = `Write the notes: ${Array.from({ length: 40 }, (_, index) => `run \`echo ${index + 1}\``).join(", ")}.`;

const ofType = <Type extends TaskEvent["type"]>(view: TaskView, type: Type) =>
  view.events.filter(
    (event): event is Extract<TaskEvent, { type: Type }> => event.type === type,
  );

const spendApprovals = (view: TaskView) =>
  view.approvals.filter(
    (approval): approval is SpendApproval => approval.kind === "spend",
  );
const pendingSpend = (view: TaskView) =>
  spendApprovals(view).find((approval) => approval.status === "pending");

/** Sequence of the event that recorded this approval's request, or its update to `status`. */
function sequenceOf(view: TaskView, approvalId: string, status?: string) {
  const event = view.events.find((candidate) =>
    status === undefined
      ? candidate.type === "approval.requested" &&
        candidate.payload.approval.id === approvalId
      : candidate.type === "approval.updated" &&
        candidate.payload.approval.id === approvalId &&
        candidate.payload.approval.status === status,
  );
  if (!event) throw new Error(`No event for approval ${approvalId}.`);
  return event.sequence;
}

/** Model calls started after `sequence`, optionally by one session. */
const startedAfter = (view: TaskView, sequence: number, sessionId?: string) =>
  ofType(view, "model.started").filter(
    (event) =>
      event.sequence > sequence &&
      (sessionId === undefined || event.sessionId === sessionId),
  );

/**
 * A spend approval waits, the task waits for the user, and no session runs
 * or is queued: each open one waits for approval, or for its delegations.
 */
const allHeld = (view: TaskView) =>
  pendingSpend(view) !== undefined &&
  view.task.status === "waiting" &&
  view.sessions.every(
    (session) => session.status !== "running" && session.status !== "queued",
  ) &&
  view.sessions.some(
    (session) =>
      session.status === "waiting" && session.waitingFor === "approval",
  );

const waitingAtCap = (view: TaskView) =>
  view.task.status === "waiting" &&
  view.sessions.every((session) => session.status !== "running") &&
  ofType(view, "spend.capped").length > 0;

/** Spend recorded outside the task (a bot's direct chat), at `at`. */
async function seedSpend(
  botId: string,
  costUsd: number,
  at: Date,
  taskId: string | null = null,
) {
  await db.database.db.insert(usage).values({
    id: `usage_seed_${Math.random().toString(36).slice(2)}`,
    taskId,
    botId,
    model: PRICED,
    costUsd,
    createdAt: at,
  });
}

describe("spend approvals past the soft threshold", () => {
  it("holds the task before the call past 80% of its cap, asks once, and runs on to the cap once approved", async () => {
    const { engine } = await setup();
    const ada = await pricedBot(engine, "Ada");
    const { task } = await engine.tasks.create({
      goal: LONG_WORK,
      coordinatorBotId: ada.id,
      spendCapUsd: 0.05,
      approveSpendPastThreshold: true,
    });
    expect(task.approveSpendPastThreshold).toBe(true);

    const held = await untilTask(engine, task.id, allHeld, "the spend hold");
    const approval = pendingSpend(held) as SpendApproval;
    expect(approval).toMatchObject({
      kind: "spend",
      scope: "task",
      capUsd: 0.05,
      thresholdUsd: 0.04,
      sessionId: held.sessions[0]?.id,
      botId: ada.id,
      decidedAt: null,
    });
    // It was asked when the recorded spend passed the threshold, short of the cap.
    expect(approval.spentUsd).toBeGreaterThanOrEqual(0.04);
    expect(approval.spentUsd).toBeLessThan(0.05);
    expect(held.usage.total.costUsd).toBeCloseTo(approval.spentUsd, 10);
    // spend.threshold is still recorded first.
    const requested = sequenceOf(held, approval.id);
    expect(ofType(held, "spend.threshold")[0]?.sequence).toBeLessThan(
      requested,
    );
    // Nothing starts while it waits: no model call after the request, no run.
    await sleep(500);
    const still = await engine.tasks.get(task.id);
    expect(startedAfter(still, requested)).toEqual([]);
    expect(ofType(still, "model.started").length).toBe(
      ofType(still, "model.finished").length,
    );
    expect(still.sessions[0]).toMatchObject({
      status: "waiting",
      waitingFor: "approval",
    });
    expect(ofType(still, "approval.requested")).toHaveLength(1);
    // Summaries carry it as an approval waiting, shown in full.
    const { tasks } = await engine.tasks.list();
    const summary = taskSummarySchema.parse(
      tasks.find((candidate) => candidate.id === task.id),
    );
    expect(summary.pendingApprovals).toEqual([
      expect.objectContaining({
        kind: "spend",
        id: approval.id,
        summary: "Spend past $0.04 of the task's $0.05 cap",
        shownInFull: true,
      }),
    ]);
    expect(() => taskViewSchema.parse(still)).not.toThrow();

    await engine.tasks.decideApproval(task.id, approval.id, {
      decision: "approve",
    });
    const capped = await untilTask(engine, task.id, waitingAtCap, "the cap");
    // It ran on after the answer, up to the cap, and was never asked again.
    const approved = sequenceOf(capped, approval.id, "approved");
    expect(startedAfter(capped, approved).length).toBeGreaterThan(0);
    expect(ofType(capped, "approval.requested")).toHaveLength(1);
    expect(ofType(capped, "spend.capped")[0]?.payload).toMatchObject({
      scope: "task",
      capUsd: 0.05,
    });
    expect(capped.messages.at(-1)?.text).toMatch(
      /^Stopped: The task reached its spend cap/,
    );
  });

  it("holds parallel workers with one approval, and approving resumes both", async () => {
    const { engine } = await setup();
    const lead = await pricedBot(engine, "Lead");
    const grace = await pricedBot(engine, "Grace");
    const linus = await pricedBot(engine, "Linus");
    const { task } = await engine.tasks.create({
      goal: LONG_WORK,
      coordinatorBotId: lead.id,
      participantBotIds: [grace.id, linus.id],
      spendCapUsd: 0.05,
      approveSpendPastThreshold: true,
    });
    const workersOf = (view: TaskView) =>
      view.sessions.filter((session) => session.parentSessionId !== null);
    const held = await untilTask(
      engine,
      task.id,
      (view) => workersOf(view).length === 2 && allHeld(view),
      "both workers held",
    );
    expect(ofType(held, "approval.requested")).toHaveLength(1);
    for (const worker of workersOf(held))
      expect(worker).toMatchObject({
        status: "waiting",
        waitingFor: "approval",
      });
    const approval = pendingSpend(held) as SpendApproval;

    await engine.tasks.decideApproval(task.id, approval.id, {
      decision: "approve",
    });
    const resumed = await untilTask(
      engine,
      task.id,
      (view) => {
        const approved = sequenceOf(view, approval.id, "approved");
        return workersOf(view).every(
          (worker) => startedAfter(view, approved, worker.id).length > 0,
        );
      },
      "both workers to resume",
    );
    expect(ofType(resumed, "approval.requested")).toHaveLength(1);
  });

  it("stops the task at the threshold when denied: workers report stopped, the coordinator waits with a system message, and no call follows", async () => {
    const { engine } = await setup();
    const lead = await pricedBot(engine, "Lead");
    const grace = await pricedBot(engine, "Grace");
    const { task } = await engine.tasks.create({
      goal: LONG_WORK,
      coordinatorBotId: lead.id,
      participantBotIds: [grace.id],
      spendCapUsd: 0.05,
      approveSpendPastThreshold: true,
    });
    const held = await untilTask(engine, task.id, allHeld, "the spend hold");
    const approval = pendingSpend(held) as SpendApproval;
    await engine.tasks.decideApproval(task.id, approval.id, {
      decision: "deny",
      reason: "Too dear.",
    });
    const stopped = await untilTask(
      engine,
      task.id,
      (view) =>
        view.task.status === "waiting" &&
        view.sessions[0]?.waitingFor === "user",
      "the task to wait for the user",
    );
    const denied = sequenceOf(stopped, approval.id, "denied");
    expect(startedAfter(stopped, denied)).toEqual([]);
    expect(ofType(stopped, "spend.capped")).toEqual([]);
    const worker = stopped.sessions.find(
      (session) => session.parentSessionId !== null,
    );
    expect(worker?.status).toBe("completed");
    expect(worker?.result).toContain(
      "(Stopped before finishing: spend past 80% of the task's $0.05 cap was not approved.)",
    );
    const system = stopped.messages.filter(
      (message) => message.authorKind === "system",
    );
    expect(system.at(-1)?.text).toMatch(
      /^Stopped: spend past 80% of the task's \$0\.05 cap was not approved\. A message that continues the task asks again/,
    );
    expect(spendApprovals(stopped)).toEqual([
      expect.objectContaining({ status: "denied", reason: "Too dear." }),
    ]);

    // A message continues the task, and asks again.
    await engine.tasks.postMessage(task.id, { text: "Go on, please." });
    const again = await untilTask(
      engine,
      task.id,
      (view) => spendApprovals(view).length === 2 && allHeld(view),
      "the second question",
    );
    expect(pendingSpend(again)).toMatchObject({ scope: "task", capUsd: 0.05 });
    expect(
      startedAfter(
        again,
        sequenceOf(again, (pendingSpend(again) as SpendApproval).id),
      ),
    ).toEqual([]);
  });

  it("is off by default: the task runs to its cap without asking", async () => {
    const { engine } = await setup();
    const ada = await pricedBot(engine, "Ada");
    const { task } = await engine.tasks.create({
      goal: LONG_WORK,
      coordinatorBotId: ada.id,
      spendCapUsd: 0.05,
    });
    expect(task.approveSpendPastThreshold).toBe(false);
    const capped = await untilTask(engine, task.id, waitingAtCap, "the cap");
    expect(capped.approvals).toEqual([]);
    expect(ofType(capped, "spend.threshold")).toHaveLength(1);
    expect(ofType(capped, "spend.capped")).toHaveLength(1);
    expect(capped.usage.total.costUsd).toBeGreaterThanOrEqual(0.05);
  });

  it("takes the option from the coordinator's profile, or the one the creator gives", async () => {
    const { engine } = await setup({ start: false });
    const asking = await pricedBot(engine, "Asker", {
      approveSpendPastThreshold: true,
    });
    const plain = await pricedBot(engine, "Plain");
    const create = async (coordinatorBotId: string, option?: boolean) =>
      (
        await engine.tasks.create({
          goal: "Work.",
          coordinatorBotId,
          ...(option === undefined
            ? {}
            : { approveSpendPastThreshold: option }),
        })
      ).task.approveSpendPastThreshold;
    expect(await create(asking.id)).toBe(true);
    expect(await create(plain.id)).toBe(false);
    expect(await create(asking.id, false)).toBe(false);
    expect(await create(plain.id, true)).toBe(true);
  });

  it("expires a pending approval when the cap changes, and checks again against the new one", async () => {
    const { engine } = await setup();
    const ada = await pricedBot(engine, "Ada");
    const { task } = await engine.tasks.create({
      goal: LONG_WORK,
      coordinatorBotId: ada.id,
      spendCapUsd: 0.05,
      approveSpendPastThreshold: true,
    });
    const held = await untilTask(engine, task.id, allHeld, "the spend hold");
    const first = pendingSpend(held) as SpendApproval;
    await engine.tasks.update(task.id, { spendCapUsd: 0.08 });
    // The old question expires; the session runs again and asks about the new cap.
    const again = await untilTask(
      engine,
      task.id,
      (view) =>
        spendApprovals(view).some(
          (approval) =>
            approval.capUsd === 0.08 && approval.status === "pending",
        ) && allHeld(view),
      "the question about the new cap",
    );
    expect(spendApprovals(again)[0]).toMatchObject({
      id: first.id,
      status: "expired",
      reason: "the task's spend cap changed to $0.08 before the user answered.",
    });
    const expired = sequenceOf(again, first.id, "expired");
    expect(startedAfter(again, expired).length).toBeGreaterThan(0);
    expect(pendingSpend(again)?.thresholdUsd).toBeCloseTo(0.064, 10);

    // Turning the option off expires it too, and the task runs on to its cap.
    const second = pendingSpend(again) as SpendApproval;
    await engine.tasks.update(task.id, { approveSpendPastThreshold: false });
    const capped = await untilTask(engine, task.id, waitingAtCap, "the cap");
    expect(
      spendApprovals(capped).find((a) => a.id === second.id),
    ).toMatchObject({
      status: "expired",
      reason:
        "asking before spending past 80% of the cap was turned off before the user answered.",
    });
    expect(spendApprovals(capped)).toHaveLength(2);
  });

  it("keeps sessions held across a restart, answers two concurrent decisions once, and is cancelled by a stop", async () => {
    const first = await setup();
    const ada = await pricedBot(first.engine, "Ada");
    const { task } = await first.engine.tasks.create({
      goal: LONG_WORK,
      coordinatorBotId: ada.id,
      spendCapUsd: 0.05,
      approveSpendPastThreshold: true,
    });
    const held = await untilTask(first.engine, task.id, allHeld, "the hold");
    const approval = pendingSpend(held) as SpendApproval;
    const requested = sequenceOf(held, approval.id);
    await first.dispose();
    engines.splice(engines.indexOf(first), 1);

    // A new worker finds the session held: no run, no model call.
    const second = await setup();
    await second.engine.tasks.postMessage(task.id, { text: "Still there?" });
    await sleep(800);
    const after = await second.engine.tasks.get(task.id);
    expect(startedAfter(after, requested)).toEqual([]);
    expect(after.sessions[0]).toMatchObject({
      status: "waiting",
      waitingFor: "approval",
      runCount: held.sessions[0]?.runCount,
    });
    expect(after.task.status).toBe("waiting");

    // Two answers at once: one wins, the other is told it is no longer pending.
    const answers = await Promise.allSettled([
      second.engine.tasks.decideApproval(task.id, approval.id, {
        decision: "approve",
      }),
      second.engine.tasks.decideApproval(task.id, approval.id, {
        decision: "deny",
      }),
    ]);
    expect(
      answers.filter((answer) => answer.status === "fulfilled"),
    ).toHaveLength(1);
    const refused = answers.find((answer) => answer.status === "rejected");
    expect((refused as PromiseRejectedResult).reason).toBeInstanceOf(
      DomainError,
    );
    expect((refused as PromiseRejectedResult).reason).toMatchObject({
      code: "APPROVAL_NOT_PENDING",
    });

    // A stop cancels a pending one.
    const { task: other } = await second.engine.tasks.create({
      goal: LONG_WORK,
      coordinatorBotId: ada.id,
      spendCapUsd: 0.05,
      approveSpendPastThreshold: true,
    });
    const otherHeld = await untilTask(
      second.engine,
      other.id,
      allHeld,
      "the hold",
    );
    const toCancel = pendingSpend(otherHeld) as SpendApproval;
    await second.engine.tasks.stop(other.id, {});
    const cancelled = await untilTask(
      second.engine,
      other.id,
      (view) => view.task.status === "cancelled",
      "the stop",
    );
    expect(spendApprovals(cancelled)).toEqual([
      expect.objectContaining({
        id: toCancel.id,
        status: "cancelled",
        reason: "the task was stopped before the user answered.",
      }),
    ]);
    await expect(
      second.engine.tasks.decideApproval(other.id, toCancel.id, {
        decision: "approve",
      }),
    ).rejects.toMatchObject({ code: "TASK_TERMINAL" });
  });

  it("covers an approved cap value for good, while a denial asks again after a message", async () => {
    const { engine } = await setup();
    const ada = await pricedBot(engine, "Ada");
    // Spend already past 80% of the cap when the user continues the task.
    const { task } = await engine.tasks.create({
      goal: "Write notes-ada.md.",
      coordinatorBotId: ada.id,
      spendCapUsd: 0.5,
    });
    await untilTask(
      engine,
      task.id,
      (view) => view.task.status === "completed",
    );
    await seedSpend(ada.id, 0.41, new Date(), task.id);
    await engine.tasks.update(task.id, { approveSpendPastThreshold: true });

    await engine.tasks.postMessage(task.id, { text: "Also add a line." });
    const held = await untilTask(engine, task.id, allHeld, "the hold");
    const approval = pendingSpend(held) as SpendApproval;
    await engine.tasks.decideApproval(task.id, approval.id, {
      decision: "approve",
    });
    const done = (view: TaskView) =>
      view.task.status === "completed" || view.task.status === "waiting";
    await untilTask(
      engine,
      task.id,
      (view) =>
        done(view) &&
        startedAfter(view, sequenceOf(view, approval.id, "approved")).length >
          0,
      "the work after the approval",
    );

    // Another stretch of work: the approved cap value is not asked about again.
    await engine.tasks.postMessage(task.id, { text: "And one more." });
    const reopened = await untilTask(
      engine,
      task.id,
      (view) =>
        done(view) &&
        ofType(view, "task.reopened").length === 2 &&
        view.sessions.every((session) => session.status !== "running"),
      "the next stretch",
    );
    expect(spendApprovals(reopened)).toHaveLength(1);
    expect(
      startedAfter(
        reopened,
        ofType(reopened, "task.reopened")[1]?.sequence ?? 0,
      ).length,
    ).toBeGreaterThan(0);
  });

  it("asks about a bot's daily cap per task, and an approval covers it for 24 hours", async () => {
    let now = new Date();
    const { engine } = await setup({ clock: () => now });
    const ada = await pricedBot(engine, "Ada", {
      maxUsdPerTask: null,
      maxUsdPerBotPerDay: 0.5,
      approveSpendPastThreshold: true,
    });
    // Ada's chat already spent past 80% of her daily cap.
    await seedSpend(ada.id, 0.41, now);
    const { task } = await engine.tasks.create({
      goal: "Write notes-ada.md.",
      coordinatorBotId: ada.id,
    });
    expect(task.spendCapUsd).toBeNull();
    const held = await untilTask(engine, task.id, allHeld, "the hold");
    const approval = pendingSpend(held) as SpendApproval;
    expect(approval).toMatchObject({
      scope: "bot",
      botId: ada.id,
      capUsd: 0.5,
    });
    expect(approval.spentUsd).toBeCloseTo(0.41, 6);
    const decidedAt = now.getTime();
    await engine.tasks.decideApproval(task.id, approval.id, {
      decision: "approve",
    });
    await untilTask(
      engine,
      task.id,
      (view) => view.task.status === "completed",
    );

    // 23 hours later the spend still counts, and the approval still covers it.
    now = new Date(decidedAt + 23 * 3_600_000);
    await engine.tasks.postMessage(task.id, { text: "Add a line." });
    const covered = await untilTask(
      engine,
      task.id,
      (view) =>
        view.task.status === "completed" &&
        ofType(view, "task.reopened").length === 1,
      "the covered stretch",
    );
    expect(spendApprovals(covered)).toHaveLength(1);

    // 25 hours after the answer it no longer covers: more spend asks again.
    now = new Date(decidedAt + 25 * 3_600_000);
    await seedSpend(ada.id, 0.42, now);
    await engine.tasks.postMessage(task.id, { text: "One more line." });
    const asked = await untilTask(
      engine,
      task.id,
      (view) => spendApprovals(view).length === 2 && allHeld(view),
      "the question after 24 hours",
    );
    expect(pendingSpend(asked)).toMatchObject({ scope: "bot", capUsd: 0.5 });

    // A change to her profile's cap expires it.
    const profileId = (await engine.bots.get(ada.id)).bot
      .runtimeProfileId as string;
    await engine.profiles.update(profileId, {
      budgets: { maxUsdPerBotPerDay: 2 },
    });
    await until(
      async () =>
        spendApprovals(await engine.tasks.get(task.id)).every(
          (approval) => approval.status !== "pending",
        ),
      { what: "the expiry" },
    );
    const expired = spendApprovals(await engine.tasks.get(task.id))[1];
    expect(expired).toMatchObject({
      status: "expired",
      reason: expect.stringContaining("daily spend cap changed to $2.00"),
    });
  });
});

describe("answers that race", () => {
  it("never changes an approval another answer resolved first, and emits nothing for it", async () => {
    const { engine } = await setup();
    const ada = await pricedBot(engine, "Ada");
    const { task } = await engine.tasks.create({
      goal: LONG_WORK,
      coordinatorBotId: ada.id,
      spendCapUsd: 0.05,
      approveSpendPastThreshold: true,
    });
    const held = await untilTask(engine, task.id, allHeld, "the hold");
    const approval = pendingSpend(held) as SpendApproval;
    // A writer that read the approval while it was pending, such as a cap
    // change's recheck, and writes after the user's Approve committed.
    const [stale] = await db.database.db
      .select()
      .from(approvals)
      .where(eq(approvals.id, approval.id));
    await engine.tasks.decideApproval(task.id, approval.id, {
      decision: "approve",
    });
    const written = await db.database.db.transaction((tx) =>
      updateApproval(
        tx,
        engine.context,
        stale as typeof approvals.$inferSelect,
        {
          status: "expired",
          reason: "the task's spend cap changed before the user answered.",
        },
      ),
    );
    expect(written).toBeUndefined();
    const after = await engine.tasks.get(task.id);
    expect(
      spendApprovals(after).find((candidate) => candidate.id === approval.id),
    ).toMatchObject({ status: "approved" });
    expect(
      ofType(after, "approval.updated").filter(
        (event) => event.payload.approval.status === "expired",
      ),
    ).toEqual([]);
  });
});
