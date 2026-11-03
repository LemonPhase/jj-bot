// Parking (worker/parking.ts) on the real pi runtime: a session with open
// delegations that only looks things up is ended as waiting after
// PARK_AFTER_TURNS such turns, and a result wakes it; work, or input reaching
// the session, starts the count over.
import type { TranscriptContext } from "@earendil-works/pi-ai";
import {
  callTool,
  conversation,
  fauxToolCall,
  lastMessage,
  say,
  textOf,
} from "@jj/runtime/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Engine } from "./engine";
import type { RunExecutor, RunInput } from "./ports";
import {
  fauxTeamEngine,
  gate as openable,
  resultArrived,
  rootOf,
  route,
  toolFinished,
  turn,
} from "./testing/faux-team";
import {
  OPEN_TIMEOUT,
  openTestDatabase,
  sleep,
  type TestDatabase,
  type TestEngine,
  until,
  untilTask,
} from "./testing/harness";
import { createTeam } from "./testing/scenarios";
import { PARK_AFTER_TURNS, parkedText } from "./worker/parking";

let db: TestDatabase;
let current: TestEngine | undefined;
/** Opened after each test, so no model call is left waiting. */
let release: () => void = () => {};

beforeAll(async () => {
  db = await openTestDatabase();
}, OPEN_TIMEOUT);
afterEach(async () => {
  release();
  await current?.dispose();
  current = undefined;
});
afterAll(async () => {
  await db?.close();
});

async function setup(wrap?: Parameters<typeof fauxTeamEngine>[1]) {
  const team = await fauxTeamEngine(db.database, wrap);
  current = team;
  return { engine: team.engine, faux: team.faux };
}

/** Stands in for a slow worker's model call; opened at the latest after the test. */
function gate() {
  const held = openable();
  release = held.open;
  return held;
}

/** Waits until the root session waits, or has made `max` model calls. */
const untilRootWaits = (
  engine: Engine,
  taskId: string,
  calls: () => number,
  max: number,
) =>
  until(
    async () => {
      const view = await engine.tasks.get(taskId);
      return rootOf(view)?.status === "waiting" || calls() >= max
        ? view
        : undefined;
    },
    { what: "the coordinator to wait" },
  );

describe("parking a session that only looks things up", () => {
  it("ends a coordinator's run as waiting after it polls its open delegation, and wakes it with the result", async () => {
    const { engine, faux } = await setup();
    const team = await createTeam(engine, ["Ada", "Bob"]);
    const [ada, bob] = team.names as [string, string];
    const worker = gate();
    const seen: TranscriptContext[] = [];
    // Every kind of lookup, a refused complete_task, and narration.
    const polls = [
      [fauxToolCall("task_state", {})],
      [
        fauxToolCall("read_report", { bot: bob }),
        fauxToolCall("read", { path: "bob.txt" }),
        fauxToolCall("ls", {}),
      ],
      [
        fauxToolCall("complete_task", { result: "Not yet." }),
        fauxToolCall("grep", { pattern: "bob" }),
        fauxToolCall("find", { pattern: "*.txt" }),
        fauxToolCall("task_log", {}),
      ],
    ];
    const calls = route(faux, {
      [ada]: (context, n) => {
        seen.push({ ...context, messages: [...context.messages] });
        if (n === 0)
          return callTool("delegate", { bot: bob, brief: "Write bob.txt." });
        if (resultArrived(context, bob))
          return callTool("complete_task", { result: "Bob wrote bob.txt." });
        return turn(polls[(n - 1) % polls.length] ?? [], "Checking on Bob.");
      },
      [bob]: async (_context, n) => {
        if (n > 0) return say("Bob wrote bob.txt.");
        await worker.opened;
        return callTool("write", { path: "bob.txt", content: "bob\n" });
      },
    });
    const { task } = await engine.tasks.create({
      goal: "Get bob.txt written",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });

    // Bob is still on his first call: Ada delegated, looked things up for
    // PARK_AFTER_TURNS turns, and was parked.
    const view = await untilRootWaits(
      engine,
      task.id,
      () => calls[ada] ?? 0,
      12,
    );
    expect(calls[ada]).toBe(1 + PARK_AFTER_TURNS);
    expect(rootOf(view)).toMatchObject({
      status: "waiting",
      waitingFor: "delegations",
    });
    expect(
      view.sessions.find((session) => session.parentSessionId !== null)?.status,
    ).toBe("running");
    const finished = await toolFinished(engine, task.id);
    const parked = finished.filter(
      (event) => event.payload.output === parkedText(1),
    );
    // Only the last lookup turn was refused, every call of it.
    expect(parked.map((event) => event.payload.tool)).toEqual([
      "complete_task",
      "grep",
      "find",
      "task_log",
    ]);
    for (const event of parked) expect(event.payload.ok).toBe(false);
    expect(
      finished
        .filter((event) => event.payload.tool === "task_state")
        .map((event) => event.payload.ok),
    ).toEqual([true]);
    const runEnds = (await engine.tasks.events(task.id)).events.filter(
      (event) =>
        event.type === "run.finished" && event.sessionId === rootOf(view)?.id,
    );
    expect(runEnds.map((event) => event.payload)).toEqual([
      { outcome: "waiting" },
    ]);
    // Narration of a parked turn is not an answer to the user.
    expect(view.messages.map((message) => message.text)).not.toContain(
      "Checking on Bob.",
    );
    // Parked means no more model calls while the worker is slow.
    await sleep(300);
    expect(calls[ada]).toBe(1 + PARK_AFTER_TURNS);

    worker.open();
    const done = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed" || v.task.status === "failed",
    );
    expect(done.task).toMatchObject({
      status: "completed",
      result: "Bob wrote bob.txt.",
    });
    // Woken by the result, with the parked turn's explanation before it.
    expect(calls[ada]).toBe(2 + PARK_AFTER_TURNS);
    const woken = conversation(seen.at(-1) as TranscriptContext);
    expect(textOf(woken.at(-1))).toMatch(/^Result from .+ \(session /);
    const before = woken.slice(-5, -1);
    expect(before.map((message) => message.role)).toEqual([
      "toolResult",
      "toolResult",
      "toolResult",
      "toolResult",
    ]);
    for (const message of before) expect(textOf(message)).toBe(parkedText(1));
  });

  it("does not park a coordinator doing real work while a delegation is open", async () => {
    const { engine, faux } = await setup();
    const team = await createTeam(engine, ["Ada", "Bob", "Cy"]);
    const [ada, bob, cy] = team.names as [string, string, string];
    const workers = gate();
    const lookup = () => fauxToolCall("task_state", {});
    // Never PARK_AFTER_TURNS lookup turns in a row: writing, delegating
    // more, messaging and running commands are work, and so is a turn that
    // looks something up and writes.
    const script = [
      turn([lookup()]),
      turn([fauxToolCall("task_log", {})]),
      turn([fauxToolCall("write", { path: "a.txt", content: "a\n" })]),
      turn([lookup()]),
      turn([fauxToolCall("read", { path: "a.txt" })]),
      turn([fauxToolCall("delegate", { bot: cy, brief: "Write cy.txt." })]),
      turn([lookup()]),
      turn([fauxToolCall("read_report", { bot: cy })]),
      turn([fauxToolCall("message", { to: bob, text: "Use lower case." })]),
      turn([lookup()]),
      turn([fauxToolCall("find", { pattern: "*.txt" })]),
      turn([fauxToolCall("bash", { command: "echo 2 >> a.txt" })]),
      turn([lookup()]),
      turn([fauxToolCall("ls", {})]),
      turn([
        lookup(),
        fauxToolCall("write", { path: "b.txt", content: "b\n" }),
      ]),
      turn([lookup()]),
      turn([fauxToolCall("grep", { pattern: "a" })]),
    ];
    const calls = route(faux, {
      [ada]: (context, n) => {
        if (n === 0)
          return callTool("delegate", { bot: bob, brief: "Write bob.txt." });
        const next = script[n - 1];
        if (next) return next;
        if (n === script.length + 1) return say("Waiting for Bob and Cy.");
        return callTool("complete_task", { result: "All written." });
      },
      [bob]: async () => {
        await workers.opened;
        return say("Bob is done.");
      },
      [cy]: async () => {
        await workers.opened;
        return say("Cy is done.");
      },
    });
    const { task } = await engine.tasks.create({
      goal: "Write the files",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });

    // Ada ran her whole script in one run and ended her turn herself.
    const view = await untilRootWaits(
      engine,
      task.id,
      () => calls[ada] ?? 0,
      script.length + 5,
    );
    expect(calls[ada]).toBe(script.length + 2);
    expect(rootOf(view)).toMatchObject({
      status: "waiting",
      waitingFor: "delegations",
    });
    const finished = await toolFinished(engine, task.id);
    expect(finished).toHaveLength(script.length + 2);
    expect(
      finished.filter((event) => event.payload.output?.startsWith("Not run:")),
    ).toEqual([]);
    expect(view.messages.map((message) => message.text)).toContain(
      "Waiting for Bob and Cy.",
    );

    workers.open();
    const done = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed" || v.task.status === "failed",
    );
    expect(done.task.status).toBe("completed");
    expect(done.artifacts.map((artifact) => artifact.path).sort()).toEqual(
      expect.arrayContaining(["a.txt", "b.txt"]),
    );
  });

  it("starts the count over when input reaches the session", async () => {
    const { engine, faux } = await setup();
    const team = await createTeam(engine, ["Ada", "Bob"]);
    const [ada, bob] = team.names as [string, string];
    const worker = gate();
    const seen: TranscriptContext[] = [];
    let taskId = "";
    const calls = route(faux, {
      [ada]: async (context, n) => {
        seen.push({ ...context, messages: [...context.messages] });
        if (n === 0)
          return callTool("delegate", { bot: bob, brief: "Write bob.txt." });
        if (resultArrived(context, bob))
          return callTool("complete_task", { result: "Done." });
        // The user asks during the last turn before Ada would be parked; it
        // reaches her at that turn's boundary.
        if (n === PARK_AFTER_TURNS - 1)
          await engine.tasks.postMessage(taskId, { text: "Any news?" });
        return callTool("task_state", {});
      },
      [bob]: async (_context, n) => {
        if (n > 0) return say("Bob wrote bob.txt.");
        await worker.opened;
        return callTool("write", { path: "bob.txt", content: "bob\n" });
      },
    });
    const { task } = await engine.tasks.create({
      goal: "Get bob.txt written",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    taskId = task.id;

    await untilRootWaits(engine, task.id, () => calls[ada] ?? 0, 15);
    // PARK_AFTER_TURNS - 1 lookups, the steering, then PARK_AFTER_TURNS more.
    expect(calls[ada]).toBe(2 * PARK_AFTER_TURNS);
    expect(
      textOf(lastMessage(seen[PARK_AFTER_TURNS] as TranscriptContext)),
    ).toBe("Message from the user:\nAny news?");
    const parked = (await toolFinished(engine, task.id)).filter(
      (event) => event.payload.output === parkedText(1),
    );
    expect(parked).toHaveLength(1);

    worker.open();
    const done = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed" || v.task.status === "failed",
    );
    expect(done.task.status).toBe("completed");
  });

  it("parks a worker that polls its own delegation, and its result wakes it", async () => {
    const { engine, faux } = await setup();
    const team = await createTeam(engine, ["Ada", "Bob", "Cy"]);
    const [ada, bob, cy] = team.names as [string, string, string];
    const worker = gate();
    const calls = route(faux, {
      [ada]: (context, n) => {
        if (n === 0)
          return callTool("delegate", {
            bot: bob,
            brief: "Get cy.txt written.",
          });
        if (resultArrived(context, bob))
          return callTool("complete_task", { result: "Done." });
        return say("");
      },
      [bob]: (context, n) => {
        if (n === 0)
          return callTool("delegate", { bot: cy, brief: "Write it." });
        if (resultArrived(context, cy)) return say("Cy wrote cy.txt.");
        return callTool("task_state", {});
      },
      [cy]: async () => {
        await worker.opened;
        return say("Wrote cy.txt.");
      },
    });
    const { task } = await engine.tasks.create({
      goal: "Get cy.txt written",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    const bobWaits = await until(
      async () => {
        const view = await engine.tasks.get(task.id);
        const session = view.sessions.find((s) => s.botId === team.byName[bob]);
        return session?.status === "waiting" || (calls[bob] ?? 0) >= 12
          ? session
          : undefined;
      },
      { what: "Bob to wait" },
    );
    expect(bobWaits).toMatchObject({
      status: "waiting",
      waitingFor: "delegations",
    });
    expect(calls[bob]).toBe(1 + PARK_AFTER_TURNS);

    worker.open();
    const done = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed" || v.task.status === "failed",
    );
    expect(done.task.status).toBe("completed");
    expect(calls[bob]).toBe(2 + PARK_AFTER_TURNS);
  });
  it("does not count turns that only read the workspace, nor start the count over with them", async () => {
    const { engine, faux } = await setup();
    const team = await createTeam(engine, ["Ada", "Bob"]);
    const [ada, bob] = team.names as [string, string];
    const worker = gate();
    const read = (path: string) => turn([fauxToolCall("read", { path })]);
    const state = () => turn([fauxToolCall("task_state", {})]);
    // Exploring the workspace while Bob works: never parked. Then polls
    // with reads between them: parked at the PARK_AFTER_TURNS-th poll.
    const script = [
      read("a.txt"),
      turn([fauxToolCall("grep", { pattern: "x" })]),
      read("b.txt"),
      turn([fauxToolCall("find", { pattern: "*" })]),
      turn([fauxToolCall("ls", {})]),
      state(),
      read("c.txt"),
      state(),
      turn([fauxToolCall("grep", { pattern: "y" })]),
      state(),
    ];
    const calls = route(faux, {
      [ada]: (context, n) => {
        if (n === 0)
          return callTool("delegate", { bot: bob, brief: "Write bob.txt." });
        if (resultArrived(context, bob))
          return callTool("complete_task", { result: "Done." });
        return script[n - 1] ?? say("");
      },
      [bob]: async () => {
        await worker.opened;
        return say("Bob is done.");
      },
    });
    const { task } = await engine.tasks.create({
      goal: "Get bob.txt written",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    await untilRootWaits(engine, task.id, () => calls[ada] ?? 0, 20);
    expect(calls[ada]).toBe(1 + script.length);
    const finished = await toolFinished(engine, task.id);
    const parked = finished.filter(
      (event) => event.payload.output === parkedText(1),
    );
    expect(parked.map((event) => event.payload.tool)).toEqual(["task_state"]);
    // Every read ran.
    expect(
      finished.filter((event) =>
        ["read", "grep", "find", "ls"].includes(event.payload.tool),
      ),
    ).toHaveLength(7);

    worker.open();
    const done = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed" || v.task.status === "failed",
    );
    expect(done.task.status).toBe("completed");
  });

  it("does not start the count over for a message, which wakes no one", async () => {
    const { engine, faux } = await setup();
    const team = await createTeam(engine, ["Ada", "Bob"]);
    const [ada, bob] = team.names as [string, string];
    const polled = gate();
    const worker = gate();
    const seen: TranscriptContext[] = [];
    const calls = route(faux, {
      [ada]: async (context, n) => {
        seen.push({ ...context, messages: [...context.messages] });
        if (n === 0)
          return callTool("delegate", { bot: bob, brief: "Write bob.txt." });
        if (resultArrived(context, bob))
          return callTool("complete_task", { result: "Done." });
        // Bob messages Ada during her first poll; she reads it at its end.
        if (n === 1) await polled.opened;
        return callTool("task_state", {});
      },
      [bob]: async (_context, n) => {
        if (n === 0)
          return callTool("message", { to: ada, text: "Still on it." });
        polled.open();
        await worker.opened;
        return say("Bob wrote bob.txt.");
      },
    });
    const { task } = await engine.tasks.create({
      goal: "Get bob.txt written",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    await untilRootWaits(engine, task.id, () => calls[ada] ?? 0, 15);
    expect(calls[ada]).toBe(1 + PARK_AFTER_TURNS);
    expect(textOf(lastMessage(seen[2] as TranscriptContext))).toBe(
      `Message from ${bob}:\nStill on it.`,
    );

    worker.open();
    const done = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed" || v.task.status === "failed",
    );
    expect(done.task.status).toBe("completed");
  });

  it("continues the run when a result lands between the decision to park and the run's end", async () => {
    let afterDecision: (() => Promise<void>) | undefined;
    // Runs `afterDecision` once, right after the engine decided to park.
    const wrap = (inner: RunExecutor): RunExecutor => ({
      run: (input: RunInput) =>
        inner.run({
          ...input,
          hooks: {
            ...input.hooks,
            reviewTurn: async (calls) => {
              const verdict = await input.hooks.reviewTurn?.(calls);
              const hook = afterDecision;
              if (verdict !== undefined && hook) {
                afterDecision = undefined;
                await hook();
              }
              return verdict;
            },
          },
        }),
    });
    const { engine, faux } = await setup(wrap);
    const team = await createTeam(engine, ["Ada", "Bob"]);
    const [ada, bob] = team.names as [string, string];
    const worker = gate();
    let taskId = "";
    afterDecision = async () => {
      // Bob finishes, and his result is delivered, before Ada's run ends.
      worker.open();
      await until(
        async () =>
          (await engine.tasks.get(taskId)).sessions.find(
            (session) => session.parentSessionId !== null,
          )?.status === "completed",
        { what: "Bob to complete" },
      );
    };
    const calls = route(faux, {
      [ada]: (context, n) => {
        if (n === 0)
          return callTool("delegate", { bot: bob, brief: "Write bob.txt." });
        if (resultArrived(context, bob))
          return callTool("complete_task", { result: "Bob wrote bob.txt." });
        return callTool("task_state", {});
      },
      [bob]: async (_context, n) => {
        if (n > 0) return say("Bob wrote bob.txt.");
        await worker.opened;
        return callTool("write", { path: "bob.txt", content: "bob\n" });
      },
    });
    const { task } = await engine.tasks.create({
      goal: "Get bob.txt written",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    taskId = task.id;
    const done = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed" || v.task.status === "failed",
    );
    expect(done.task.status).toBe("completed");
    expect(calls[ada]).toBe(2 + PARK_AFTER_TURNS);
    // In the same run: the end-of-run write-back found the result.
    expect(rootOf(done)?.runCount).toBe(1);
    const parked = (await toolFinished(engine, task.id)).filter(
      (event) => event.payload.output === parkedText(1),
    );
    expect(parked).toHaveLength(1);
  });
});
