import { conversationViewSchema } from "@jj/contracts";
import { tasks, usage } from "@jj/db";
import { and, eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ChatReplyInput } from "./ports";
import { said } from "./testing/fake-executor";
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
  writingWorker,
} from "./testing/scenarios";

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

const lastUser = (input: ChatReplyInput) => input.history.at(-1)?.text ?? "";

/** Greets, creates a task for "build …", forwards "also …" to an active task. */
function chatBrain(helper: string) {
  return (input: ChatReplyInput) => {
    const text = lastUser(input);
    if (/^(hi|hello|thanks)/i.test(text))
      return { text: "Hello! How can I help?" };
    const forward = input.tools.find((tool) => tool.name === "send_to_task");
    if (text.startsWith("also") && forward) {
      const taskId = (
        forward.parameters as { properties: { taskId: { enum: string[] } } }
      ).properties.taskId.enum[0];
      return {
        calls: [{ name: "send_to_task", args: { taskId, text } }],
        text: "Forwarded.",
      };
    }
    if (text.startsWith("build"))
      return {
        calls: [
          { name: "create_task", args: { goal: text, participants: [helper] } },
        ],
      };
    return { text: "Could you say more?" };
  };
}

async function replies(
  engine: TestEngine["engine"],
  botId: string,
  count: number,
) {
  return until(
    async () => {
      const view = await engine.bots.conversation(botId);
      const answered = view.messages.filter(
        (m) => m.role === "assistant",
      ).length;
      return answered >= count && !view.replying
        ? conversationViewSchema.parse(view)
        : undefined;
    },
    { what: `${count} replies` },
  );
}

async function createdBy(botId: string) {
  return db.database.db
    .select()
    .from(tasks)
    .where(eq(tasks.createdByBotId, botId));
}

describe("direct chat", () => {
  it("answers greetings without a task, creates one task for work and forwards follow-ups", async () => {
    const { engine, chat, executor } = await setup();
    const team = await createTeam(engine, ["Ada", "Bob"]);
    const [ada, bob] = team.names as [string, string];
    const adaId = team.byName[ada] as string;
    chat.brain(ada, chatBrain(bob));
    executor.brain(ada, (view) => {
      if (
        said.heard(
          view,
          "relayed from the user's direct chat:\nalso add a footer",
        )
      )
        return { text: "Footer noted; anything else?" };
      return { text: "Started; I will report back." };
    });

    await engine.bots.sendMessage(adaId, { text: "hello there" });
    let view = await replies(engine, adaId, 1);
    expect(view.messages.map((m) => [m.role, m.text, m.taskId])).toEqual([
      ["user", "hello there", null],
      ["assistant", "Hello! How can I help?", null],
    ]);
    expect(await createdBy(adaId)).toEqual([]);

    await engine.bots.sendMessage(adaId, { text: "build a landing page" });
    view = await replies(engine, adaId, 2);
    const created = await createdBy(adaId);
    expect(created).toHaveLength(1);
    const taskId = created[0]?.id as string;
    expect(view.messages.at(-1)).toMatchObject({ role: "assistant", taskId });
    const toolInput = chat.inputs.at(-1);
    const createTool = toolInput?.tools.find(
      (tool) => tool.name === "create_task",
    );
    expect(createTool?.parameters).toMatchObject({
      properties: {
        participants: { items: { enum: expect.arrayContaining([ada, bob]) } },
      },
    });
    const { task } = await untilTask(
      engine,
      taskId,
      (v) => v.task.status === "waiting",
    );
    expect(task).toMatchObject({
      coordinatorBotId: adaId,
      // The coordinator first, then the others.
      participantBotIds: [adaId, team.byName[bob]],
      goal: "build a landing page",
    });
    expect((await engine.bots.get(adaId)).bot.activeTaskIds).toEqual([taskId]);

    await engine.bots.sendMessage(adaId, { text: "also add a footer" });
    view = await replies(engine, adaId, 3);
    expect(view.messages.at(-1)).toMatchObject({ text: "Forwarded.", taskId });
    expect(await createdBy(adaId)).toHaveLength(1);
    const sendTool = chat.inputs
      .at(-1)
      ?.tools.find((tool) => tool.name === "send_to_task");
    expect(sendTool?.parameters).toMatchObject({
      properties: { taskId: { enum: [taskId] } },
    });
    const taskView = await untilTask(engine, taskId, (v) =>
      v.messages.some((m) => m.text === "Footer noted; anything else?"),
    );
    expect(taskView.messages).toContainEqual(
      expect.objectContaining({
        intent: "discussion",
        authorKind: "bot",
        authorBotId: adaId,
        text: "also add a footer",
        recipientBotIds: [adaId],
      }),
    );
    const chatUsage = await db.database.db
      .select()
      .from(usage)
      .where(and(eq(usage.botId, adaId), isNull(usage.taskId)));
    expect(chatUsage).toHaveLength(3);
  });

  it("enforces the per-bot task creation limit", async () => {
    const { engine, chat, executor } = await setup({
      config: { tasksPerBotPerHour: 2 },
    });
    const team = await createTeam(engine, ["Ada", "Bob"]);
    const [ada, bob] = team.names as [string, string];
    const adaId = team.byName[ada] as string;
    chat.brain(ada, chatBrain(bob));
    executor.brain(ada, () => ({ text: "on it" }));
    for (let index = 1; index <= 3; index += 1) {
      await engine.bots.sendMessage(adaId, { text: `build thing ${index}` });
      await replies(engine, adaId, index);
    }
    expect(await createdBy(adaId)).toHaveLength(2);
    const refused = chat.toolResults
      .filter((entry) => entry.name === "create_task")
      .at(-1);
    expect(refused?.result).toMatchObject({ isError: true });
    expect(refused?.result.text).toContain("the limit");
    // Tasks the user creates do not count.
    const { task } = await engine.tasks.create({
      goal: "user task",
      coordinatorBotId: adaId,
    });
    expect(task.coordinatorBotId).toBe(adaId);
  });

  it("records why a reply failed and clears it when the next one succeeds", async () => {
    const { engine, chat } = await setup();
    const team = await createTeam(engine, ["Ada"]);
    const [ada] = team.names as [string];
    const adaId = team.byName[ada] as string;
    let fail = true;
    chat.brain(ada, () => {
      if (fail)
        throw Object.assign(new Error("provider overloaded"), {
          code: "rate_limit",
        });
      return { text: "back" };
    });
    await engine.bots.sendMessage(adaId, { text: "hi" });
    const failed = await until(async () => {
      const view = await engine.bots.conversation(adaId);
      return view.lastReplyError && !view.replying ? view : undefined;
    });
    expect(failed.lastReplyError?.message).toBe(
      "Reply failed (rate_limit): provider overloaded",
    );
    fail = false;
    await engine.bots.sendMessage(adaId, { text: "hi again" });
    const view = await replies(engine, adaId, 1);
    expect(view.lastReplyError).toBeNull();
  });

  it("shows a bot's memory in its own sessions only", async () => {
    const { engine, executor, chat } = await setup();
    const team = await createTeam(engine, ["Ada", "Bob"]);
    const [ada, bob] = team.names as [string, string];
    const adaId = team.byName[ada] as string;
    await engine.bots.putMemory(adaId, { text: "Ada prefers tabs." });
    executor
      .brain(ada, delegatingCoordinator([bob]))
      .brain(bob, writingWorker(bob));
    const { task } = await engine.tasks.create({
      goal: "Memory",
      coordinatorBotId: adaId,
      participantBotIds: team.ids,
    });
    const view = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed",
    );
    const prompts = (botId: string) =>
      executor.inputs
        .filter(
          (input) =>
            view.sessions.find((s) => s.id === input.sessionId)?.botId ===
            botId,
        )
        .map((input) => input.systemPrompt);
    expect(prompts(adaId).length).toBeGreaterThan(0);
    for (const prompt of prompts(adaId))
      expect(prompt).toContain("Ada prefers tabs.");
    for (const prompt of prompts(team.byName[bob] as string))
      expect(prompt).not.toContain("Ada prefers tabs.");
    chat.brain(ada, () => ({ text: "ok" }));
    await engine.bots.sendMessage(adaId, { text: "hi" });
    await replies(engine, adaId, 1);
    expect(chat.inputs.at(-1)?.systemPrompt).toContain("Ada prefers tabs.");
    expect((await engine.bots.getMemory(adaId)).text).toBe("Ada prefers tabs.");
    expect((await engine.bots.getMemory(team.byName[bob] as string)).text).toBe(
      "",
    );
  });
});
