// An answer to a spend approval that lands between a session's hold (its
// admission committed `{ hold }`) and its parking (the run's write-back): the
// answer finds the session still running, so it wakes nobody, and the
// parking must notice that nothing holds the session any more. Approve,
// deny and an expiry (a raised cap) all land in that window here, through
// the runtime's own hook, on the priced scripted model.
import type { SpendApproval, TaskView } from "@jj/contracts";
import { ModelRegistry, PiSessionExecutor } from "@jj/runtime";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Engine } from "./engine";
import type { RunExecutor, RunInput } from "./ports";
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

const LONG_WORK = `Write the notes: ${Array.from({ length: 40 }, (_, index) => `run \`echo ${index + 1}\``).join(", ")}.`;

/** Runs `onHold` once, right after the first admission that answers `{ hold }`. */
class AnswerInWindow implements RunExecutor {
  answered = false;
  constructor(
    private readonly inner: RunExecutor,
    private readonly onHold: () => Promise<void>,
  ) {}
  run(input: RunInput) {
    const hooks = input.hooks;
    const admit = hooks.admitModelCall?.bind(hooks);
    return this.inner.run({
      ...input,
      hooks: {
        ...hooks,
        ...(admit
          ? {
              admitModelCall: async () => {
                const answer = await admit();
                if (typeof answer === "object" && !this.answered) {
                  this.answered = true;
                  await this.onHold();
                }
                return answer;
              },
            }
          : {}),
      },
    });
  }
}

const pendingSpend = (view: TaskView) =>
  view.approvals.find(
    (approval): approval is SpendApproval =>
      approval.kind === "spend" && approval.status === "pending",
  );

type Answer = (engine: Engine, taskId: string, id: string) => Promise<unknown>;

const cases: [string, Answer, (view: TaskView) => boolean][] = [
  [
    "an approval: the session runs on to the cap",
    (engine, taskId, id) =>
      engine.tasks.decideApproval(taskId, id, { decision: "approve" }),
    (view) => view.events.some((event) => event.type === "spend.capped"),
  ],
  [
    "a denial: the coordinator stops at the threshold",
    (engine, taskId, id) =>
      engine.tasks.decideApproval(taskId, id, { decision: "deny" }),
    (view) =>
      view.task.status === "waiting" &&
      view.messages.some((message) =>
        message.text.startsWith(
          "Stopped: spend past 80% of the task's $0.05 cap was not approved.",
        ),
      ),
  ],
  [
    "an expiry: a raised cap lets the session go on",
    (engine, taskId) => engine.tasks.update(taskId, { spendCapUsd: 5 }),
    (view) => view.task.status === "completed",
  ],
];

describe("an answer between a hold and its parking", () => {
  it.each(cases)("wakes the session after %s", async (_, answer, settled) => {
    const models = new ModelRegistry({ env: {}, enableScripted: true });
    let taskId = "";
    let engine: Engine | undefined;
    const executor = new AnswerInWindow(
      new PiSessionExecutor({ models }),
      async () => {
        const view = await (engine as Engine).tasks.get(taskId);
        const pending = pendingSpend(view) as SpendApproval;
        await answer(engine as Engine, taskId, pending.id);
      },
    );
    const test = await testEngine(db.database, {
      models,
      runExecutor: executor,
    });
    engines.push(test);
    engine = test.engine;
    const { bot } = await engine.bots.create({
      name: uniqueName("Ada"),
      model: PRICED,
    });
    const { task } = await engine.tasks.create({
      goal: LONG_WORK,
      coordinatorBotId: bot.id,
      spendCapUsd: 0.05,
      approveSpendPastThreshold: true,
    });
    taskId = task.id;
    const view = await untilTask(
      engine,
      task.id,
      settled,
      "the task to settle",
    );
    expect(executor.answered).toBe(true);
    expect(pendingSpend(view)).toBeUndefined();
    expect(view.sessions[0]?.waitingFor).not.toBe("approval");
  });
});

// The tool-hold path has no such gap: an answer wakes the call's own session
// whatever its status, so a run is queued behind the one still writing back.
describe("a tool approval answered between its hold and its parking", () => {
  it("runs the call once the run's write-back has parked the session", async () => {
    const models = new ModelRegistry({ env: {}, enableScripted: true });
    let engine: Engine | undefined;
    let taskId = "";
    let answered = false;
    const inner: RunExecutor = new PiSessionExecutor({ models });
    const executor: RunExecutor = {
      run(input) {
        const review = input.hooks.reviewToolCall?.bind(input.hooks);
        return inner.run({
          ...input,
          hooks: {
            ...input.hooks,
            ...(review
              ? {
                  reviewToolCall: async (call) => {
                    const verdict = await review(call);
                    if (verdict === "hold" && !answered) {
                      answered = true;
                      const view = await (engine as Engine).tasks.get(taskId);
                      const held = view.approvals.find(
                        (approval) => approval.status === "pending",
                      );
                      await (engine as Engine).tasks.decideApproval(
                        taskId,
                        held?.id as string,
                        { decision: "approve" },
                      );
                    }
                    return verdict;
                  },
                }
              : {}),
          },
        });
      },
    };
    const test = await testEngine(db.database, {
      models,
      runExecutor: executor,
    });
    engines.push(test);
    engine = test.engine;
    const { profile } = await engine.profiles.create({
      name: uniqueName("Guarded"),
      sandbox: { driver: "local", network: { mode: "open" } },
      approvals: [{ tool: "bash", match: "git push" }],
    });
    const { bot } = await engine.bots.create({
      name: uniqueName("Nova"),
      runtimeProfileId: profile.id,
    });
    const { task } = await engine.tasks.create({
      goal: "Ship it: run `echo shipped > shipped.txt # git push`",
      coordinatorBotId: bot.id,
    });
    taskId = task.id;
    const view = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed",
      "the task to complete",
    );
    expect(answered).toBe(true);
    expect(view.approvals).toMatchObject([
      { kind: "tool", status: "approved", outcome: { ok: true, exitCode: 0 } },
    ]);
  });
});
