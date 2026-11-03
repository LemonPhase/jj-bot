// A message never continues a run (architecture: Visibility is separate from
// activation), on the real pi runtime: one that reaches a session while the
// model is ending its turn rides along with input that continues the run
// anyway, or waits for the session's next run instead of giving the model
// another turn; a session that finishes first hands it to its parent.
import type { TranscriptContext } from "@earendil-works/pi-ai";
import {
  callTool,
  conversation,
  fauxAssistantMessage,
  lastMessage,
  say,
  textOf,
} from "@jj/runtime/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  fauxTeamEngine,
  gate,
  resultArrived,
  rootOf,
  route,
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

let db: TestDatabase;
let current: TestEngine | undefined;
const opened: (() => void)[] = [];

beforeAll(async () => {
  db = await openTestDatabase();
}, OPEN_TIMEOUT);
afterEach(async () => {
  for (const open of opened.splice(0)) open();
  await current?.dispose();
  current = undefined;
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
});
