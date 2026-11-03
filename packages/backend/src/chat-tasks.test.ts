// Direct chat's task tools and the task updates a coordinator's chat gets
// (issue #81): what each tool covers and refuses, continuing a finished task
// from chat, and exactly one update reply per task event, serialised with the
// user's replies, with the engine's fallback when the reply fails.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConversationView } from "@jj/contracts";
import { chatTaskUpdates, conversationMessages, jobs } from "@jj/db";
import { ModelRegistry, ChatResponder as PiChatResponder } from "@jj/runtime";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type {
  ChatReply,
  ChatReplyInput,
  CollabTool,
  CollabToolResult,
} from "./ports";
import { type Brain, said } from "./testing/fake-executor";
import { type ChatBrain, FakeChatResponder } from "./testing/fakes";
import {
  OPEN_TIMEOUT,
  openTestDatabase,
  sleep,
  type TestDatabase,
  type TestEngine,
  testEngine,
  until,
  untilTask,
} from "./testing/harness";
import { createTeam, lastResult } from "./testing/scenarios";
import { type ChatState, chatTools } from "./worker/chat-tools";

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

async function engineOn(options: Parameters<typeof testEngine>[1] = {}) {
  root ??= await mkdtemp(join(tmpdir(), "jj-chat-tasks-"));
  const engine = await testEngine(db.database, {
    workspaceRoot: root,
    ...options,
  });
  engines.push(engine);
  return engine;
}

const UPDATE = "[Task update]";
const lastInput = (input: ChatReplyInput) => input.history.at(-1)?.text ?? "";
const isUpdate = (input: ChatReplyInput) => lastInput(input).startsWith(UPDATE);
const toolNames = (input: ChatReplyInput) =>
  input.tools.map((tool) => tool.name);
const READ_TOOLS = ["list_tasks", "get_task", "read_task_log"];

/** Completes with `result` on its first run, then says done. */
const completes =
  (result: string): Brain =>
  (view) =>
    lastResult(view)?.name === "complete_task"
      ? { text: "Done." }
      : { calls: [{ name: "complete_task", args: { result } }] };

/** Ends its turn asking the user something: the task waits. */
const asks =
  (question: string): Brain =>
  () => ({ text: question });

/** The chat's tools for a bot, outside any reply, as a reply would build them. */
function toolsFor(
  engine: TestEngine,
  bot: { id: string; name: string },
  triggerId = "cmsg_test",
) {
  const ctx = engine.engine.context;
  const state: ChatState = { triggerId, linkedTaskId: null };
  const tools = chatTools({
    ctx,
    bot,
    redact: (text) => text,
    write: (fn) => ctx.db.transaction(fn),
    everyone: [],
    state,
  });
  const call = (name: string, args: Record<string, unknown>) =>
    (tools.find((tool) => tool.name === name) as CollabTool).execute(args, {
      toolCallId: "test",
      signal: new AbortController().signal,
    });
  return { tools, call, state };
}

async function conversation(engine: TestEngine, botId: string) {
  return engine.engine.bots.conversation(botId);
}

/** Waits until the bot's chat holds `count` assistant messages and is idle. */
function untilReplies(
  engine: TestEngine,
  botId: string,
  count: number,
): Promise<ConversationView> {
  return until(
    async () => {
      const view = await conversation(engine, botId);
      const answered = view.messages.filter((m) => m.role === "assistant");
      return answered.length >= count && !view.replying ? view : undefined;
    },
    { what: `${count} replies` },
  );
}

async function updatesOf(taskId: string) {
  return db.database.db
    .select()
    .from(chatTaskUpdates)
    .where(eq(chatTaskUpdates.taskId, taskId))
    .orderBy(chatTaskUpdates.taskEventSeq);
}

/** Two bots and three tasks: Ada coordinates one and takes part in Bob's; Bob alone has the third. */
async function threeTasks(engine: TestEngine) {
  const team = await createTeam(engine.engine, ["Ada", "Bob"]);
  const [ada, bob] = team.names as [string, string];
  const adaId = team.byName[ada] as string;
  const bobId = team.byName[bob] as string;
  engine.executor
    .brain(ada, completes("Wrote report.md with three sections."))
    .brain(bob, asks("Which colour?"));
  const own = (
    await engine.engine.tasks.create({
      goal: "Write the report",
      coordinatorBotId: adaId,
    })
  ).task;
  await untilTask(engine.engine, own.id, (v) => v.task.status === "completed");
  const shared = (
    await engine.engine.tasks.create({
      goal: "Paint the fence",
      coordinatorBotId: bobId,
      participantBotIds: [adaId, bobId],
    })
  ).task;
  const other = (
    await engine.engine.tasks.create({
      goal: "Bob's private errand",
      coordinatorBotId: bobId,
    })
  ).task;
  await untilTask(engine.engine, shared.id, (v) => v.task.status === "waiting");
  await untilTask(engine.engine, other.id, (v) => v.task.status === "waiting");
  return {
    ada: { id: adaId, name: ada },
    bob: { id: bobId, name: bob },
    own,
    shared,
    other,
  };
}

describe("direct chat task tools", () => {
  it("list only the bot's tasks, newest first, with its role and the outcome", async () => {
    const engine = await engineOn();
    const { ada, own, shared, other } = await threeTasks(engine);
    const { call } = toolsFor(engine, ada);
    const listed = await call("list_tasks", {});
    expect(listed.isError).toBeFalsy();
    const lines = listed.text.split("\n");
    expect(lines[0]).toBe("Your tasks, newest first (2 of 2):");
    expect(lines[1]).toMatch(
      new RegExp(
        `^- ${shared.id} "Paint the fence": waiting for the user · you take part · updated \\S+$`,
      ),
    );
    expect(lines[2]).toMatch(
      new RegExp(
        `^- ${own.id} "Write the report": completed · you coordinate · updated \\S+ · Result: Wrote report.md with three sections.$`,
      ),
    );
    expect(listed.text).not.toContain(other.id);
    const finished = await call("list_tasks", { status: "finished" });
    expect(finished.text).toContain(own.id);
    expect(finished.text).not.toContain(shared.id);
    expect((await call("list_tasks", { status: "cancelled" })).text).toBe(
      "None of your tasks is cancelled.",
    );
    expect((await call("list_tasks", { limit: 1 })).text).toContain(
      "(1 older not shown: pass a larger limit, up to 50.)",
    );
    expect((await call("list_tasks", { status: "done" })).isError).toBe(true);
  });

  it("refuse, per tool, a task the bot does not take part in", async () => {
    const engine = await engineOn();
    const { ada, other } = await threeTasks(engine);
    const { call, state } = toolsFor(engine, ada);
    const refusals: Record<string, CollabToolResult> = {
      get_task: await call("get_task", { id: other.id }),
      read_task_log: await call("read_task_log", { id: other.id }),
      read_entry: await call("read_task_log", {
        id: other.id,
        entry: "msg_x",
      }),
      send_to_task: await call("send_to_task", {
        id: other.id,
        text: "hello",
      }),
      stop_task: await call("stop_task", { id: other.id }),
      unknown: await call("get_task", { id: "task_missing" }),
    };
    for (const [name, result] of Object.entries(refusals)) {
      expect(result.isError, name).toBe(true);
      expect(result.text, name).toMatch(/^You take part in no task "/);
    }
    expect(state.linkedTaskId).toBeNull();
    // Nothing reached Bob's task.
    const view = await engine.engine.tasks.get(other.id);
    expect(view.task.status).toBe("waiting");
    expect(view.messages.some((m) => m.text === "hello")).toBe(false);
  });

  it("get_task shows the goal, sessions, outcome and latest log; read_task_log pages and opens entries", async () => {
    const engine = await engineOn();
    const { ada, own, shared } = await threeTasks(engine);
    const { call } = toolsFor(engine, ada);
    const detail = await call("get_task", { id: own.id });
    expect(detail.text).toContain(
      `Task ${own.id} "Write the report": completed`,
    );
    expect(detail.text).toContain("Goal (version 1):\nWrite the report");
    expect(detail.text).toContain(
      "Result: Wrote report.md with three sections.",
    );
    expect(detail.text).toContain("(coordinator): completed");
    expect(detail.text).toContain("You coordinate this task.");
    expect(detail.text).toContain("Latest task log entries:");
    expect(detail.text).toMatch(/msg_\S+ \[report\] /);
    expect((await call("get_task", { id: shared.id })).text).toContain(
      "You take part in this task; another bot coordinates it.",
    );

    const log = await call("read_task_log", { id: own.id });
    const entryId = /^(msg_\S+) \[report\]/m.exec(log.text)?.[1];
    expect(entryId).toBeDefined();
    const entry = await call("read_task_log", { id: own.id, entry: entryId });
    expect(entry.text).toContain("Wrote report.md with three sections.");
    const missing = await call("read_task_log", {
      id: own.id,
      entry: "msg_missing",
    });
    expect(missing).toMatchObject({ isError: true });
    expect(
      (await call("read_task_log", { id: own.id, kind: "brief" })).text,
    ).toBe("No entries match.");
  });

  it("send_to_task continues a completed task in the same session and workspace", async () => {
    const engine = await engineOn();
    const team = await createTeam(engine.engine, ["Ada"]);
    const [ada] = team.names as [string];
    const adaId = team.byName[ada] as string;
    engine.executor.brain(ada, (view) => {
      const relayed = said.heard(view, "relayed from the user's direct chat");
      const last = lastResult(view);
      if (!relayed) {
        if (said.turns(view) === 0)
          return {
            calls: [{ name: "bash", args: { command: "echo v1 > out.txt" } }],
          };
        return last?.name === "complete_task"
          ? { text: "Done." }
          : { calls: [{ name: "complete_task", args: { result: "v1" } }] };
      }
      // Run 1 left two results (bash, complete_task); run 2 reads the file back.
      const results = said.results(view).length;
      if (results === 2)
        return {
          calls: [{ name: "bash", args: { command: "cat out.txt" } }],
        };
      if (results > 3 || !last) return { text: "Done again." };
      return {
        calls: [
          {
            name: "complete_task",
            args: { result: `still there: ${last.text.trim()}` },
          },
        ],
      };
    });
    const { task } = await engine.engine.tasks.create({
      goal: "Write out.txt",
      coordinatorBotId: adaId,
    });
    const first = await untilTask(
      engine.engine,
      task.id,
      (v) => v.task.status === "completed",
    );
    const root = first.sessions.find((s) => s.parentSessionId === null);
    const { call, state } = toolsFor(engine, { id: adaId, name: ada });
    const sent = await call("send_to_task", {
      id: task.id,
      text: "Check out.txt is still there",
    });
    expect(sent).toEqual({
      text: `Sent to the task "Write out.txt"; it was completed and continues now.`,
    });
    expect(state.linkedTaskId).toBe(task.id);
    const done = await untilTask(
      engine.engine,
      task.id,
      (v) =>
        v.task.status === "completed" &&
        v.task.result?.startsWith("still") === true,
    );
    expect(done.task.result).toBe("still there: v1");
    // The same coordinator session ran again: same workspace, same transcript.
    expect(done.sessions).toHaveLength(1);
    expect(done.sessions[0]).toMatchObject({ id: root?.id, runCount: 2 });
    const events = await engine.engine.tasks.events(task.id);
    expect(
      events.events.filter((e) => e.type === "task.reopened"),
    ).toMatchObject([{ payload: { previous: "completed" } }]);
    // A reply that runs again relays nothing twice.
    expect(
      await call("send_to_task", { id: task.id, text: "Check again" }),
    ).toEqual({ text: `Sent to the task "Write out.txt".` });
    expect(
      (await engine.engine.tasks.get(task.id)).messages.filter(
        (m) => m.text === "Check out.txt is still there",
      ),
    ).toHaveLength(1);
  });

  it("send_to_task refuses a cancelled task", async () => {
    const engine = await engineOn();
    const team = await createTeam(engine.engine, ["Ada"]);
    const [ada] = team.names as [string];
    const adaId = team.byName[ada] as string;
    engine.executor.brain(ada, asks("Which colour?"));
    const { task } = await engine.engine.tasks.create({
      goal: "Paint",
      coordinatorBotId: adaId,
    });
    await untilTask(engine.engine, task.id, (v) => v.task.status === "waiting");
    await engine.engine.tasks.stop(task.id, {});
    await untilTask(
      engine.engine,
      task.id,
      (v) => v.task.status === "cancelled",
    );
    const { call } = toolsFor(engine, { id: adaId, name: ada });
    expect(await call("send_to_task", { id: task.id, text: "blue" })).toEqual({
      text: "The task was cancelled; start a new task to continue the work.",
      isError: true,
    });
  });

  it("stop_task is refused for a bot that only takes part, and stops the coordinator's task", async () => {
    const engine = await engineOn();
    const { ada, bob, shared, own } = await threeTasks(engine);
    const asAda = toolsFor(engine, ada);
    const refused = await asAda.call("stop_task", { id: shared.id });
    expect(refused).toMatchObject({ isError: true });
    expect(refused.text).toContain("Only a task's coordinator can stop it");
    expect((await engine.engine.tasks.get(shared.id)).task).toMatchObject({
      status: "waiting",
      cancelRequestedAt: null,
    });
    // A finished task has nothing to stop.
    expect(await asAda.call("stop_task", { id: own.id })).toEqual({
      text: "The task already completed; there is nothing to stop.",
      isError: true,
    });

    const asBob = toolsFor(engine, bob);
    const stopped = await asBob.call("stop_task", {
      id: shared.id,
      reason: "The user changed their mind",
    });
    expect(stopped).toEqual({ text: `Stopped the task "Paint the fence".` });
    expect(asBob.state.linkedTaskId).toBe(shared.id);
    const view = await engine.engine.tasks.get(shared.id);
    expect(view.task).toMatchObject({
      status: "cancelled",
      cancelReason: "The user changed their mind",
    });
    expect(await asBob.call("stop_task", { id: shared.id })).toEqual({
      text: `The task "Paint the fence" was already stopped.`,
    });
  });

  it("keep the tool definitions identical whatever tasks exist", async () => {
    const engine = await engineOn();
    const team = await createTeam(engine.engine, ["Ada", "Bob"]);
    const [ada, bob] = team.names as [string, string];
    const adaId = team.byName[ada] as string;
    engine.chat.brain(ada, () => ({ text: "ok" }));
    const definitions = (input: ChatReplyInput | undefined) =>
      JSON.stringify(
        input?.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters,
        })),
      );
    await engine.engine.bots.sendMessage(adaId, { text: "hello" });
    await untilReplies(engine, adaId, 1);
    const before = definitions(engine.chat.inputs.at(-1));
    expect(toolNames(engine.chat.inputs.at(-1) as ChatReplyInput)).toEqual([
      "create_task",
      "list_tasks",
      "get_task",
      "read_task_log",
      "send_to_task",
      "stop_task",
    ]);

    engine.executor
      .brain(ada, asks("Which colour?"))
      .brain(bob, asks("Which size?"));
    for (const coordinator of [adaId, team.byName[bob] as string]) {
      const { task } = await engine.engine.tasks.create({
        goal: "Something",
        coordinatorBotId: coordinator,
        participantBotIds: team.ids,
      });
      await untilTask(
        engine.engine,
        task.id,
        (v) => v.task.status === "waiting",
      );
    }
    await engine.engine.bots.sendMessage(adaId, { text: "hello again" });
    await until(
      () =>
        engine.chat.inputs.some((input) => lastInput(input) === "hello again"),
      { what: "the second reply" },
    );
    const after = engine.chat.inputs.find(
      (input) => lastInput(input) === "hello again",
    );
    expect(definitions(after)).toBe(before);
    // The prompt points to list_tasks with the count instead of listing tasks.
    expect(after?.systemPrompt).toContain(
      "You take part in 2 unfinished tasks, and you coordinate 1. `list_tasks` lists them",
    );
  });
});

/** A chat responder whose user replies (or update replies) wait for `let()` once held, recording the order of replies. */
class GatedChat extends FakeChatResponder {
  readonly order: string[] = [];
  private open: Promise<void> = Promise.resolve();
  private release: () => void = () => {};

  constructor(private readonly holds: "user" | "update" = "user") {
    super();
  }

  hold() {
    this.open = new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  let() {
    this.release();
  }

  override async reply(input: ChatReplyInput): Promise<ChatReply> {
    const name = isUpdate(input) ? "update" : lastInput(input);
    this.order.push(`start ${name}`);
    if (isUpdate(input) === (this.holds === "update"))
      await Promise.race([
        this.open,
        new Promise((resolve) =>
          input.signal.addEventListener("abort", resolve, { once: true }),
        ),
      ]);
    try {
      return await super.reply(input);
    } finally {
      this.order.push(`end ${name}`);
    }
  }
}

/** A reply that never returns; the worker's crash aborts it. */
const hangUntilAborted = (input: ChatReplyInput) =>
  new Promise<never>((_, reject) =>
    input.signal.addEventListener("abort", () => reject(input.signal.reason), {
      once: true,
    }),
  );

/** Answers updates in its own words and the user plainly. */
const politeBrain: ChatBrain = (input) =>
  isUpdate(input)
    ? { text: `In my words: ${lastInput(input).split("\n")[3] ?? ""}` }
    : { text: `You said: ${lastInput(input)}` };

describe("task updates in the coordinator's chat", () => {
  it("tell each completion, failure and wait for the user exactly once, with the task card and only read tools", async () => {
    const engine = await engineOn();
    const team = await createTeam(engine.engine, ["Ada", "Bob", "Cy"]);
    const [ada, bob, cy] = team.names as [string, string, string];
    engine.executor
      .brain(ada, completes("Report written."))
      .brain(bob, asks("Which colour should it be?"));
    // Cy has no brain: its run fails, and so does its task.
    for (const name of [ada, bob, cy]) engine.chat.brain(name, politeBrain);
    const cases = [
      { bot: ada, status: "completed", text: "Report written." },
      { bot: bob, status: "waiting", text: "Which colour should it be?" },
      { bot: cy, status: "failed", text: `${cy} failed: No brain for ${cy}.` },
    ] as const;
    for (const entry of cases) {
      const botId = team.byName[entry.bot] as string;
      const { task } = await engine.engine.tasks.create({
        goal: `A task for ${entry.bot}`,
        coordinatorBotId: botId,
      });
      await untilTask(
        engine.engine,
        task.id,
        (v) => v.task.status === entry.status,
      );
      const view = await untilReplies(engine, botId, 1);
      expect(view.messages).toMatchObject([
        {
          role: "assistant",
          text: `In my words: ${entry.text}`,
          taskId: task.id,
        },
      ]);
      expect(view.lastReplyError).toBeNull();
      const inputs = engine.chat.inputs.filter(
        (input) => isUpdate(input) && lastInput(input).includes(task.id),
      );
      expect(inputs).toHaveLength(1);
      const input = inputs[0] as ChatReplyInput;
      expect(toolNames(input)).toEqual(READ_TOOLS);
      expect(lastInput(input)).toContain(
        `Task: ${task.id} "A task for ${entry.bot}"`,
      );
      expect(lastInput(input)).toContain(`\n${entry.text}\n`);
      // The update is the reply's input, never a stored chat message.
      const stored = await db.database.db
        .select()
        .from(conversationMessages)
        .where(eq(conversationMessages.botId, botId));
      expect(stored.map((m) => m.role)).toEqual(["assistant"]);
      const updates = await updatesOf(task.id);
      expect(updates).toMatchObject([
        {
          botId,
          event: entry.status,
          text: entry.text,
          messageId: view.messages[0]?.id,
        },
      ]);
    }
  });

  it("count a task that continues and waits again as a new event", async () => {
    const engine = await engineOn();
    const team = await createTeam(engine.engine, ["Ada"]);
    const [ada] = team.names as [string];
    const adaId = team.byName[ada] as string;
    engine.executor.brain(ada, (view) =>
      said.heard(view, "blue")
        ? { text: "Which shade of blue?" }
        : { text: "Which colour?" },
    );
    engine.chat.brain(ada, politeBrain);
    const { task } = await engine.engine.tasks.create({
      goal: "Paint",
      coordinatorBotId: adaId,
    });
    await untilReplies(engine, adaId, 1);
    await engine.engine.tasks.postMessage(task.id, { text: "blue" });
    const view = await untilReplies(engine, adaId, 2);
    expect(view.messages.map((m) => [m.text, m.taskId])).toEqual([
      ["In my words: Which colour?", task.id],
      ["In my words: Which shade of blue?", task.id],
    ]);
    const updates = await updatesOf(task.id);
    expect(updates.map((u) => u.event)).toEqual(["waiting", "waiting"]);
    expect(updates[0]?.taskEventSeq).toBeLessThan(
      updates[1]?.taskEventSeq ?? 0,
    );
  });

  it("post the update plainly, with the task card, when the reply fails", async () => {
    const engine = await engineOn();
    const team = await createTeam(engine.engine, ["Ada"]);
    const [ada] = team.names as [string];
    const adaId = team.byName[ada] as string;
    engine.executor.brain(ada, completes("All done: see notes.md."));
    engine.chat.brain(ada, () => {
      throw Object.assign(new Error("provider overloaded"), {
        code: "rate_limit",
      });
    });
    const { task } = await engine.engine.tasks.create({
      goal: "Write notes",
      coordinatorBotId: adaId,
    });
    const view = await untilReplies(engine, adaId, 1);
    expect(view.messages).toMatchObject([
      {
        role: "assistant",
        taskId: task.id,
        text: 'Task "Write notes" completed.\n\nResult:\nAll done: see notes.md.\n\n(Posted automatically: the reply to this update failed.)',
      },
    ]);
    expect(view.lastReplyError?.message).toBe(
      "Reply failed (rate_limit): provider overloaded",
    );
    const updates = await updatesOf(task.id);
    expect(updates).toMatchObject([{ messageId: view.messages[0]?.id }]);
    // Nothing is retried: the update was told once.
    await sleep(200);
    expect((await conversation(engine, adaId)).messages).toHaveLength(1);
  });

  it("answer an update that arrives during a reply after it, with both in view", async () => {
    const chat = new GatedChat();
    const engine = await engineOn({ chat });
    const team = await createTeam(engine.engine, ["Ada"]);
    const [ada] = team.names as [string];
    const adaId = team.byName[ada] as string;
    chat.brain(ada, politeBrain);
    engine.executor.brain(ada, (view) =>
      said.turns(view) === 0
        ? { calls: [{ name: "gate", args: { name: "finish" } }] }
        : completes("Shipped.")(view),
    );
    const { task } = await engine.engine.tasks.create({
      goal: "Ship it",
      coordinatorBotId: adaId,
    });
    await engine.executor.gate("finish").reached;
    chat.hold();
    await engine.engine.bots.sendMessage(adaId, { text: "are you there?" });
    await until(() => chat.order.includes("start are you there?"), {
      what: "the user's reply to start",
    });
    // The task completes while the reply runs.
    engine.executor.gate("finish").open();
    await untilTask(
      engine.engine,
      task.id,
      (v) => v.task.status === "completed",
    );
    await until(async () => (await updatesOf(task.id)).length === 1, {
      what: "the update",
    });
    await sleep(300);
    expect(chat.order).toEqual(["start are you there?"]);
    expect((await conversation(engine, adaId)).replying).toBe(true);
    chat.let();
    const view = await untilReplies(engine, adaId, 2);
    expect(chat.order).toEqual([
      "start are you there?",
      "end are you there?",
      "start update",
      "end update",
    ]);
    expect(view.messages.map((m) => [m.role, m.text, m.taskId])).toEqual([
      ["user", "are you there?", null],
      ["assistant", "You said: are you there?", null],
      ["assistant", "In my words: Shipped.", task.id],
    ]);
    // The update reply saw the exchange before it.
    const update = chat.inputs.find(isUpdate) as ChatReplyInput;
    expect(update.history.slice(0, -1)).toEqual([
      { role: "user", text: "are you there?" },
      { role: "assistant", text: "You said: are you there?" },
    ]);
  });

  it("answer a user message that arrives during an update reply after it, with the update in view", async () => {
    const chat = new GatedChat("update");
    const engine = await engineOn({ chat });
    const team = await createTeam(engine.engine, ["Ada"]);
    const [ada] = team.names as [string];
    const adaId = team.byName[ada] as string;
    chat.brain(ada, politeBrain);
    engine.executor.brain(ada, completes("Shipped."));
    chat.hold();
    const { task } = await engine.engine.tasks.create({
      goal: "Ship it",
      coordinatorBotId: adaId,
    });
    await until(() => chat.order.includes("start update"), {
      what: "the update reply to start",
    });
    await engine.engine.bots.sendMessage(adaId, { text: "and next?" });
    await sleep(300);
    expect(chat.order).toEqual(["start update"]);
    chat.let();
    const view = await untilReplies(engine, adaId, 2);
    expect(chat.order).toEqual([
      "start update",
      "end update",
      "start and next?",
      "end and next?",
    ]);
    // The update's reply was stored after the user's message; it is still answered.
    expect(view.messages.map((m) => [m.role, m.text, m.taskId])).toEqual([
      ["user", "and next?", null],
      ["assistant", "In my words: Shipped.", task.id],
      ["assistant", "You said: and next?", null],
    ]);
    const answer = chat.inputs.find(
      (input) => lastInput(input) === "and next?",
    ) as ChatReplyInput;
    expect(answer.history).toEqual([
      { role: "assistant", text: "In my words: Shipped." },
      { role: "user", text: "and next?" },
    ]);
  });

  it("do not answer a user message again after its reply failed", async () => {
    const engine = await engineOn();
    const team = await createTeam(engine.engine, ["Ada"]);
    const [ada] = team.names as [string];
    const adaId = team.byName[ada] as string;
    engine.chat.brain(ada, (input) => {
      if (isUpdate(input)) return politeBrain(input);
      throw new Error("provider overloaded");
    });
    await engine.engine.bots.sendMessage(adaId, { text: "hello?" });
    await until(
      async () => (await conversation(engine, adaId)).lastReplyError,
      { what: "the failed reply" },
    );
    engine.executor.brain(ada, completes("Shipped."));
    const { task } = await engine.engine.tasks.create({
      goal: "Ship it",
      coordinatorBotId: adaId,
    });
    const view = await untilReplies(engine, adaId, 1);
    expect(view.messages.map((m) => [m.role, m.taskId])).toEqual([
      ["user", null],
      ["assistant", task.id],
    ]);
    expect(
      engine.chat.inputs.filter((input) => lastInput(input) === "hello?"),
    ).toHaveLength(1);
    expect(view.lastReplyError).toBeNull();
  });

  it("post no duplicate when the worker crashes before the reply is written", async () => {
    const chat = new GatedChat();
    const first = await engineOn({ chat, config: { leaseMs: 1_000 } });
    const team = await createTeam(first.engine, ["Ada"]);
    const [ada] = team.names as [string];
    const adaId = team.byName[ada] as string;
    first.executor.brain(ada, asks("Which colour?"));
    // The first worker's update reply never returns: it crashes during it.
    chat.brain(ada, () => ({ text: "never stored" }));
    chat.reply = async (input) => {
      chat.inputs.push(input);
      return hangUntilAborted(input);
    };
    const { task } = await first.engine.tasks.create({
      goal: "Paint",
      coordinatorBotId: adaId,
    });
    await until(() => chat.inputs.some(isUpdate), { what: "the update reply" });
    await first.engine.worker.abandon();

    const chat2 = new FakeChatResponder().brain(ada, politeBrain);
    const second = await engineOn({ chat: chat2, config: { leaseMs: 1_000 } });
    second.executor.brain(ada, asks("Which colour?"));
    const view = await untilReplies(second, adaId, 1);
    await sleep(300);
    const messages = (await conversation(second, adaId)).messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      text: "In my words: Which colour?",
      taskId: task.id,
    });
    expect(view.messages[0]?.id).toBe(messages[0]?.id);
    expect(await updatesOf(task.id)).toMatchObject([
      { messageId: messages[0]?.id },
    ]);
    // The reclaimed job answered it on its second attempt.
    const replies = await db.database.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.botId, adaId), eq(jobs.kind, "chat.reply")));
    expect(replies.map((job) => [job.status, job.attempts])).toEqual([
      ["done", 2],
    ]);
  });

  it("post the fallback, without a model call, for an update whose replies kept dying", async () => {
    const chat = new GatedChat();
    const first = await engineOn({ chat, config: { leaseMs: 1_000 } });
    const team = await createTeam(first.engine, ["Ada"]);
    const [ada] = team.names as [string];
    const adaId = team.byName[ada] as string;
    first.executor.brain(ada, completes("Done and dusted."));
    chat.reply = async (input) => {
      chat.inputs.push(input);
      return hangUntilAborted(input);
    };
    const { task } = await first.engine.tasks.create({
      goal: "Dust",
      coordinatorBotId: adaId,
    });
    await until(() => chat.inputs.some(isUpdate), { what: "the update reply" });
    await first.engine.worker.abandon();
    // Its last allowed attempt expired: the next claim gives it up.
    await db.database.db
      .update(jobs)
      .set({
        attempts: sql`${jobs.maxAttempts}`,
        leaseUntil: sql`now() - interval '1 second'`,
      })
      .where(and(eq(jobs.botId, adaId), eq(jobs.status, "running")));

    const chat2 = new FakeChatResponder().brain(ada, politeBrain);
    const second = await engineOn({ chat: chat2 });
    const view = await untilReplies(second, adaId, 1);
    expect(chat2.inputs).toEqual([]);
    expect(view.messages).toMatchObject([
      {
        taskId: task.id,
        text: 'Task "Dust" completed.\n\nResult:\nDone and dusted.\n\n(Posted automatically: the reply to this update failed.)',
      },
    ]);
    expect(await updatesOf(task.id)).toMatchObject([
      { messageId: view.messages[0]?.id },
    ]);
  });
});

describe("direct chat on the scripted model", () => {
  it("creates a task, tells its result, answers how it went and continues the same task", async () => {
    const engine = await engineOn({
      chatResponder: new PiChatResponder({
        models: new ModelRegistry({ env: {}, enableScripted: true }),
      }),
    });
    const team = await createTeam(engine.engine, ["Ada"]);
    const [ada] = team.names as [string];
    const adaId = team.byName[ada] as string;
    engine.executor.brain(ada, (view) => {
      const followedUp = said.heard(view, "diet");
      const completions = said
        .results(view)
        .filter((result) => result.name === "complete_task").length;
      if (completions >= (followedUp ? 2 : 1)) return { text: "Done." };
      const result = followedUp
        ? "Added a diet section."
        : "Wrote penguins.md with three sections.";
      return { calls: [{ name: "complete_task", args: { result } }] };
    });
    const say = async (text: string, replies: number) => {
      await engine.engine.bots.sendMessage(adaId, { text });
      return untilReplies(engine, adaId, replies);
    };
    const title = '"Please write a penguin report."';

    // The reply that creates the task, then the update once it completes.
    let view = await say("Please write a penguin report.", 2);
    const created = view.messages[1];
    const taskId = created?.taskId as string;
    expect(created?.text).toMatch(
      /^I've started a task for that\. Created task/,
    );
    expect(view.messages[2]).toMatchObject({
      text: `Update on ${title}: it completed. Wrote penguins.md with three sections.`,
      taskId,
    });

    view = await say("How did it go?", 3);
    expect(view.messages[4]).toMatchObject({
      text: `${title} is completed. Result: Wrote penguins.md with three sections.`,
      taskId: null,
    });

    view = await say("Please also add a diet section to the task.", 5);
    expect(view.messages[6]).toMatchObject({
      text: `I've passed that on to the task. Sent to the task ${title}; it was completed and continues now.`,
      taskId,
    });
    expect(view.messages[7]).toMatchObject({
      text: `Update on ${title}: it completed. Added a diet section.`,
      taskId,
    });
    const done = await engine.engine.tasks.get(taskId);
    expect(done.task.result).toBe("Added a diet section.");
    expect(done.sessions).toHaveLength(1);
    const linked = new Set(
      view.messages.flatMap((message) =>
        message.taskId ? [message.taskId] : [],
      ),
    );
    expect(linked).toEqual(new Set([taskId]));
  });
});
