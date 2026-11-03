// A message never continues a run (architecture: Visibility is separate from
// activation), on the real pi runtime: one that reaches a session while the
// model is ending its turn rides along with input that continues the run
// anyway, in the order it arrived, or waits for the session's next run
// instead of giving the model another turn, after a crash too; a session
// that finishes first hands it to its parent.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { runs, sessionInbox } from "@jj/db";
import {
  callTool,
  conversation,
  fauxAssistantMessage,
  fauxToolCall,
  lastMessage,
  say,
  textOf,
} from "@jj/runtime/testing";
import { and, asc, eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { RunOutcome } from "./ports";
import { promptBot } from "./testing/fake-executor";
import {
  fauxTeamEngine,
  gate,
  resultArrived,
  rootOf,
  route,
  turn,
} from "./testing/faux-team";
import {
  OPEN_TIMEOUT,
  openTestDatabase,
  type TestDatabase,
  type TestEngine,
  until,
  untilTask,
} from "./testing/harness";
import { createTeam } from "./testing/scenarios";
import { PARK_AFTER_TURNS } from "./worker/parking";

let db: TestDatabase;
let current: TestEngine | undefined;
const opened: (() => void)[] = [];
const roots: string[] = [];

beforeAll(async () => {
  db = await openTestDatabase();
}, OPEN_TIMEOUT);
afterEach(async () => {
  for (const open of opened.splice(0)) open();
  await current?.dispose();
  current = undefined;
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
afterAll(async () => {
  await db?.close();
});

async function setup() {
  const team = await fauxTeamEngine(db.database);
  current = team;
  return { engine: team.engine, faux: team.faux };
}

/** A gate the test opens, and afterEach opens at the latest. */
function held() {
  const point = gate();
  opened.push(point.open);
  return point;
}

/**
 * A worker that dies after a run's last model call is saved, before the
 * run's write-back: once `when` holds for a run's outcome. `restart` waits
 * for the crash and starts the next worker on the same database and
 * workspace. `signals` holds each bot's latest run signal.
 */
async function crashing(
  when: (bot: string, outcome: RunOutcome) => boolean | Promise<boolean>,
) {
  const root = await mkdtemp(join(tmpdir(), "jj-crash-"));
  roots.push(root);
  const options = { workspaceRoot: root, config: { leaseMs: 1_000 } };
  const signals: Record<string, AbortSignal> = {};
  let crash: Promise<void> | undefined;
  const first = await fauxTeamEngine(
    db.database,
    (inner) => ({
      run: async (input) => {
        const bot = promptBot(input.systemPrompt);
        signals[bot] = input.signal;
        const outcome = await inner.run(input);
        if (!crash && (await when(bot, outcome))) {
          crash = first.engine.worker.abandon();
          await until(() => input.signal.aborted, { what: "the crash" });
        }
        return outcome;
      },
    }),
    options,
  );
  current = first;
  return {
    first,
    signals,
    async restart() {
      await until(() => crash !== undefined, {
        what: "the crash",
        timeoutMs: 20_000,
      });
      await crash;
      const second = await fauxTeamEngine(db.database, undefined, options);
      current = second;
      return second;
    },
  };
}

/** `sessionId`'s runs, oldest first, as [reason, status]. */
async function runsOf(sessionId: string | undefined) {
  const rows = await db.database.db
    .select()
    .from(runs)
    .where(eq(runs.sessionId, sessionId ?? ""))
    .orderBy(asc(runs.number));
  return rows.map((run) => [run.reason, run.status]);
}

describe("a message that arrives as the model ends its turn", () => {
  it("does not give a worker another turn: its report stands", async () => {
    const { engine, faux } = await setup();
    const team = await createTeam(engine, ["Ada", "Bob"]);
    const [ada, bob] = team.names as [string, string];
    const reporting = held();
    const broadcast = held();
    const calls = route(faux, {
      [ada]: async (context, n) => {
        if (n === 0)
          return callTool("delegate", { bot: bob, brief: "Write bob.txt." });
        if (resultArrived(context, bob))
          return callTool("complete_task", { result: "Done." });
        if (n === 1) {
          // To the team while Bob is writing his report.
          await reporting.opened;
          return callTool("message", { text: "Team: use lower case." });
        }
        broadcast.open();
        return say("");
      },
      [bob]: async (_context, n) => {
        if (n === 0)
          return callTool("write", { path: "bob.txt", content: "bob\n" });
        if (n === 1) {
          reporting.open();
          await broadcast.opened;
          return say("Bob's report.");
        }
        return say("Noted the lower case.");
      },
    });
    const { task } = await engine.tasks.create({
      goal: "Get bob.txt written",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    const done = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed" || v.task.status === "failed",
    );
    expect(done.task.status).toBe("completed");
    expect(calls[bob]).toBe(2);
    expect(
      done.sessions.find((session) => session.parentSessionId !== null)?.result,
    ).toBe("Bob's report.");
    // It is still in the task log for anyone to read.
    expect(
      done.messages.some(
        (message) =>
          message.intent === "notification" &&
          message.text === "Team: use lower case.",
      ),
    ).toBe(true);
  });

  it("waits for a coordinator's next run, which the result starts", async () => {
    const { engine, faux } = await setup();
    const team = await createTeam(engine, ["Ada", "Bob"]);
    const [ada, bob] = team.names as [string, string];
    const ending = held();
    const messaged = held();
    const reported = held();
    const seen: string[][] = [];
    const calls = route(faux, {
      [ada]: async (context, n) => {
        seen.push(conversation(context).map((message) => textOf(message)));
        if (n === 0)
          return callTool("delegate", { bot: bob, brief: "Write bob.txt." });
        if (resultArrived(context, bob) || n > 1)
          return callTool("complete_task", { result: "Done." });
        // Ada ends her turn to wait while Bob messages her.
        ending.open();
        await messaged.opened;
        return say("");
      },
      [bob]: async (_context, n) => {
        if (n === 0) {
          await ending.opened;
          return callTool("message", { to: ada, text: "FYI: lower case." });
        }
        messaged.open();
        await reported.opened;
        return say("Bob's report.");
      },
    });
    const { task } = await engine.tasks.create({
      goal: "Get bob.txt written",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    const waiting = await until(
      async () => {
        const view = await engine.tasks.get(task.id);
        return rootOf(view)?.status === "waiting" || (calls[ada] ?? 0) > 2
          ? view
          : undefined;
      },
      { what: "Ada to wait" },
    );
    expect(rootOf(waiting)?.waitingFor).toBe("delegations");
    expect(calls[ada]).toBe(2);

    reported.open();
    const done = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed" || v.task.status === "failed",
    );
    expect(done.task.status).toBe("completed");
    // The message rode along with the run Bob's result started.
    const woken = seen[2] ?? [];
    expect(woken.at(-2)).toBe(`Message from ${bob}:\nFYI: lower case.`);
    expect(woken.at(-1)).toMatch(/^Result from .+ \(session /);
  });
  it("hands a message the worker finished without reading to its parent, with its result", async () => {
    const { engine, faux } = await setup();
    const team = await createTeam(engine, ["Ada", "Bob"]);
    const [ada, bob] = team.names as [string, string];
    const reporting = held();
    const sent = held();
    const bobSaw: string[][] = [];
    const adaSaw: TranscriptContext[] = [];
    const calls = route(faux, {
      [ada]: async (context, n) => {
        adaSaw.push({ ...context, messages: [...context.messages] });
        if (n === 0)
          return callTool("delegate", { bot: bob, brief: "Write bob.txt." });
        if (resultArrived(context, bob))
          return callTool("complete_task", { result: "Done." });
        if (n === 1) {
          await reporting.opened;
          return callTool("message", {
            to: bob,
            text: "Also add a second line.",
          });
        }
        sent.open();
        return say("");
      },
      [bob]: async (context, n) => {
        bobSaw.push(conversation(context).map((message) => textOf(message)));
        if (n === 0)
          return callTool("write", { path: "bob.txt", content: "bob\n" });
        if (n === 1) {
          reporting.open();
          await sent.opened;
          return say("Bob's report.");
        }
        return say("Added the second line.");
      },
    });
    const { task } = await engine.tasks.create({
      goal: "Get bob.txt written",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    const done = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed" || v.task.status === "failed",
    );
    expect(done.task.status).toBe("completed");
    // Bob's report stands, and he never read the message.
    expect(calls[bob]).toBe(2);
    expect(bobSaw.flat().some((text) => text.includes("second line"))).toBe(
      false,
    );
    expect(
      done.sessions.find((session) => session.parentSessionId !== null)?.result,
    ).toBe("Bob's report.");
    // Ada gets it with his result.
    const result = textOf(lastMessage(adaSaw.at(-1) as TranscriptContext));
    expect(result).toMatch(/^Result from .+ \(session /);
    expect(result).toContain(
      `${bob} finished before reading a message sent to it, so it is handed to you (each is in the task log):\n\n> Message from ${ada}:\n> Also add a second line.`,
    );
  });

  it("hands unread messages to the parent with a worker's failure too", async () => {
    const { engine, faux } = await setup();
    const team = await createTeam(engine, ["Ada", "Bob"]);
    const [ada, bob] = team.names as [string, string];
    const failing = held();
    const sent = held();
    const adaSaw: TranscriptContext[] = [];
    route(faux, {
      [ada]: async (context, n) => {
        adaSaw.push({ ...context, messages: [...context.messages] });
        if (n === 0)
          return callTool("delegate", { bot: bob, brief: "Write bob.txt." });
        if (textOf(lastMessage(context)).startsWith(`Failure from ${bob}`))
          return callTool("complete_task", { result: "Bob failed." });
        if (n === 1) {
          await failing.opened;
          return callTool("message", { to: bob, text: "Use lower case." });
        }
        sent.open();
        return say("");
      },
      [bob]: async () => {
        failing.open();
        await sent.opened;
        return fauxAssistantMessage([], {
          stopReason: "error",
          errorMessage: "400 invalid request: the scripted call fails",
        });
      },
    });
    const { task } = await engine.tasks.create({
      goal: "Get bob.txt written",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    const done = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed" || v.task.status === "failed",
    );
    expect(done.task.status).toBe("completed");
    const failure = textOf(lastMessage(adaSaw.at(-1) as TranscriptContext));
    expect(failure).toMatch(/^Failure from .+ \(session /);
    expect(failure).toContain(
      `${bob} finished before reading a message sent to it, so it is handed to you (each is in the task log):\n\n> Message from ${ada}:\n> Use lower case.`,
    );
  });

  it("rides along with a result that continues a coordinator's run", async () => {
    const { engine, faux } = await setup();
    const team = await createTeam(engine, ["Ada", "Bob"]);
    const [ada, bob] = team.names as [string, string];
    const ending = held();
    const seen: string[][] = [];
    let taskId = "";
    const calls = route(faux, {
      [ada]: async (context, n) => {
        seen.push(conversation(context).map((message) => textOf(message)));
        if (n === 0)
          return callTool("delegate", { bot: bob, brief: "Write bob.txt." });
        if (resultArrived(context, bob))
          return callTool("complete_task", { result: "Done." });
        // Ada ends her turn to wait; Bob messages her and reports meanwhile.
        ending.open();
        await until(
          async () =>
            (await engine.tasks.get(taskId)).sessions.find(
              (session) => session.parentSessionId !== null,
            )?.status === "completed",
          { what: "Bob to report" },
        );
        return say("");
      },
      [bob]: async (_context, n) => {
        if (n === 0) {
          await ending.opened;
          return callTool("message", { to: ada, text: "FYI: lower case." });
        }
        return say("Bob's report.");
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
    // The result continued Ada's run, and the message came with it.
    expect(calls[ada]).toBe(3);
    expect(rootOf(done)?.runCount).toBe(1);
    const continued = seen[2] ?? [];
    expect(continued.at(-2)).toBe(`Message from ${bob}:\nFYI: lower case.`);
    expect(continued.at(-1)).toMatch(/^Result from .+ \(session /);
  });

  it("keeps the inbox's order when a result that lands after the turn ended continues the run", async () => {
    let adaName = "";
    let afterTurn: (() => Promise<void>) | undefined;
    // Holds Ada's run once her executor call has ended, past the turn-end
    // drain, until Bob has reported.
    const team0 = await fauxTeamEngine(db.database, (inner) => ({
      run: async (input) => {
        const outcome = await inner.run(input);
        const hook = afterTurn;
        if (
          hook &&
          promptBot(input.systemPrompt) === adaName &&
          outcome.kind === "ended"
        ) {
          afterTurn = undefined;
          await hook();
        }
        return outcome;
      },
    }));
    current = team0;
    const { engine, faux } = team0;
    const team = await createTeam(engine, ["Ada", "Bob"]);
    const [ada, bob] = team.names as [string, string];
    adaName = ada;
    const ending = held();
    const messaged = held();
    const report = held();
    const seen: string[][] = [];
    let taskId = "";
    afterTurn = async () => {
      report.open();
      await until(
        async () =>
          (await engine.tasks.get(taskId)).sessions.find(
            (session) => session.parentSessionId !== null,
          )?.status === "completed",
        { what: "Bob to report" },
      );
    };
    const calls = route(faux, {
      [ada]: async (context, n) => {
        seen.push(conversation(context).map((message) => textOf(message)));
        if (n === 0)
          return callTool("delegate", { bot: bob, brief: "Write bob.txt." });
        if (n === 1) {
          // Bob messages Ada while she ends her turn.
          ending.open();
          await messaged.opened;
          return say("Waiting for Bob.");
        }
        return callTool("complete_task", { result: "Done." });
      },
      [bob]: async (_context, n) => {
        if (n === 0) {
          await ending.opened;
          return callTool("message", { to: ada, text: "FYI: lower case." });
        }
        messaged.open();
        await report.opened;
        return say("Bob's report.");
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
    // The result continued Ada's run, and the message she was sent first
    // comes first.
    expect(calls[ada]).toBe(3);
    expect(rootOf(done)?.runCount).toBe(1);
    const continued = seen[2] ?? [];
    expect(continued.at(-2)).toBe(`Message from ${bob}:\nFYI: lower case.`);
    expect(continued.at(-1)).toMatch(/^Result from .+ \(session /);
  });
});

describe("a turn the engine ended before a crash", () => {
  it("is not resumed when the engine parked it: the coordinator waits, and a waiting message rides along with the result", async () => {
    let adaName = "";
    let taskId = "";
    let parkedAt = 0;
    const parked = held();
    // The worker dies once Ada's run parked her and Bob's message to her
    // waits in her inbox.
    const { first, restart, signals } = await crashing(async (bot, outcome) => {
      if (bot !== adaName || outcome.kind !== "ended") return false;
      parkedAt = calls[adaName] ?? 0;
      parked.open();
      await until(
        async () =>
          (
            await db.database.db
              .select({ id: sessionInbox.id })
              .from(sessionInbox)
              .where(
                and(
                  eq(
                    sessionInbox.sessionId,
                    rootOf(await first.engine.tasks.get(taskId))?.id ?? "",
                  ),
                  isNull(sessionInbox.deliveredAt),
                ),
              )
          ).length > 0,
        { what: "Bob's message to Ada" },
      );
      return true;
    });
    const team = await createTeam(first.engine, ["Ada", "Bob"]);
    const [ada, bob] = team.names as [string, string];
    adaName = ada;
    const calls = route(first.faux, {
      [ada]: async (_context, n) =>
        n === 0
          ? callTool("delegate", { bot: bob, brief: "Write bob.txt." })
          : callTool("task_state", {}),
      [bob]: async (_context, n) => {
        if (n === 0) {
          await parked.opened;
          return callTool("message", { to: ada, text: "FYI: lower case." });
        }
        // Cut off by the crash: never saved.
        await until(() => signals[bob]?.aborted, { what: "the crash" });
        return say("Unsaved.");
      },
    });
    const { task } = await first.engine.tasks.create({
      goal: "Get bob.txt written",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    taskId = task.id;

    const second = await restart();
    // Ada was parked after her delegation and PARK_AFTER_TURNS polls.
    expect(parkedAt).toBe(1 + PARK_AFTER_TURNS);
    const adaSaw: string[][] = [];
    const resumed = route(second.faux, {
      [ada]: async (context) => {
        adaSaw.push(conversation(context).map((message) => textOf(message)));
        return resultArrived(context, bob)
          ? callTool("complete_task", { result: "Done." })
          : callTool("task_state", {});
      },
      [bob]: async () => {
        await until(
          async () =>
            rootOf(await second.engine.tasks.get(task.id))?.status ===
            "waiting",
          { what: "Ada to wait" },
        );
        return say("Bob's report.");
      },
    });
    const done = await untilTask(
      second.engine,
      task.id,
      (v) => v.task.status === "completed" || v.task.status === "failed",
      "the recovered task",
      30_000,
    );
    expect(done.task.status).toBe("completed");
    // Ada's recovery waited without a model call: her one call read the
    // message, then the result that woke her.
    expect(resumed[ada]).toBe(1);
    expect(adaSaw[0]?.at(-2)).toBe(`Message from ${bob}:\nFYI: lower case.`);
    expect(adaSaw[0]?.at(-1)).toMatch(/^Result from .+ \(session /);
    expect(await runsOf(rootOf(done)?.id)).toEqual([
      ["start", "failed"],
      ["recovery", "waiting"],
      ["wake", "completed"],
    ]);
  }, 60_000);

  it("is not resumed when a completion ended the run: the task completes", async () => {
    let adaName = "";
    const { first, restart } = await crashing(
      (bot, outcome) => bot === adaName && outcome.kind === "ended",
    );
    const team = await createTeam(first.engine, ["Ada"]);
    const [ada] = team.names as [string];
    adaName = ada;
    route(first.faux, {
      [ada]: async () => callTool("complete_task", { result: "Done." }),
    });
    const { task } = await first.engine.tasks.create({
      goal: "Say done",
      coordinatorBotId: team.byName[ada] as string,
    });

    const second = await restart();
    const resumed = route(second.faux, {
      [ada]: async () => say("Resumed after the crash."),
    });
    const done = await untilTask(
      second.engine,
      task.id,
      (v) => v.task.status === "completed" || v.task.status === "failed",
      "the recovered task",
      30_000,
    );
    expect(done.task).toMatchObject({ status: "completed", result: "Done." });
    expect(resumed[ada]).toBeUndefined();
    expect(await runsOf(rootOf(done)?.id)).toEqual([
      ["start", "failed"],
      ["recovery", "completed"],
    ]);
  }, 60_000);
});

describe("a message a worker finished without reading", () => {
  it("is not read after a crash either: the worker's report stands, and its parent gets the message", async () => {
    let bobName = "";
    // The worker dies once Bob's final model call is saved.
    const { first, restart } = await crashing(
      (bot, outcome) => bot === bobName && outcome.kind === "ended",
    );
    const team = await createTeam(first.engine, ["Ada", "Bob"]);
    const [ada, bob] = team.names as [string, string];
    bobName = bob;
    const reporting = held();
    let taskId = "";
    route(first.faux, {
      [ada]: async (_context, n) => {
        if (n === 0)
          return callTool("delegate", { bot: bob, brief: "Write bob.txt." });
        if (n === 1) {
          await reporting.opened;
          return callTool("message", { to: bob, text: "Also add line 2." });
        }
        return say("");
      },
      [bob]: async (_context, n) => {
        if (n === 0)
          return callTool("write", { path: "bob.txt", content: "bob\n" });
        reporting.open();
        // The message reaches Bob during his final call.
        await until(
          async () =>
            rootOf(await first.engine.tasks.get(taskId))?.status === "waiting",
          { what: "Ada to wait" },
        );
        return say("Bob's report.");
      },
    });
    const { task } = await first.engine.tasks.create({
      goal: "Get bob.txt written",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    taskId = task.id;

    const second = await restart();
    const adaSaw: TranscriptContext[] = [];
    const calls = route(second.faux, {
      [ada]: async (context) => {
        adaSaw.push({ ...context, messages: [...context.messages] });
        return resultArrived(context, bob)
          ? callTool("complete_task", { result: "Done." })
          : say("");
      },
      [bob]: async () => say("Noted: added line 2."),
    });
    const done = await untilTask(
      second.engine,
      task.id,
      (v) => v.task.status === "completed" || v.task.status === "failed",
      "the recovered task",
      30_000,
    );
    expect(done.task.status).toBe("completed");
    // Bob's turn had ended: his recovery makes no model call.
    expect(calls[bob]).toBeUndefined();
    const bobSession = done.sessions.find(
      (session) => session.parentSessionId !== null,
    );
    expect(bobSession?.result).toBe("Bob's report.");
    expect(await runsOf(bobSession?.id)).toEqual([
      ["start", "failed"],
      ["recovery", "completed"],
    ]);
    const result = textOf(lastMessage(adaSaw.at(-1) as TranscriptContext));
    expect(result).toMatch(/^Result from .+ \(session /);
    expect(result).toContain(
      `${bob} finished before reading a message sent to it, so it is handed to you (each is in the task log):\n\n> Message from ${ada}:\n> Also add line 2.`,
    );
  }, 60_000);

  it("is counted with the ones its inbox left out, which the parent can list, and a clipped one points at its entry", async () => {
    const { engine, faux } = await setup();
    const team = await createTeam(engine, ["Ada", "Bob"]);
    const [ada, bob] = team.names as [string, string];
    const reporting = held();
    const sent = held();
    const adaSaw: TranscriptContext[] = [];
    const long = `START ${"x".repeat(3000)} END`;
    route(faux, {
      [ada]: async (context, n) => {
        adaSaw.push({ ...context, messages: [...context.messages] });
        if (n === 0)
          return callTool("delegate", { bot: bob, brief: "Write bob.txt." });
        if (resultArrived(context, bob))
          return callTool("complete_task", { result: "Done." });
        if (n === 1) {
          // 28 messages while Bob writes his report: his inbox keeps 20.
          await reporting.opened;
          return turn([
            ...Array.from({ length: 27 }, (_, i) =>
              fauxToolCall("message", { to: bob, text: `note ${i}` }),
            ),
            fauxToolCall("message", { to: bob, text: long }),
          ]);
        }
        sent.open();
        return say("");
      },
      [bob]: async (_context, n) => {
        if (n === 0)
          return callTool("write", { path: "bob.txt", content: "bob\n" });
        reporting.open();
        await sent.opened;
        return say("Bob's report.");
      },
    });
    const { task } = await engine.tasks.create({
      goal: "Get bob.txt written",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    const done = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed" || v.task.status === "failed",
    );
    expect(done.task.status).toBe("completed");
    const entry = (text: string) =>
      done.messages.find((message) => message.text === text)?.id;
    const result = textOf(lastMessage(adaSaw.at(-1) as TranscriptContext));
    expect(result).toContain(
      `${bob} finished before reading 28 messages sent to it, so they are handed to you (each is in the task log):\n\n(8 earlier messages, left out of its inbox — use \`task_log\` with kind "message" and before "${entry("note 8")}" to list them.)\n\n> Message from ${ada}:\n> note 8\n\n`,
    );
    expect(result).not.toContain("omitted]");
    expect(result).not.toContain("note 7\n");
    expect(result).toContain(
      `\n\n${entry(long)} (clipped; \`read_entry\` shows it in full):\n> Message from ${ada}:\n> START x`,
    );
    expect(result).toContain("characters left out …]");
  });

  it("is not handed on when it went to everyone: the parent received it too", async () => {
    const { engine, faux } = await setup();
    const team = await createTeam(engine, ["Ada", "Bob", "Carol"]);
    const [ada, bob, carol] = team.names as [string, string, string];
    const reporting = held();
    const sent = held();
    let adaSaw: string[] = [];
    const has = (context: TranscriptContext, name: string) =>
      conversation(context).some((message) =>
        textOf(message).startsWith(`Result from ${name}`),
      );
    route(faux, {
      [ada]: async (context, n) => {
        adaSaw = conversation(context).map((message) => textOf(message));
        if (n === 0)
          return turn([
            fauxToolCall("delegate", { bot: bob, brief: "Write bob.txt." }),
            fauxToolCall("delegate", { bot: carol, brief: "Write carol.txt." }),
          ]);
        if (has(context, bob) && has(context, carol))
          return callTool("complete_task", { result: "Done." });
        return say("");
      },
      [bob]: async (_context, n) => {
        if (n === 0)
          return callTool("write", { path: "bob.txt", content: "bob\n" });
        reporting.open();
        await sent.opened;
        return say("Bob's report.");
      },
      [carol]: async (_context, n) => {
        if (n === 0) {
          await reporting.opened;
          return turn([
            fauxToolCall("message", { to: bob, text: "Bob, use port 8080." }),
            fauxToolCall("message", { text: "Team: lower case." }),
          ]);
        }
        sent.open();
        return say("Carol's report.");
      },
    });
    const { task } = await engine.tasks.create({
      goal: "Get the files written",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    const done = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed" || v.task.status === "failed",
    );
    expect(done.task.status).toBe("completed");
    const bobResult = adaSaw.find((text) =>
      text.startsWith(`Result from ${bob}`),
    );
    expect(bobResult).toContain(
      `${bob} finished before reading a message sent to it, so it is handed to you (each is in the task log):\n\n> Message from ${carol}:\n> Bob, use port 8080.`,
    );
    expect(bobResult).not.toContain("lower case");
    // Ada read the broadcast once, from her own inbox.
    expect(adaSaw.filter((text) => text.includes("Team: lower case."))).toEqual(
      [`Message from ${carol} to everyone:\nTeam: lower case.`],
    );
  });
});
