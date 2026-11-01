import { taskViewSchema } from "@jj/contracts";
import { jobs, sessionEntries } from "@jj/db";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Brain, promptBot, said } from "./testing/fake-executor";
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
  reported,
  writingWorker,
} from "./testing/scenarios";
import { COMPLETION_SET_ASIDE } from "./worker/prompts";

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

const finished = (status: string) => (view: { task: { status: string } }) =>
  view.task.status === status;

describe("orchestration", () => {
  it("runs two bots in parallel sessions that share the task workspace", async () => {
    const { engine, executor } = await setup();
    const team = await createTeam(engine, ["Ada", "Bob", "Cy"]);
    const [ada, bob, cy] = team.names as [string, string, string];
    const worker =
      (me: string, other: string): Brain =>
      (view) => {
        switch (said.turns(view)) {
          case 0:
            return {
              calls: [
                {
                  name: "bash",
                  args: { command: `echo from-${me} > ${me}.txt` },
                },
              ],
            };
          case 1:
            return { calls: [{ name: "gate", args: { name: me } }] };
          case 2:
            return {
              calls: [{ name: "bash", args: { command: `cat ${other}.txt` } }],
            };
          default:
            return { text: `${me} saw ${lastResult(view)?.text.trim()}` };
        }
      };
    executor
      .brain(ada, delegatingCoordinator([bob, cy]))
      .brain(bob, worker(bob, cy))
      .brain(cy, worker(cy, bob));

    const { task } = await engine.tasks.create({
      goal: "Write two files",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    // Both workers reach their gate before either is let through: they run at once.
    await Promise.all([executor.gate(bob).reached, executor.gate(cy).reached]);
    executor.gate(bob).open();
    executor.gate(cy).open();

    const view = await untilTask(engine, task.id, finished("completed"));
    taskViewSchema.parse(view);
    expect(view.task.result).toBe(`Consolidated: ${bob}, ${cy}`);
    const workers = view.sessions.filter(
      (session) => session.role === "worker",
    );
    expect(workers.map((session) => session.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(workers.find((s) => s.botId === team.byName[bob])?.result).toBe(
      `${bob} saw from-${cy}`,
    );
    expect(workers.find((s) => s.botId === team.byName[cy])?.result).toBe(
      `${cy} saw from-${bob}`,
    );
    const dirs = new Set(
      executor.inputs.map((input) => input.sandbox.workspaceDir),
    );
    expect(dirs.size).toBe(1);
    expect(view.messages.map((message) => message.intent)).toEqual([
      "assignment",
      "assignment",
      "result",
      "result",
      "result",
    ]);
  });

  it("lets the coordinator react to the first result before the second finishes", async () => {
    const { engine, executor } = await setup();
    const team = await createTeam(engine, ["Ada", "Bob", "Cy"]);
    const [ada, bob, cy] = team.names as [string, string, string];
    const coordinator: Brain = (view) => {
      const done = reported(view, [bob, cy]);
      if (said.turns(view) === 0)
        return {
          calls: [
            { name: "delegate", args: { bot: bob, brief: "quick part" } },
            { name: "delegate", args: { bot: cy, brief: "slow part" } },
          ],
        };
      if (
        done.length === 1 &&
        !executor.executed.some((e) => e.command.includes("reacted"))
      )
        return {
          calls: [
            {
              name: "bash",
              args: { command: `echo reacted-to-${done[0]} > reaction.txt` },
            },
          ],
        };
      if (done.length < 2) return { text: "Waiting for the slow part." };
      if (lastResult(view)?.name === "complete_task") return { text: "Done." };
      return {
        calls: [{ name: "complete_task", args: { result: "both parts" } }],
      };
    };
    const gated =
      (gate: string, text: string): Brain =>
      (view) =>
        said.turns(view) === 0
          ? { calls: [{ name: "gate", args: { name: gate } }] }
          : { text };
    executor
      .brain(ada, coordinator)
      .brain(bob, gated("quick", "quick part done"))
      .brain(cy, gated("slow", "slow part done"));
    const { task } = await engine.tasks.create({
      goal: "Two parts",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    // Bob reports only once the coordinator's first run has ended: a result
    // landing while that run is still ending continues it instead.
    const first = await untilTask(
      engine,
      task.id,
      (view) =>
        view.sessions.find((s) => s.botId === team.byName[ada])?.status ===
        "waiting",
      "the coordinator's first wait",
    );
    expect(
      first.sessions.find((s) => s.botId === team.byName[ada]),
    ).toMatchObject({ waitingFor: "delegations", runCount: 1 });
    executor.gate("quick").open();
    await until(
      () =>
        executor.executed.some(
          (entry) => entry.command === `echo reacted-to-${bob} > reaction.txt`,
        ),
      { what: "the coordinator's reaction" },
    );
    const midway = await untilTask(
      engine,
      task.id,
      (view) =>
        view.sessions.find((s) => s.botId === team.byName[ada])?.status ===
        "waiting",
      "the coordinator to wait again",
    );
    const slow = midway.sessions.find((s) => s.botId === team.byName[cy]);
    expect(slow?.status).toBe("running");
    expect(
      midway.sessions.find((s) => s.botId === team.byName[ada]),
    ).toMatchObject({
      waitingFor: "delegations",
      runCount: 2,
    });
    executor.gate("slow").open();
    const view = await untilTask(engine, task.id, finished("completed"));
    expect(view.task.result).toBe("both parts");
  });

  it("lists the caller's open delegations in delegate's result and description, and refuses an exact duplicate", async () => {
    const { engine, executor } = await setup();
    const team = await createTeam(engine, ["Ada", "Bob", "Cy"]);
    const [ada, bob, cy] = team.names as [string, string, string];
    const coordinator: Brain = (view) => {
      if (said.turns(view) === 0)
        return {
          calls: [
            { name: "delegate", args: { bot: bob, brief: "Write bob.txt" } },
            { name: "delegate", args: { bot: cy, brief: "Write cy.txt" } },
            { name: "delegate", args: { bot: bob, brief: "Write bob.txt" } },
          ],
        };
      const done = reported(view, [bob, cy]);
      if (done.length < 2) return { text: "" };
      if (lastResult(view)?.name === "complete_task") return { text: "Done." };
      return { calls: [{ name: "complete_task", args: { result: "both" } }] };
    };
    const gated =
      (gate: string): Brain =>
      (view) =>
        said.turns(view) === 0
          ? { calls: [{ name: "gate", args: { name: gate } }] }
          : { text: `${gate} done` };
    executor
      .brain(ada, coordinator)
      .brain(bob, gated("bob"))
      .brain(cy, gated("cy"));
    const { task } = await engine.tasks.create({
      goal: "Two files",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    await untilTask(
      engine,
      task.id,
      (view) =>
        view.sessions.find((s) => s.botId === team.byName[ada])?.status ===
        "waiting",
      "the coordinator's first wait",
    );
    // Bob reports while Cy holds: the coordinator's next call sees only Cy open.
    executor.gate("bob").open();
    await until(
      () =>
        executor.inputs.filter((input) => promptBot(input.systemPrompt) === ada)
          .length >= 2,
      { what: "the coordinator's call after Bob's result" },
    );
    executor.gate("cy").open();
    const view = await untilTask(engine, task.id, finished("completed"));
    // The view drops output previews; the event page keeps them.
    const page = await engine.tasks.events(task.id);
    const outputs = page.events.flatMap((e) =>
      e.type === "tool.finished" && e.payload.tool === "delegate"
        ? [{ ok: e.payload.ok, output: e.payload.output ?? "" }]
        : [],
    );
    const bobSession = view.sessions.find((s) => s.botId === team.byName[bob]);
    expect(outputs.map((o) => o.ok)).toEqual([true, true, false]);
    expect(outputs[1]?.output).toMatch(
      new RegExp(
        `Your open delegations \\(assigned, not yet reported\\):\n- ${bob}: Write bob\\.txt \\((queued|running)\\)\n- ${cy}: Write cy\\.txt \\((queued|running)\\)\n`,
      ),
    );
    expect(outputs[1]?.output).toContain(
      "Do not delegate work that is already assigned",
    );
    expect(outputs[2]?.output).toMatch(
      new RegExp(
        `^${bob} already has this exact brief open \\(session ${bobSession?.id}, (queued|running)\\)\\. Do not delegate it again; wait for its result\\.$`,
      ),
    );
    expect(view.sessions).toHaveLength(3);
    const descriptions = executor.inputs
      .filter((input) => promptBot(input.systemPrompt) === ada)
      .map(
        (input) =>
          input.collaborationTools.find((tool) => tool.name === "delegate")
            ?.description ?? "",
      );
    expect(descriptions[0]).toContain("Your open delegations: none.");
    expect(descriptions[0]).toContain(
      "Never delegate work that is already assigned",
    );
    expect(descriptions[1]).toMatch(
      new RegExp(`\n- ${cy}: Write cy\\.txt \\((queued|running)\\)$`),
    );
    expect(descriptions[1]).not.toContain(`- ${bob}: Write bob.txt`);
  });

  it("tells the coordinator when a result that arrives after complete_task sets the completion aside", async () => {
    const { engine, executor } = await setup();
    const team = await createTeam(engine, ["Ada", "Bob"]);
    const [ada, bob] = team.names as [string, string];
    executor
      .brain(ada, (view) => {
        if (said.turns(view) === 0)
          return {
            calls: [
              { name: "delegate", args: { bot: bob, brief: "Write bob.txt" } },
              { name: "gate", args: { name: "hold" } },
              { name: "complete_task", args: { result: "too early" } },
            ],
          };
        const completions = said
          .results(view)
          .filter((result) => result.name === "complete_task").length;
        if (completions > 1) return { text: "Done." };
        // Without the notice a model takes its first completion as done.
        if (!said.heard(view, COMPLETION_SET_ASIDE))
          return { text: "Already completed." };
        return {
          calls: [{ name: "complete_task", args: { result: "with bob" } }],
        };
      })
      .brain(bob, () => ({ text: "bob done" }));
    const { task } = await engine.tasks.create({
      goal: "Complete after the result",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    await executor.gate("hold").reached;
    // Bob reports while the coordinator holds, so its result is unread when
    // complete_task runs and arrives right after it.
    await untilTask(
      engine,
      task.id,
      (view) =>
        view.sessions.find((s) => s.botId === team.byName[bob])?.status ===
        "completed",
      "Bob's result",
    );
    executor.gate("hold").open();
    const view = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed" || v.task.status === "waiting",
    );
    expect(view.task.status).toBe("completed");
    expect(view.task.result).toBe("with bob");
    const second = executor.inputs.filter(
      (input) => promptBot(input.systemPrompt) === ada,
    )[1];
    expect(second?.inputs[0]).toBe(COMPLETION_SET_ASIDE);
    expect(second?.inputs[1]).toContain(`Result from ${bob} (session`);
  });

  it("refuses a delegation after complete_task in the same turn, and completes", async () => {
    const { engine, executor } = await setup();
    const team = await createTeam(engine, ["Ada", "Bob"]);
    const [ada, bob] = team.names as [string, string];
    executor
      .brain(ada, (view) =>
        said.turns(view) === 0
          ? {
              calls: [
                { name: "complete_task", args: { result: "all done" } },
                { name: "delegate", args: { bot: bob, brief: "one more" } },
              ],
            }
          : { text: "Done." },
      )
      .brain(bob, () => ({ text: "bob done" }));
    const { task } = await engine.tasks.create({
      goal: "Complete, then delegate",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    const view = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed" || v.task.status === "waiting",
    );
    expect(view.task.status).toBe("completed");
    expect(view.task.result).toBe("all done");
    expect(view.sessions).toHaveLength(1);
    const page = await engine.tasks.events(task.id);
    const delegated = page.events.find(
      (e) => e.type === "tool.finished" && e.payload.tool === "delegate",
    );
    expect(delegated?.payload).toMatchObject({
      ok: false,
      output: expect.stringContaining("You already called complete_task"),
    });
  });

  it("refuses complete_task after a delegation in the same turn, and completes once it reports", async () => {
    const { engine, executor } = await setup();
    const team = await createTeam(engine, ["Ada", "Bob"]);
    const [ada, bob] = team.names as [string, string];
    executor
      .brain(ada, (view) => {
        if (said.turns(view) === 0)
          return {
            calls: [
              { name: "delegate", args: { bot: bob, brief: "one more" } },
              { name: "complete_task", args: { result: "too early" } },
            ],
          };
        if (!said.heard(view, `Result from ${bob} (session`))
          return { text: "" };
        if (
          lastResult(view)?.name === "complete_task" &&
          !lastResult(view)?.isError
        )
          return { text: "Done." };
        return {
          calls: [{ name: "complete_task", args: { result: "with bob" } }],
        };
      })
      .brain(bob, () => ({ text: "bob done" }));
    const { task } = await engine.tasks.create({
      goal: "Delegate, then complete",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    const view = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed",
    );
    expect(view.task.result).toBe("with bob");
    expect(view.sessions).toHaveLength(2);
    const page = await engine.tasks.events(task.id);
    const completions = page.events.flatMap((e) =>
      e.type === "tool.finished" && e.payload.tool === "complete_task"
        ? [e.payload.ok]
        : [],
    );
    expect(completions).toEqual([false, true]);
  });

  it("does not deadlock when waiting parents would fill every slot", async () => {
    const { engine, executor } = await setup({ config: { concurrency: 1 } });
    const team = await createTeam(engine, ["Ada", "Bob", "Cy"]);
    const [ada, bob, cy] = team.names as [string, string, string];
    const middle: Brain = (view) => {
      if (said.turns(view) === 0)
        return {
          calls: [{ name: "delegate", args: { bot: cy, brief: "leaf work" } }],
        };
      if (!said.heard(view, `Result from ${cy} (session`))
        return { text: "waiting" };
      return { text: `${bob} relayed ${cy}` };
    };
    executor
      .brain(ada, delegatingCoordinator([bob]))
      .brain(bob, middle)
      .brain(cy, writingWorker(cy));
    let peak = 0;
    const tasks = [];
    for (let index = 0; index < 2; index += 1)
      tasks.push(
        (
          await engine.tasks.create({
            goal: `Chain ${index}`,
            coordinatorBotId: team.byName[ada] as string,
            participantBotIds: team.ids,
          })
        ).task,
      );
    const watcher = setInterval(() => {
      peak = Math.max(peak, engine.worker.activeJobs);
    }, 5);
    try {
      for (const task of tasks) {
        const view = await untilTask(
          engine,
          task.id,
          finished("completed"),
          "a chain to finish",
          30_000,
        );
        expect(view.sessions.map((s) => s.depth).sort()).toEqual([0, 1, 2]);
      }
    } finally {
      clearInterval(watcher);
    }
    expect(peak).toBe(1);
    const left = await db.database.db
      .select()
      .from(jobs)
      .where(
        and(
          inArray(
            jobs.taskId,
            tasks.map((t) => t.id),
          ),
          inArray(jobs.status, ["queued", "running"]),
        ),
      );
    expect(left).toEqual([]);
  });

  it("delivers a notification without activating its recipient", async () => {
    const { engine, executor } = await setup();
    const team = await createTeam(engine, ["Ada", "Bob"]);
    const [ada, bob] = team.names as [string, string];
    const coordinator: Brain = (view) => {
      if (said.turns(view) === 0)
        return {
          calls: [{ name: "delegate", args: { bot: bob, brief: "work" } }],
        };
      if (!said.heard(view, `Result from ${bob} (session`))
        return { text: "waiting" };
      if (lastResult(view)?.name === "complete_task") return { text: "Done." };
      const heardNote = said.heard(view, `Message from ${bob}:\nFYI halfway`);
      return {
        calls: [
          {
            name: "complete_task",
            args: { result: `note seen: ${heardNote}` },
          },
        ],
      };
    };
    executor.brain(ada, coordinator).brain(bob, (view) => {
      switch (said.turns(view)) {
        case 0:
          return { calls: [{ name: "gate", args: { name: "start" } }] };
        case 1:
          return {
            calls: [
              { name: "message", args: { to: ada, text: "FYI halfway" } },
            ],
          };
        case 2:
          return { calls: [{ name: "gate", args: { name: "note" } }] };
        default:
          return { text: "finished" };
      }
    });
    const { task } = await engine.tasks.create({
      goal: "Notify",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    await executor.gate("start").reached;
    await untilTask(
      engine,
      task.id,
      (view) =>
        view.sessions.find((s) => s.parentSessionId === null)?.status ===
        "waiting",
      "the coordinator to wait",
    );
    executor.gate("start").open();
    await executor.gate("note").reached;
    const view = await engine.tasks.get(task.id);
    const note = view.messages.find((m) => m.text === "FYI halfway");
    expect(note).toMatchObject({
      intent: "discussion",
      authorBotId: team.byName[bob],
      recipientBotIds: [team.byName[ada]],
    });
    const root = view.sessions.find((s) => s.parentSessionId === null);
    expect(root).toMatchObject({ status: "waiting", runCount: 1 });
    const pending = await db.database.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.sessionId, root?.id as string),
          inArray(jobs.status, ["queued", "running"]),
        ),
      );
    expect(pending).toEqual([]);
    executor.gate("note").open();
    const done = await untilTask(engine, task.id, finished("completed"));
    // The note waited in the inbox and reached the coordinator with the result.
    expect(done.task.result).toBe("note seen: true");
    expect(
      done.sessions.find((s) => s.parentSessionId === null)?.runCount,
    ).toBe(2);
  });

  it("delivers a broadcast to every other active session without activating any", async () => {
    const { engine, executor } = await setup();
    const team = await createTeam(engine, ["Ada", "Bob", "Cy"]);
    const [ada, bob, cy] = team.names as [string, string, string];
    const broadcast = `Message from ${bob} to everyone:\nFYI the API changed`;
    executor
      .brain(ada, (view) => {
        if (said.turns(view) === 0)
          return {
            calls: [
              { name: "delegate", args: { bot: bob, brief: "work" } },
              { name: "delegate", args: { bot: cy, brief: "more work" } },
            ],
          };
        if (reported(view, [bob, cy]).length < 2) return { text: "" };
        if (lastResult(view)?.name === "complete_task")
          return { text: "Done." };
        return {
          calls: [
            {
              name: "complete_task",
              args: { result: `ada heard: ${said.heard(view, broadcast)}` },
            },
          ],
        };
      })
      .brain(bob, (view) => {
        switch (said.turns(view)) {
          case 0:
            return { calls: [{ name: "gate", args: { name: "start" } }] };
          case 1:
            return {
              calls: [
                { name: "message", args: { text: "FYI the API changed" } },
              ],
            };
          case 2:
            return { calls: [{ name: "gate", args: { name: "note" } }] };
          default:
            return { text: `bob heard: ${said.heard(view, broadcast)}` };
        }
      })
      .brain(cy, (view) =>
        said.turns(view) === 0
          ? { calls: [{ name: "gate", args: { name: "cy" } }] }
          : { text: `cy heard: ${said.heard(view, broadcast)}` },
      );
    const { task } = await engine.tasks.create({
      goal: "Broadcast",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    await executor.gate("start").reached;
    await executor.gate("cy").reached;
    await untilTask(
      engine,
      task.id,
      (view) =>
        view.sessions.find((s) => s.parentSessionId === null)?.status ===
        "waiting",
      "the coordinator to wait",
    );
    executor.gate("start").open();
    await executor.gate("note").reached;
    const view = await engine.tasks.get(task.id);
    expect(
      view.messages.find((m) => m.text === "FYI the API changed"),
    ).toMatchObject({ intent: "discussion", recipientBotIds: [] });
    const root = view.sessions.find((s) => s.parentSessionId === null);
    // The waiting coordinator got it in its inbox but was not launched.
    expect(root).toMatchObject({ status: "waiting", runCount: 1 });
    const pending = await db.database.db
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.sessionId, root?.id as string),
          inArray(jobs.status, ["queued", "running"]),
        ),
      );
    expect(pending).toEqual([]);
    const page = await engine.tasks.events(task.id);
    const sent = page.events.find(
      (e) => e.type === "tool.finished" && e.payload.tool === "message",
    );
    expect(sent?.type === "tool.finished" && sent.payload.output).toBe(
      "Posted, and sent to 2 active session(s) on the task.",
    );
    executor.gate("cy").open();
    executor.gate("note").open();
    const done = await untilTask(engine, task.id, finished("completed"));
    const resultOf = (name: string) =>
      done.sessions.find((s) => s.botId === team.byName[name])?.result;
    // The running worker read it at its next turn; the sender did not get it back.
    expect(resultOf(cy)).toBe("cy heard: true");
    expect(resultOf(bob)).toBe("bob heard: false");
    // The coordinator read it with the results that woke it.
    expect(done.task.result).toBe("ada heard: true");
    expect(done.sessions).toHaveLength(3);
    expect(
      done.sessions
        .filter((s) => s.parentSessionId !== null)
        .map((s) => s.runCount),
    ).toEqual([1, 1]);
  });

  it("routes a third bot through the same paths", async () => {
    const { engine, executor } = await setup();
    const team = await createTeam(engine, ["Ada", "Bob", "Cy", "Dee"]);
    const [ada, ...workers] = team.names as [string, ...string[]];
    executor.brain(ada, delegatingCoordinator(workers));
    for (const worker of workers) executor.brain(worker, writingWorker(worker));
    const { task } = await engine.tasks.create({
      goal: "Three workers",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    const view = await untilTask(engine, task.id, finished("completed"));
    const results = view.messages.filter(
      (m) => m.intent === "result" && m.authorBotId !== team.byName[ada],
    );
    expect(results).toHaveLength(3);
    for (const message of results)
      expect(message.recipientBotIds).toEqual([team.byName[ada]]);
    expect(view.task.result).toContain(workers[2]);
    expect(new Set(view.artifacts.map((a) => a.path))).toEqual(
      new Set(workers.map((worker) => `${worker}.txt`)),
    );
  });

  it("reports a failed worker to its parent and a failed coordinator on the task", async () => {
    const { engine, executor } = await setup();
    const team = await createTeam(engine, ["Ada", "Bob", "Lost"]);
    const [ada, bob, lost] = team.names as [string, string, string];
    // `lost` has no brain, so its executor call fails.
    executor
      .brain(ada, delegatingCoordinator([lost]))
      .brain(bob, writingWorker(bob));
    const { task } = await engine.tasks.create({
      goal: "Fail a worker",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    const view = await untilTask(engine, task.id, finished("completed"));
    const failedWorker = view.sessions.find(
      (s) => s.botId === team.byName[lost],
    );
    expect(failedWorker).toMatchObject({
      status: "failed",
      error: `No brain for ${lost}.`,
    });
    expect(view.messages).toContainEqual(
      expect.objectContaining({
        intent: "result",
        authorKind: "system",
        text: `${lost} failed: No brain for ${lost}.`,
        recipientBotIds: [team.byName[ada]],
      }),
    );
    // The report reached the coordinator as a run input or as injected steering.
    const rootId = view.sessions.find((s) => s.parentSessionId === null)?.id;
    const parentInputs = (
      await db.database.db
        .select()
        .from(sessionEntries)
        .where(eq(sessionEntries.sessionId, rootId as string))
    ).flatMap((row) =>
      row.entry.role === "user" ? [String(row.entry.text)] : [],
    );
    expect(
      parentInputs.some((text) =>
        text.startsWith(`Failure from ${lost} (session ${failedWorker?.id}):`),
      ),
    ).toBe(true);

    // A coordinator without a brain fails the task.
    const { task: second } = await engine.tasks.create({
      goal: "Fail the coordinator",
      coordinatorBotId: team.byName[lost] as string,
      participantBotIds: team.ids,
    });
    const failed = await untilTask(engine, second.id, finished("failed"));
    expect(failed.task.error).toBe(`${lost} failed: No brain for ${lost}.`);
    expect(failed.events.at(-1)).toMatchObject({
      type: "task.finished",
      payload: { status: "failed" },
    });
  });

  it("waits for the user when the coordinator ends its turn, and continues on a message", async () => {
    const { engine, executor } = await setup();
    const team = await createTeam(engine, ["Ada"]);
    const [ada] = team.names as [string];
    executor.brain(ada, (view) => {
      const asks = said
        .inputs(view)
        .filter((text) => text.startsWith("Message from the user:")).length;
      const completions = said
        .results(view)
        .filter((result) => result.name === "complete_task").length;
      if (asks === 0) return { text: "Which colour?" };
      if (completions >= asks) return { text: "ok" };
      return {
        calls: [{ name: "complete_task", args: { result: "painted blue" } }],
      };
    });
    const { task } = await engine.tasks.create({
      goal: "Paint it",
      coordinatorBotId: team.byName[ada] as string,
    });
    const waiting = await untilTask(engine, task.id, finished("waiting"));
    expect(waiting.sessions[0]).toMatchObject({
      status: "waiting",
      waitingFor: "user",
    });
    expect(waiting.sessions[0]?.activity).toMatchObject({
      kind: "waiting",
      text: "Waiting for you",
    });
    expect(waiting.messages.at(-1)).toMatchObject({
      intent: "discussion",
      text: "Which colour?",
    });
    await engine.tasks.postMessage(task.id, { text: "blue" });
    const done = await untilTask(engine, task.id, finished("completed"));
    expect(done.task.result).toBe("painted blue");
    const types = done.events.map((e) => e.type);
    expect(types).toContain("task.reopened");
    expect(
      done.events.find((e) => e.type === "steering.received")?.payload,
    ).toMatchObject({ delivered: "queued" });
    // A completed task continues the same way.
    await engine.tasks.postMessage(task.id, { text: "blue" });
    const again = await untilTask(
      engine,
      task.id,
      (v) => v.sessions[0]?.runCount === 3 && v.task.status === "completed",
    );
    expect(
      again.events
        .filter((e) => e.type === "task.reopened")
        .map((e) => e.payload),
    ).toEqual([{ previous: "waiting" }, { previous: "completed" }]);
  });

  it("refuses delegations over the limits and to non-participants as tool errors", async () => {
    const { engine, executor } = await setup({
      config: { maxSessionsPerTask: 2, maxDelegationDepth: 1 },
    });
    const team = await createTeam(engine, ["Ada", "Bob", "Cy"]);
    const [ada, bob, cy] = team.names as [string, string, string];
    executor
      .brain(ada, (view) => {
        if (said.turns(view) === 0)
          return {
            calls: [
              { name: "delegate", args: { bot: "Stranger", brief: "x" } },
              { name: "delegate", args: { bot: bob, brief: "first" } },
              { name: "delegate", args: { bot: cy, brief: "second" } },
            ],
          };
        if (!said.heard(view, `Result from ${bob} (session`))
          return { text: "waiting" };
        if (lastResult(view)?.name === "complete_task")
          return { text: "Done." };
        return {
          calls: [{ name: "complete_task", args: { result: "limited" } }],
        };
      })
      .brain(bob, (view) => ({
        text: `tools: ${view.tools.map((tool) => tool.name).join(",")}`,
      }));
    const { task } = await engine.tasks.create({
      goal: "Limits",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    const view = await untilTask(engine, task.id, finished("completed"));
    const delegations = view.events.filter(
      (e) => e.type === "tool.finished" && e.payload.tool === "delegate",
    );
    expect(
      delegations.map((e) => e.type === "tool.finished" && e.payload.ok),
    ).toEqual([false, true, false]);
    expect(view.sessions).toHaveLength(2);
    const delegateTool = executor.inputs[0]?.collaborationTools.find(
      (tool) => tool.name === "delegate",
    );
    expect(delegateTool?.parameters).toMatchObject({
      properties: { bot: { enum: [bob, cy].sort() } },
    });
    // At the depth limit a worker gets no delegate tool.
    expect(view.sessions.find((s) => s.depth === 1)?.result).toBe(
      "tools: message",
    );
  });
});
