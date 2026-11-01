// Regressions from the engine review (PR #55): the reviewer's repros R1–R5,
// adapted where the fix changed the expected behaviour, and tests for the two
// mutations the first suite let survive.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { artifacts, claim, jobs, sessions, taskMessages, tasks } from "@jj/db";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChatReply, ChatReplyInput } from "./ports";
import { type Brain, said } from "./testing/fake-executor";
import { FakeChatResponder } from "./testing/fakes";
import {
  OPEN_TIMEOUT,
  openTestDatabase,
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

/** Engines over one database and one workspace root, like workers of one install. */
async function engineOn(options: Parameters<typeof testEngine>[1] = {}) {
  root ??= await mkdtemp(join(tmpdir(), "jj-review-"));
  const engine = await testEngine(db.database, {
    workspaceRoot: root,
    ...options,
  });
  engines.push(engine);
  return engine;
}

const rootOf = <S extends { parentSessionId: string | null }>(view: {
  sessions: S[];
}) => view.sessions.find((s) => s.parentSessionId === null);

/** A chat responder that holds after its tools ran, until released or aborted. */
function holdingChat() {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  class HoldingChat extends FakeChatResponder {
    override async reply(input: ChatReplyInput): Promise<ChatReply> {
      const reply = await super.reply(input);
      await Promise.race([
        held,
        new Promise((resolve) =>
          input.signal.addEventListener("abort", resolve, { once: true }),
        ),
      ]);
      return reply;
    }
  }
  return { chat: new HoldingChat(), release: () => release() };
}

describe("review regressions", () => {
  it("R1: a notification never activates a waiting coordinator through a stale coalesced wake", async () => {
    const { engine, executor } = await engineOn({ config: { concurrency: 2 } });
    const team = await createTeam(engine, ["Ada", "Bob", "Zed"]);
    const [ada, bob, zed] = team.names as [string, string, string];
    executor
      .brain(ada, (view) => {
        if (said.turns(view) === 0)
          return {
            calls: [
              { name: "delegate", args: { bot: bob, brief: "work" } },
              { name: "gate", args: { name: "a1" } },
            ],
          };
        return { text: "" };
      })
      .brain(bob, (view) => {
        switch (said.turns(view)) {
          case 0:
            return { calls: [{ name: "gate", args: { name: "b1" } }] };
          case 1:
            return {
              calls: [{ name: "message", args: { to: ada, text: "FYI" } }],
            };
          case 2:
            return { calls: [{ name: "gate", args: { name: "b2" } }] };
          default:
            return { text: "bob done" };
        }
      })
      .brain(zed, (view) =>
        said.turns(view) === 0
          ? { calls: [{ name: "gate", args: { name: "z1" } }] }
          : { text: "zed waits" },
      );
    const { task: a } = await engine.tasks.create({
      goal: "A",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: [team.byName[bob] as string],
    });
    await executor.gate("a1").reached;
    await executor.gate("b1").reached;
    // A second task queues behind the two busy slots.
    await engine.tasks.create({
      goal: "B",
      coordinatorBotId: team.byName[zed] as string,
    });
    // Steering while Ada runs: injected, and it leaves a queued wake behind.
    await engine.tasks.postMessage(a.id, { text: "hello" });
    executor.gate("a1").open();
    await executor.gate("z1").reached;
    await untilTask(engine, a.id, (view) => rootOf(view)?.status === "waiting");
    executor.gate("b1").open(); // Bob notifies the waiting Ada.
    await executor.gate("b2").reached;
    executor.gate("z1").open(); // frees the slot the stale wake needs
    await until(
      async () =>
        (
          await db.database.db
            .select()
            .from(jobs)
            .where(
              and(
                eq(
                  jobs.sessionId,
                  rootOf(await engine.tasks.get(a.id))?.id as string,
                ),
                eq(jobs.status, "queued"),
              ),
            )
        ).length === 0,
      { what: "the stale wake to be consumed" },
    );
    const view = await engine.tasks.get(a.id);
    expect(rootOf(view)?.runCount).toBe(1);
    expect(rootOf(view)?.status).toBe("waiting");
    executor.gate("b2").open();
    // The note rides along with the run Bob's result starts.
    const done = await untilTask(
      engine,
      a.id,
      (v) => rootOf(v)?.runCount === 2 && rootOf(v)?.status === "waiting",
    );
    const adaInputs = executor.inputs
      .filter((input) => input.sessionId === rootOf(done)?.id)
      .flatMap((input) => input.inputs);
    expect(
      adaInputs.some((text) => text.startsWith(`Message from ${bob}:\nFYI`)),
    ).toBe(true);
  });

  it("R2: a chat reply handed off after create_task does not create a second task", async () => {
    const { chat, release } = holdingChat();
    const first = await engineOn({ chat });
    const team = await createTeam(first.engine, ["Ada"]);
    const [ada] = team.names as [string];
    const adaId = team.byName[ada] as string;
    const brain = () => ({
      calls: [
        { name: "create_task", args: { goal: "build it", participants: [] } },
      ],
      text: "Started.",
    });
    chat.brain(ada, brain);
    first.executor.brain(ada, () => ({ text: "question?" }));
    await first.engine.bots.sendMessage(adaId, { text: "build it" });
    await until(() => chat.toolResults.length === 1, { what: "create_task" });
    await first.engine.worker.stop(); // graceful: the reply is handed off
    const chat2 = new FakeChatResponder().brain(ada, brain);
    const second = await engineOn({ chat: chat2 });
    second.executor.brain(ada, () => ({ text: "question?" }));
    const conversation = await until(async () => {
      const view = await second.engine.bots.conversation(adaId);
      return view.messages.some((m) => m.role === "assistant")
        ? view
        : undefined;
    });
    release();
    const created = await db.database.db
      .select({ id: tasks.id, from: tasks.createdFromMessageId })
      .from(tasks)
      .where(eq(tasks.createdByBotId, adaId));
    expect(created).toHaveLength(1);
    expect(created[0]?.from).toBe(conversation.messages[0]?.id);
    expect(chat2.toolResults[0]?.result).toMatchObject({
      text: expect.stringContaining(created[0]?.id as string),
    });
    expect(conversation.messages.at(-1)).toMatchObject({
      role: "assistant",
      taskId: created[0]?.id,
    });
  });

  it("R2b: a relayed follow-up is posted once even when its reply runs twice", async () => {
    const { chat, release } = holdingChat();
    const first = await engineOn({ chat });
    const team = await createTeam(first.engine, ["Ada"]);
    const [ada] = team.names as [string];
    const adaId = team.byName[ada] as string;
    first.executor.brain(ada, () => ({ text: "Which colour?" }));
    const { task } = await first.engine.tasks.create({
      goal: "Paint",
      coordinatorBotId: adaId,
    });
    await untilTask(first.engine, task.id, (v) => v.task.status === "waiting");
    const brain = () => ({
      calls: [
        {
          name: "send_to_task",
          args: { taskId: task.id, text: "make it blue" },
        },
      ],
      text: "Forwarded.",
    });
    chat.brain(ada, brain);
    await first.engine.bots.sendMessage(adaId, { text: "make it blue" });
    await until(() => chat.toolResults.length === 1, { what: "send_to_task" });
    await first.engine.worker.stop();
    const chat2 = new FakeChatResponder().brain(ada, brain);
    const second = await engineOn({ chat: chat2 });
    second.executor.brain(ada, () => ({ text: "Blue it is." }));
    await until(() => chat2.toolResults.length === 1, {
      what: "the re-run reply",
    });
    release();
    const relayed = await db.database.db
      .select()
      .from(taskMessages)
      .where(
        and(
          eq(taskMessages.taskId, task.id),
          eq(taskMessages.text, "make it blue"),
        ),
      );
    expect(relayed).toHaveLength(1);
    expect(chat2.toolResults[0]?.result.isError).toBeFalsy();
  });

  it("R3: a run is credited only with files its own tools wrote; scan-only files are task-level", async () => {
    const { engine, executor } = await engineOn();
    const team = await createTeam(engine, ["Ada", "Bob", "Cy"]);
    const [ada, bob, cy] = team.names as [string, string, string];
    executor
      .brain(ada, (view) => {
        if (said.turns(view) === 0)
          return {
            calls: [
              { name: "delegate", args: { bot: bob, brief: "bob.txt" } },
              { name: "delegate", args: { bot: cy, brief: "cy.txt" } },
            ],
          };
        const both =
          said.heard(view, `Result from ${bob}`) &&
          said.heard(view, `Result from ${cy}`);
        if (!both) return { text: "" };
        if (lastResult(view)?.name === "complete_task") return { text: "ok" };
        return { calls: [{ name: "complete_task", args: { result: "ok" } }] };
      })
      .brain(bob, (view) => {
        switch (said.turns(view)) {
          case 0:
            return {
              calls: [
                { name: "write", args: { path: "bob.txt", content: "b\n" } },
              ],
            };
          case 1:
            return { calls: [{ name: "gate", args: { name: "bob" } }] };
          default:
            return { text: "bob wrote bob.txt" };
        }
      })
      .brain(cy, (view) => {
        switch (said.turns(view)) {
          case 0:
            return { calls: [{ name: "gate", args: { name: "cy" } }] };
          case 1:
            return {
              calls: [
                { name: "write", args: { path: "./cy.txt", content: "c\n" } },
                { name: "bash", args: { command: "echo log > cy-bash.log" } },
              ],
            };
          default:
            return { text: "cy wrote cy.txt" };
        }
      });
    const { task } = await engine.tasks.create({
      goal: "two files",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    await executor.gate("bob").reached;
    await executor.gate("cy").reached;
    executor.gate("cy").open();
    // Cy finishes first while Bob (who wrote bob.txt) still runs.
    await untilTask(engine, task.id, (view) =>
      view.sessions.some(
        (s) => s.botId === team.byName[cy] && s.status === "completed",
      ),
    );
    executor.gate("bob").open();
    await untilTask(
      engine,
      task.id,
      (view) => view.task.status === "completed",
    );
    const rows = await db.database.db
      .select({
        path: artifacts.path,
        sessionId: artifacts.sessionId,
        runId: artifacts.runId,
      })
      .from(artifacts)
      .where(eq(artifacts.taskId, task.id));
    const owner = new Map(
      (
        await db.database.db
          .select({ id: sessions.id, botId: sessions.botId })
          .from(sessions)
          .where(eq(sessions.taskId, task.id))
      ).map((row) => [row.id, row.botId]),
    );
    const by = (path: string) => rows.filter((row) => row.path === path);
    expect(by("bob.txt").map((row) => owner.get(row.sessionId ?? ""))).toEqual([
      team.byName[bob],
    ]);
    expect(by("cy.txt").map((row) => owner.get(row.sessionId ?? ""))).toEqual([
      team.byName[cy],
    ]);
    expect(by("cy-bash.log")).toEqual([
      { path: "cy-bash.log", sessionId: null, runId: null },
    ]);
  });

  it("R4: steering after a recorded completion voids it across a hand-off", async () => {
    const first = await engineOn();
    const team = await createTeam(first.engine, ["Ada"]);
    const [ada] = team.names as [string];
    const brain: Brain = (view) => {
      if (said.turns(view) === 0)
        return {
          calls: [
            { name: "complete_task", args: { result: "OLD RESULT" } },
            { name: "gate", args: { name: "hold" } },
          ],
        };
      return { text: "Will do: adding tests next. What framework?" };
    };
    first.executor.brain(ada, brain);
    const { task } = await first.engine.tasks.create({
      goal: "G",
      coordinatorBotId: team.byName[ada] as string,
    });
    await first.executor.gate("hold").reached;
    await first.engine.tasks.postMessage(task.id, { text: "also add tests" });
    await first.engine.worker.stop();
    const second = await engineOn();
    second.executor.brain(ada, brain);
    const view = await untilTask(
      second.engine,
      task.id,
      (v) => v.task.status === "completed" || v.task.status === "waiting",
    );
    expect(view.task.status).toBe("waiting");
    expect(view.task.result).toBeNull();
  });

  it("R5: a session of an ephemeral task waits for the worker that holds the workspace", async () => {
    const a = await engineOn({ config: { concurrency: 1 } });
    const { profile } = await a.engine.profiles.create({
      name: `Ephemeral ${Date.now()}`,
      sandbox: {
        driver: "local",
        network: { mode: "open" },
        workspace: "ephemeral",
      },
    });
    const team = await createTeam(a.engine, ["Ada", "Bob"]);
    const [ada, bob] = team.names as [string, string];
    await a.engine.bots.update(team.byName[ada] as string, {
      runtimeProfileId: profile.id,
    });
    const coord: Brain = (view) => {
      if (said.turns(view) === 0)
        return {
          calls: [
            { name: "write", args: { path: "plan.md", content: "plan\n" } },
            { name: "delegate", args: { bot: bob, brief: "read plan.md" } },
            { name: "gate", args: { name: "hold" } },
          ],
        };
      return { text: "" };
    };
    const worker: Brain = (view) =>
      said.turns(view) === 0
        ? { calls: [{ name: "read", args: { path: "plan.md" } }] }
        : { text: `bob read ${lastResult(view)?.text.trim()}` };
    a.executor.brain(ada, coord).brain(bob, worker);
    const { task } = await a.engine.tasks.create({
      goal: "E",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: [team.byName[bob] as string],
    });
    await a.executor.gate("hold").reached;
    // A second worker (no restart anywhere) is the only one with a free slot.
    const b = await engineOn();
    b.executor.brain(ada, coord).brain(bob, worker);
    const child = () =>
      a.engine.tasks
        .get(task.id)
        .then((v) => v.sessions.find((s) => s.role === "worker"));
    await until(
      async () =>
        (
          await db.database.db
            .select()
            .from(jobs)
            .where(eq(jobs.taskId, task.id))
        ).filter(
          (job) =>
            job.leaseOwner === b.engine.context.config.workerId &&
            job.status === "done",
        ).length >= 2,
      { what: "the other worker to hand the child back" },
    );
    expect((await child())?.status).toBe("queued");
    a.executor.gate("hold").open(); // the holder frees its slot and takes the child
    const done = await untilTask(a.engine, task.id, (v) =>
      v.sessions.some(
        (s) =>
          s.role === "worker" &&
          s.status !== "queued" &&
          s.status !== "running",
      ),
    );
    expect(done.sessions.find((s) => s.role === "worker")).toMatchObject({
      status: "completed",
      result: "bob read plan",
    });
    expect(b.executor.inputs).toEqual([]);
  });

  it("R5b: continuing a finished ephemeral task fails truthfully: its workspace was discarded", async () => {
    const { engine, executor } = await engineOn();
    const { profile } = await engine.profiles.create({
      name: `Ephemeral once ${Date.now()}`,
      sandbox: {
        driver: "local",
        network: { mode: "open" },
        workspace: "ephemeral",
      },
    });
    const team = await createTeam(engine, ["Ada"]);
    const [ada] = team.names as [string];
    await engine.bots.update(team.byName[ada] as string, {
      runtimeProfileId: profile.id,
    });
    executor.brain(ada, (view) =>
      lastResult(view)?.name === "complete_task"
        ? { text: "done" }
        : { calls: [{ name: "complete_task", args: { result: "r" } }] },
    );
    const { task } = await engine.tasks.create({
      goal: "Once",
      coordinatorBotId: team.byName[ada] as string,
    });
    await untilTask(engine, task.id, (v) => v.task.status === "completed");
    await engine.tasks.postMessage(task.id, { text: "one more thing" });
    const failed = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "failed",
    );
    expect(rootOf(failed)).toMatchObject({
      status: "failed",
      error: expect.stringContaining(
        "ephemeral workspace was discarded when its sandbox was released",
      ),
    });
  });

  it("posts a coordinator's reply while it waits on delegations", async () => {
    const { engine, executor } = await engineOn();
    const team = await createTeam(engine, ["Ada", "Bob"]);
    const [ada, bob] = team.names as [string, string];
    executor
      .brain(ada, (view) => {
        if (said.turns(view) === 0)
          return {
            calls: [{ name: "delegate", args: { bot: bob, brief: "slow" } }],
          };
        if (said.heard(view, `Result from ${bob}`))
          return lastResult(view)?.name === "complete_task"
            ? { text: "done" }
            : { calls: [{ name: "complete_task", args: { result: "ok" } }] };
        if (said.heard(view, "status?"))
          return { text: `${bob} is still working.` };
        return { text: "" };
      })
      .brain(bob, (view) =>
        said.turns(view) === 0
          ? { calls: [{ name: "gate", args: { name: "slow" } }] }
          : { text: "finished" },
      );
    const { task } = await engine.tasks.create({
      goal: "Status",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    await executor.gate("slow").reached;
    await untilTask(engine, task.id, (v) => rootOf(v)?.status === "waiting");
    await engine.tasks.postMessage(task.id, { text: "status?" });
    const answered = await untilTask(
      engine,
      task.id,
      (v) =>
        v.messages.some((m) => m.text === `${bob} is still working.`) &&
        rootOf(v)?.status === "waiting",
    );
    expect(
      answered.messages.find((m) => m.text === `${bob} is still working.`),
    ).toMatchObject({
      intent: "discussion",
      authorBotId: team.byName[ada],
    });
    expect(rootOf(answered)?.waitingFor).toBe("delegations");
    executor.gate("slow").open();
    await untilTask(engine, task.id, (v) => v.task.status === "completed");
  });
});

describe("mutation guards", () => {
  it("writes nothing in the window between losing the lease and the next heartbeat tick", async () => {
    // A 60 s lease ticks every 20 s, so only the write-time re-check can catch the loss.
    const { engine, executor } = await engineOn({
      config: { leaseMs: 60_000 },
    });
    const team = await createTeam(engine, ["Ada"]);
    const [ada] = team.names as [string];
    executor.brain(ada, (view) =>
      said.turns(view) === 0
        ? { calls: [{ name: "gate", args: { name: "window" } }] }
        : { text: "must not be written" },
    );
    const { task } = await engine.tasks.create({
      goal: "Window",
      coordinatorBotId: team.byName[ada] as string,
    });
    await executor.gate("window").reached;
    const stolen = await db.database.db.transaction(async (tx) => {
      await tx
        .update(jobs)
        .set({ leaseUntil: sql`now() - interval '1 second'` })
        .where(and(eq(jobs.taskId, task.id), eq(jobs.status, "running")));
      return claim(tx, "thief", 5, 60_000);
    });
    expect(stolen.jobs.map((job) => job.taskId)).toContain(task.id);
    const before = (await engine.tasks.events(task.id)).cursor;
    executor.gate("window").open(); // the run's next write lands in the window
    await until(() => engine.worker.activeJobs === 0, {
      what: "the run to stop",
    });
    expect(
      (await engine.tasks.events(task.id, { after: before })).events,
    ).toEqual([]);
  });

  it("stops a running child and never launches a queued one once their parent has finished", async () => {
    const { engine, executor } = await engineOn({
      config: { concurrency: 2, leaseMs: 600 },
    });
    const team = await createTeam(engine, ["Ada", "Bob", "Cy"]);
    const [ada, bob, cy] = team.names as [string, string, string];
    executor
      .brain(ada, (view) =>
        said.turns(view) === 0
          ? {
              calls: [
                {
                  name: "delegate",
                  args: { bot: bob, brief: "running child" },
                },
                { name: "delegate", args: { bot: cy, brief: "queued child" } },
                { name: "gate", args: { name: "parent" } },
              ],
            }
          : { text: "" },
      )
      .brain(bob, () => ({
        calls: [{ name: "gate", args: { name: "child" } }],
      }))
      .brain(cy, () => ({ text: "must not run" }));
    const { task } = await engine.tasks.create({
      goal: "Orphans",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    await executor.gate("parent").reached;
    await executor.gate("child").reached;
    // The parent finishes without its cancellation reaching the children
    // (as when a notification is lost): only the durable checks can stop them.
    const before = await engine.tasks.get(task.id);
    await db.database.db
      .update(sessions)
      .set({ status: "failed", error: "forced" })
      .where(eq(sessions.id, rootOf(before)?.id as string));
    const view = await untilTask(
      engine,
      task.id,
      (v) =>
        v.sessions
          .filter((s) => s.role === "worker")
          .every((s) => s.status === "cancelled"),
      "the children to stop",
    );
    expect(
      view.sessions.find((s) => s.botId === team.byName[cy])?.runCount,
    ).toBe(0);
    expect(executor.executed).toEqual([]);
    expect(
      executor.inputs.some((input) =>
        input.systemPrompt.startsWith(`You are ${cy}`),
      ),
    ).toBe(false);
  });
});
