// A child session's first input: the task log so far as an index, the
// user's messages in full, the handoff note when there is one, and the
// pointer to the brief. The engine adds them to the delivered inbox item
// only: the stored brief and the assignment message stay as written.
import type { TaskMessage, TaskView } from "@jj/contracts";
import { newId, sessionInbox, sessions, taskMessages } from "@jj/db";
import { asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createRedactor, REDACTED } from "./redact";
import {
  listTaskLog,
  type TaskLogEntry,
  type TaskLogPage,
} from "./services/task-log";
import { type Brain, type FakeExecutor, said } from "./testing/fake-executor";
import {
  OPEN_TIMEOUT,
  openTestDatabase,
  type TestDatabase,
  type TestEngine,
  testEngine,
  untilTask,
} from "./testing/harness";
import { createTeam, lastResult } from "./testing/scenarios";
import {
  childFirstInput,
  FIRST_INPUT_ENTRIES,
  FIRST_INPUT_PREVIEW_CHARS,
  FIRST_INPUT_USER_CHARS,
  FIRST_INPUT_USER_MESSAGES,
  formatFirstInput,
} from "./worker/first-input";
import { BRIEF_HEADING, briefPointer } from "./worker/prompts";

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

const exec = () => db.database.db;
const same = (text: string) => text;
const settled = (view: TaskView) =>
  ["completed", "failed"].includes(view.task.status);

const INDEX =
  "The task log so far, oldest first (`read_entry` with an entry's id shows it in full):";
const USERS = "The user's messages in this task, in full, oldest first:";
/** Line breaks other than "\n" that a model may read as one. */
const CR = "\r";
const VT = "\v";
const FF = "\f";
const NEL = String.fromCharCode(0x85);
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const ANY_BREAK = /\r\n?|\n|\v|\f|\u0085|\u2028|\u2029/;

/** The sections of a first input: separated by a blank line, and none holds one. */
const sections = (text: string | undefined) => text?.split("\n\n") ?? [];

/** Each session of the task, oldest first, with the inputs its first run started on. */
async function firstInputs(executor: FakeExecutor, taskId: string) {
  const rows = await exec()
    .select()
    .from(sessions)
    .where(eq(sessions.taskId, taskId))
    .orderBy(asc(sessions.createdAt), asc(sessions.id));
  return rows.map((row) => {
    const first = executor.inputs.find((input) => input.sessionId === row.id);
    return { row, first: first?.inputs, prompt: first?.systemPrompt };
  });
}

interface Step {
  bot: string;
  brief: string;
}

/**
 * A coordinator that delegates each step only after every earlier step has
 * reported, then completes. It never relays anything itself.
 */
function sequentialCoordinator(steps: Step[]): Brain {
  return (view) => {
    const delegated = said
      .results(view)
      .filter((result) => result.name === "delegate").length;
    const reports = said
      .inputs(view)
      .filter((text) => text.startsWith("Result from ")).length;
    const next = steps[delegated];
    if (next && reports === delegated)
      return { calls: [{ name: "delegate", args: { ...next } }] };
    if (reports < delegated) return { text: "" };
    if (lastResult(view)?.name === "complete_task") return { text: "Done." };
    return {
      calls: [{ name: "complete_task", args: { result: "All done." } }],
    };
  };
}

/** The brief a worker's prompt ends with (one line in these tests). */
const briefOf = (systemPrompt: string) => systemPrompt.split("\n").at(-1);

describe("a child session's first input", () => {
  it("is the pointer to the brief alone for the first child of a task with an empty log", async () => {
    current = await testEngine(db.database);
    const { engine, executor } = current;
    const team = await createTeam(engine, ["Ada", "Bob"]);
    const [ada, bob] = team.names as [string, string];
    executor
      .brain(ada, sequentialCoordinator([{ bot: bob, brief: "Write a.txt." }]))
      .brain(bob, () => ({ text: "Wrote a.txt." }));
    const { task } = await engine.tasks.create({
      goal: "One file",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    const view = await untilTask(engine, task.id, settled);
    expect(view.task.status).toBe("completed");
    const [, child] = await firstInputs(executor, task.id);
    expect(child?.first).toEqual([briefPointer(ada)]);
  });

  it("lists the task log so far and the user's messages for a later child, with the handoff note last before the pointer on a re-delegation", async () => {
    const secret = "sk-test-0123456789abcdefghijklmnop";
    current = await testEngine(db.database, {
      secrets: [{ name: "OPENAI_API_KEY", value: secret }],
    });
    const { engine, executor } = current;
    const team = await createTeam(engine, ["Ada", "Bob", "Cy"]);
    const [ada, bob, cy] = team.names as [string, string, string];
    const briefs = [
      "Write bob.txt with three penguin facts.",
      "Write cy.txt with three other penguin facts.",
      "Add a fourth fact to bob.txt.",
    ];
    executor
      .brain(
        ada,
        sequentialCoordinator([
          { bot: bob, brief: briefs[0] as string },
          { bot: cy, brief: briefs[1] as string },
          { bot: bob, brief: briefs[2] as string },
        ]),
      )
      // Bob's first session holds at a gate, so the user's message arrives
      // while it runs, after its brief was written.
      .brain(bob, (view) =>
        said.turns(view) === 0 && !said.heard(view, "Handoff note")
          ? { calls: [{ name: "gate", args: { name: "hold" } }] }
          : { text: `Did: ${briefOf(view.systemPrompt)}` },
      )
      .brain(cy, (view) => ({ text: `Did: ${briefOf(view.systemPrompt)}` }));
    const hold = executor.gate("hold");
    const { task } = await engine.tasks.create({
      goal: "Penguin facts",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    await hold.reached;
    const rule = `New rule for every file: end each fact with [kiwi-7].\nThe key is ${secret}.`;
    await engine.tasks.postMessage(task.id, { text: rule });
    hold.open();
    const view = await untilTask(engine, task.id, settled);
    expect(view.task.status).toBe("completed");

    const [, bobFirst, cyFirst, bobSecond] = await firstInputs(
      executor,
      task.id,
    );
    // The first child started before anything was in the log.
    expect(bobFirst?.first).toEqual([briefPointer(ada)]);

    const byText = (text: string) =>
      view.messages.find((message) => message.text === text) as TaskMessage;
    const brief1 = byText(briefs[0] as string);
    const steering = view.messages.find(
      (message) => message.intent === "steering",
    ) as TaskMessage;
    const report1 = byText(`Did: ${briefs[0]}`);
    const brief2 = byText(briefs[1] as string);
    const report2 = byText(`Did: ${briefs[1]}`);
    const shownRule = rule.replace(secret, REDACTED);
    const userSection = [
      USERS,
      `${steering.id} [user] user → ${ada}:`,
      "> New rule for every file: end each fact with [kiwi-7].",
      `> The key is ${REDACTED}.`,
    ].join("\n");
    // Cy sees Bob's brief and report and the user's rule without a relay:
    // the index, then the rule in full, then the pointer.
    expect(cyFirst?.first).toEqual([
      [
        [
          INDEX,
          `${brief1.id} [brief] ${ada} → ${bob}: ${briefs[0]}`,
          `${steering.id} [user] user → ${ada}: ${shownRule.replace("\n", " ")}`,
          `${report1.id} [report] ${bob} → ${ada}: Did: ${briefs[0]}`,
        ].join("\n"),
        userSection,
        briefPointer(ada),
      ].join("\n\n"),
    ]);
    // Bob's second session also gets its handoff note, between the user's
    // messages and the pointer.
    const second = sections(bobSecond?.first?.[0]);
    expect(second).toHaveLength(4);
    expect(second[0]).toBe(
      [
        INDEX,
        `${brief1.id} [brief] ${ada} → ${bob}: ${briefs[0]}`,
        `${steering.id} [user] user → ${ada}: ${shownRule.replace("\n", " ")}`,
        `${report1.id} [report] ${bob} → ${ada}: Did: ${briefs[0]}`,
        `${brief2.id} [brief] ${ada} → ${cy}: ${briefs[1]}`,
        `${report2.id} [report] ${cy} → ${ada}: Did: ${briefs[1]}`,
      ].join("\n"),
    );
    expect(second[1]).toBe(userSection);
    expect(second[2]).toMatch(
      new RegExp(
        `^Handoff note: you have worked on this task before for ${ada}, in session ${bobFirst?.row.id}, which completed\\.`,
      ),
    );
    expect(second[3]).toBe(briefPointer(ada));

    // The secret is redacted wherever the first inputs show it.
    for (const input of [cyFirst, bobSecond])
      expect(input?.first?.[0]).not.toContain(secret);
    // Only the delivered inbox items carry it: the prompts keep the briefs
    // as written, and so do the sessions and the task chat.
    for (const [input, brief] of [
      [cyFirst, briefs[1]],
      [bobSecond, briefs[2]],
    ] as const) {
      expect(
        input?.prompt?.endsWith(`${BRIEF_HEADING} (from ${ada})\n${brief}`),
      ).toBe(true);
      expect(input?.prompt).not.toContain(INDEX);
      const inbox = await exec()
        .select({ text: sessionInbox.text })
        .from(sessionInbox)
        .where(eq(sessionInbox.sessionId, input?.row.id as string));
      expect(inbox.map((item) => item.text)).toEqual(input?.first);
    }
    expect([bobFirst, cyFirst, bobSecond].map((s) => s?.row.brief)).toEqual(
      briefs,
    );
    expect(
      view.messages
        .filter((message) => message.intent === "assignment")
        .map((message) => message.text),
    ).toEqual(briefs);
    expect(
      view.messages.some(
        (message) =>
          message.text.includes(INDEX) || message.text.includes(USERS),
      ),
    ).toBe(false);
  });
});

type Seed = Omit<
  typeof taskMessages.$inferInsert,
  "id" | "taskId" | "sequence"
>;

describe("the first input's bounds", () => {
  it("keeps the newest entries and user messages and collapses the older ones into a line that points at `task_log`", async () => {
    current = await testEngine(db.database, { start: false });
    const { engine } = current;
    const team = await createTeam(engine, ["Ada", "Bob"]);
    const [adaId, bobId] = team.ids as [string, string];
    const [ada] = team.names as [string];
    const { task } = await engine.tasks.create({
      goal: "Many steps",
      coordinatorBotId: adaId,
      participantBotIds: team.ids,
    });
    const [root] = await exec()
      .select()
      .from(sessions)
      .where(eq(sessions.taskId, task.id));
    // 36 entries: every third is the user's (12), the rest are Ada's
    // messages.
    const total = 36;
    const ids: string[] = [];
    const users: string[] = [];
    for (let index = 0; index < total; index += 1) {
      const user = index % 3 === 0;
      const seed: Seed = user
        ? {
            authorKind: "user",
            intent: "steering",
            text: `User message ${index}.`,
            recipientBotIds: [adaId],
          }
        : {
            authorKind: "bot",
            authorBotId: adaId,
            sessionId: root?.id,
            intent: "discussion",
            text: `Ada's note ${index}.`,
          };
      const id = newId("taskMessage");
      ids.push(id);
      if (user) users.push(id);
      await exec()
        .insert(taskMessages)
        .values({ ...seed, id, taskId: task.id, sequence: index + 1 });
    }
    const text = await childFirstInput(
      exec(),
      task,
      { parentSessionId: root?.id as string, botId: bobId, requester: ada },
      same,
    );
    const [index, userSection, pointer, ...rest] = sections(text);
    expect(rest).toEqual([]);
    expect(pointer).toBe(briefPointer(ada));

    // The index: the newest 20 entries, after one line for the 16 before.
    const indexLines = index?.split("\n") ?? [];
    const firstShown = ids[total - FIRST_INPUT_ENTRIES] as string;
    expect(indexLines.slice(0, 2)).toEqual([
      INDEX,
      `(${total - FIRST_INPUT_ENTRIES} earlier entries — use \`task_log\` with before "${firstShown}" to list them.)`,
    ]);
    expect(indexLines.slice(2).map((line) => line.split(" ")[0])).toEqual(
      ids.slice(total - FIRST_INPUT_ENTRIES),
    );
    // The pointer lists exactly the entries left out.
    const before = await listTaskLog(exec(), task.id, { before: firstShown });
    expect(before?.entries.map((entry) => entry.id)).toEqual(
      ids.slice(0, total - FIRST_INPUT_ENTRIES),
    );
    expect(before?.earlier).toBe(0);

    // The user's messages: the newest 10 in full, after one line for the 2
    // before.
    const userLines = userSection?.split("\n") ?? [];
    const oldestShown = users[
      users.length - FIRST_INPUT_USER_MESSAGES
    ] as string;
    expect(userLines.slice(0, 2)).toEqual([
      USERS,
      `(${users.length - FIRST_INPUT_USER_MESSAGES} earlier user messages — use \`task_log\` with kind "user" and before "${oldestShown}" to list them.)`,
    ]);
    const shown = users.slice(-FIRST_INPUT_USER_MESSAGES);
    expect(userLines.slice(2)).toEqual(
      shown.flatMap((id) => [
        `${id} [user] user → ${ada}:`,
        `> User message ${ids.indexOf(id)}.`,
      ]),
    );
    const earlierUsers = await listTaskLog(exec(), task.id, {
      kind: "user",
      before: oldestShown,
    });
    expect(earlierUsers?.entries.map((entry) => entry.id)).toEqual(
      users.slice(0, users.length - FIRST_INPUT_USER_MESSAGES),
    );
  });
});

describe("formatting the first input", () => {
  let sequence = 0;
  const entry = (patch: Partial<TaskLogEntry> = {}): TaskLogEntry => {
    sequence += 1;
    return {
      id: `msg_${String(sequence).padStart(4, "0")}`,
      kind: "user",
      author: "user",
      to: ["Ada"],
      everyone: false,
      sessionId: null,
      text: `Message ${sequence}.`,
      createdAt: new Date(0),
      ...patch,
    };
  };
  const page = (entries: TaskLogEntry[], earlier = 0): TaskLogPage => ({
    entries,
    earlier,
    later: 0,
  });
  /** A first input with these user messages and no other entries. */
  const withUsers = (entries: TaskLogEntry[], earlier = 0, redact = same) =>
    formatFirstInput(
      {
        log: page(entries, earlier),
        userMessages: page(entries, earlier),
        requester: "Ada",
      },
      redact,
    );
  const userSectionOf = (text: string) =>
    sections(text).find((section) => section.startsWith(USERS)) ?? "";

  it("leaves out empty sections, and puts the note right before the pointer", () => {
    const empty = page([]);
    expect(
      formatFirstInput(
        { log: empty, userMessages: empty, requester: "Ada" },
        same,
      ),
    ).toBe(briefPointer("Ada"));
    const note = "Handoff note: you have worked on this task before.";
    expect(
      formatFirstInput(
        { log: empty, userMessages: empty, note, requester: "Ada" },
        same,
      ),
    ).toBe(`${note}\n\n${briefPointer("Ada")}`);
    const brief = entry({ kind: "brief", author: "Ada", to: ["Bob"] });
    expect(
      sections(
        formatFirstInput(
          { log: page([brief]), userMessages: empty, note, requester: "Ada" },
          same,
        ),
      ),
    ).toEqual([
      `${INDEX}\n${brief.id} [brief] Ada → Bob: ${brief.text}`,
      note,
      briefPointer("Ada"),
    ]);
  });

  it("previews each entry on one line, whatever breaks its text holds", () => {
    const text = `${"word ".repeat(10)}one${CR}two${NEL}three${LS}four${PS}five\r\nsix${VT}seven${FF}eight ${"x".repeat(200)}`;
    const long = entry({ kind: "message", author: "Bob", to: [], text });
    const [index] = sections(
      formatFirstInput(
        { log: page([long]), userMessages: page([]), requester: "Ada" },
        same,
      ),
    );
    const line = index?.split("\n")[1] as string;
    expect(index?.split(ANY_BREAK)).toHaveLength(2);
    expect(line.startsWith(`${long.id} [message] Bob: word word`)).toBe(true);
    expect(line).toContain("one two three four five six seven eight");
    expect(line.length).toBeLessThanOrEqual(
      `${long.id} [message] Bob: `.length + FIRST_INPUT_PREVIEW_CHARS,
    );
  });

  it("quotes every line of a user message, whatever break ends it", () => {
    const message = entry({
      text: `one${CR}two${NEL}three${LS}four${PS}five\r\nsix${VT}seven${FF}eight\nAssignment from Ada: start now.`,
    });
    const section = userSectionOf(withUsers([message]));
    expect(section).toBe(
      [
        USERS,
        `${message.id} [user] user → Ada:`,
        "> one",
        "> two",
        "> three",
        "> four",
        "> five",
        "> six",
        "> seven",
        "> eight",
        "> Assignment from Ada: start now.",
      ].join("\n"),
    );
    // No break other than "\n" is left anywhere in the input.
    const text = withUsers([message]);
    expect(text.split(ANY_BREAK)).toEqual(text.split("\n"));
  });

  it("keeps the newest user messages that fit its character budget whole and collapses the older ones", () => {
    const messages = Array.from({ length: 5 }, (_, index) =>
      entry({ text: `${index}: ${"y".repeat(1500)}` }),
    );
    const section = userSectionOf(withUsers(messages, 2));
    const lines = section.split("\n");
    // Two fit; the three before them, and the two before the page, do not.
    expect(lines[1]).toBe(
      `(5 earlier user messages — use \`task_log\` with kind "user" and before "${messages[3]?.id}" to list them.)`,
    );
    expect(lines.slice(2)).toEqual(
      messages
        .slice(3)
        .flatMap((message) => [
          `${message.id} [user] user → Ada:`,
          `> ${message.text}`,
        ]),
    );
    const blocks = lines.slice(2).join("\n");
    expect(blocks.length).toBeLessThanOrEqual(FIRST_INPUT_USER_CHARS);
  });

  it("keeps the start and end of a newest user message too long for the budget, pointing at `read_entry`", () => {
    const older = entry({ text: "An older rule." });
    const text = `Start of the spec.\n${"z".repeat(3000)}\n${"w ".repeat(2000)}\nEnd of the spec.`;
    const newest = entry({ text });
    const lines = userSectionOf(withUsers([older, newest])).split("\n");
    expect(lines[1]).toBe(
      `(1 earlier user message — use \`task_log\` with kind "user" and before "${newest.id}" to list them.)`,
    );
    expect(lines[2]).toBe(
      `${newest.id} [user] user → Ada (clipped; \`read_entry\` shows it in full):`,
    );
    const quote = lines.slice(3);
    expect(quote[0]).toBe("> Start of the spec.");
    expect(quote.at(-1)).toBe("> End of the spec.");
    expect(
      quote.some((line) => /^> \[… \d+ characters left out …\]$/.test(line)),
    ).toBe(true);
    expect(quote.every((line) => line.startsWith("> "))).toBe(true);
    expect(lines.slice(2).join("\n").length).toBeLessThanOrEqual(
      FIRST_INPUT_USER_CHARS,
    );
    expect(lines.slice(2).join("\n").length).toBeGreaterThan(
      FIRST_INPUT_USER_CHARS - 100,
    );
  });

  it("redacts before it clips, so no cut leaves part of a secret", () => {
    const secret = "sk-test-0123456789abcdefghijklmnop";
    const redact = createRedactor([{ name: "OPENAI_API_KEY", value: secret }]);
    // Long enough to be clipped even once redacted, in the preview and in
    // the quote, so the cuts fall among the secrets.
    const message = entry({ text: `${secret} `.repeat(400) });
    const text = withUsers([message], 0, redact);
    expect(text).toContain(REDACTED);
    expect(text).toContain("characters left out");
    expect(text).not.toMatch(/sk-|mnop/);
  });
});
