// The task's shared record as bots read it: the task log service (kinds,
// order, filters, search, paging, entries, state and reports, all scoped to
// one task) and the read-only lookup tools every task session has.
import type { TaskView } from "@jj/contracts";
import { newId, sessionEntries, sessions, taskMessages } from "@jj/db";
import { ModelRegistry, PiSessionExecutor } from "@jj/runtime";
import { callTool, fauxProvider, say, textOf } from "@jj/runtime/testing";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { CollabTool } from "./ports";
import { REDACTED } from "./redact";
import {
  formatSessionReport,
  formatTaskLogPage,
  formatTaskState,
  indexLine,
  listTaskLog,
  readBotReports,
  readSessionReport,
  readTaskLogEntry,
  readTaskState,
  TASK_LOG_KINDS,
  type TaskLogEntry,
} from "./services/task-log";
import { type Brain, promptBot, said } from "./testing/fake-executor";
import {
  OPEN_TIMEOUT,
  openTestDatabase,
  quietLogger,
  type TestDatabase,
  type TestEngine,
  testEngine,
  untilTask,
} from "./testing/harness";
import { createTeam, lastResult, type Team } from "./testing/scenarios";
import { LOOKUP_TOOLS, lookupTools } from "./worker/lookup-tools";
import type { RunContext } from "./worker/run-context";

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

const exec = () => db.database.db;
/** No secrets configured: the formatters' redactor changes nothing. */
const same = (text: string) => text;

type Seed = Omit<
  typeof taskMessages.$inferInsert,
  "id" | "taskId" | "sequence"
>;

/**
 * A task with a coordinator session (from creation), worker sessions for Bob
 * and Cy, and one stored message of every shape the engine posts. Nothing
 * runs: the worker is not started.
 */
async function seededTask(engine: TestEngine["engine"], team: Team) {
  const [ada, bob, cy] = team.ids as [string, string, string];
  const { task } = await engine.tasks.create({
    goal: "Paint the fence\nIn red.",
    title: "Fence",
    coordinatorBotId: ada,
    participantBotIds: team.ids,
  });
  const [root] = await exec()
    .select()
    .from(sessions)
    .where(eq(sessions.taskId, task.id));
  const start = Date.now();
  const worker = async (botId: string, brief: string, offset: number) => {
    const [row] = await exec()
      .insert(sessions)
      .values({
        id: newId("session"),
        taskId: task.id,
        botId,
        parentSessionId: root?.id,
        role: "worker",
        brief,
        goalVersion: 1,
        depth: 1,
        status: "completed",
        createdAt: new Date(start + offset),
      })
      .returning();
    return row as typeof sessions.$inferSelect;
  };
  const bobSession = await worker(
    bob,
    "Write bob.txt in red.\nUse the zoo palette.",
    1000,
  );
  await exec()
    .update(sessions)
    .set({ result: "Bob wrote bob.txt in red." })
    .where(eq(sessions.id, bobSession.id));
  const cySession = await worker(cy, "Write cy.txt.", 2000);
  await exec()
    .update(sessions)
    .set({ status: "failed", error: "boom" })
    .where(eq(sessions.id, cySession.id));
  const seeds: Seed[] = [
    {
      authorKind: "user",
      intent: "steering",
      text: "Use the red palette; 100%_opaque.",
      recipientBotIds: [ada],
    },
    {
      authorKind: "bot",
      authorBotId: ada,
      sessionId: root?.id,
      intent: "assignment",
      text: "Write bob.txt in red.\nUse the zoo palette.",
      recipientBotIds: [bob],
    },
    {
      authorKind: "bot",
      authorBotId: bob,
      sessionId: bobSession.id,
      intent: "discussion",
      text: "Cy: I use red, not blue.",
      recipientBotIds: [cy],
    },
    {
      authorKind: "bot",
      authorBotId: bob,
      sessionId: bobSession.id,
      intent: "result",
      text: "Bob wrote bob.txt in red.",
      recipientBotIds: [ada],
    },
    {
      authorKind: "system",
      sessionId: cySession.id,
      intent: "result",
      text: `${team.names[2]} failed: boom`,
      recipientBotIds: [ada],
    },
    {
      authorKind: "bot",
      authorBotId: ada,
      intent: "discussion",
      text: "Also add a footer.",
      recipientBotIds: [ada],
      relayedFromMessageId: "cmsg_relayed",
    },
    {
      authorKind: "bot",
      authorBotId: ada,
      sessionId: root?.id,
      intent: "discussion",
      text: "Which shade of red?",
    },
    {
      authorKind: "system",
      sessionId: root?.id,
      intent: "discussion",
      text: `${team.names[0]} failed: out of budget`,
    },
  ];
  const ids: string[] = [];
  for (const [index, seed] of seeds.entries()) {
    const id = newId("taskMessage");
    ids.push(id);
    await exec()
      .insert(taskMessages)
      .values({ ...seed, id, taskId: task.id, sequence: index + 1 });
  }
  return {
    task,
    root: root as typeof sessions.$inferSelect,
    bobSession,
    cySession,
    ids,
  };
}

describe("task log service", () => {
  it("lists every entry oldest first, with its message id, kind, author and recipients", async () => {
    const { engine } = await setup({ start: false });
    const team = await createTeam(engine, ["Ada", "Bob", "Cy"]);
    const [ada, bob, cy] = team.names as [string, string, string];
    const seeded = await seededTask(engine, team);
    const page = await listTaskLog(exec(), seeded.task.id);
    expect(page).toMatchObject({ earlier: 0, later: 0 });
    expect(
      page?.entries.map((entry) => [
        entry.id,
        entry.kind,
        entry.author,
        entry.to,
      ]),
    ).toEqual([
      [seeded.ids[0], "user", "user", [ada]],
      [seeded.ids[1], "brief", ada, [bob]],
      [seeded.ids[2], "message", bob, [cy]],
      [seeded.ids[3], "report", bob, [ada]],
      // A failure is the failed session's report.
      [seeded.ids[4], "report", "system", [ada]],
      // A message relayed from the user's direct chat is the user's.
      [seeded.ids[5], "user", `user via ${ada}`, [ada]],
      [seeded.ids[6], "message", ada, []],
      [seeded.ids[7], "report", "system", []],
    ]);
    // Each kind filter returns exactly the entries of that kind.
    for (const kind of TASK_LOG_KINDS) {
      const filtered = await listTaskLog(exec(), seeded.task.id, { kind });
      expect(filtered?.entries.map((entry) => entry.id)).toEqual(
        page?.entries
          .filter((entry) => entry.kind === kind)
          .map((entry) => entry.id),
      );
    }
  });

  it("searches text ignoring case, with % and _ taken literally", async () => {
    const { engine } = await setup({ start: false });
    const team = await createTeam(engine, ["Ada", "Bob", "Cy"]);
    const seeded = await seededTask(engine, team);
    const search = async (query: string) =>
      (await listTaskLog(exec(), seeded.task.id, { query }))?.entries.map(
        (entry) => entry.id,
      );
    expect(await search("RED PALETTE")).toEqual([seeded.ids[0]]);
    expect(await search("%_opaque")).toEqual([seeded.ids[0]]);
    // Unescaped, `_` would match the "0" in "100".
    expect(await search("1_0")).toEqual([]);
    expect(await search("in red")).toEqual([seeded.ids[1], seeded.ids[3]]);
    expect(
      (
        await listTaskLog(exec(), seeded.task.id, {
          kind: "report",
          query: "red",
        })
      )?.entries.map((entry) => entry.id),
    ).toEqual([seeded.ids[3]]);
  });

  it("pages forward with after and limit, and refuses an after that is not this task's", async () => {
    const { engine } = await setup({ start: false });
    const team = await createTeam(engine, ["Ada", "Bob", "Cy"]);
    const seeded = await seededTask(engine, team);
    const other = await seededTask(engine, team);
    const first = await listTaskLog(exec(), seeded.task.id, { limit: 3 });
    expect(first?.entries.map((entry) => entry.id)).toEqual(
      seeded.ids.slice(0, 3),
    );
    expect(first).toMatchObject({ earlier: 0, later: 5 });
    const second = await listTaskLog(exec(), seeded.task.id, {
      after: seeded.ids[2],
      limit: 3,
    });
    expect(second?.entries.map((entry) => entry.id)).toEqual(
      seeded.ids.slice(3, 6),
    );
    expect(second).toMatchObject({ earlier: 3, later: 2 });
    const last = await listTaskLog(exec(), seeded.task.id, {
      after: seeded.ids[7],
    });
    expect(last).toEqual({ entries: [], earlier: 8, later: 0 });
    expect(
      await listTaskLog(exec(), seeded.task.id, { after: other.ids[0] }),
    ).toBeUndefined();
    expect(
      await listTaskLog(exec(), seeded.task.id, { after: "msg_unknown" }),
    ).toBeUndefined();
  });

  it("pages from the newest end and backward with before", async () => {
    const { engine } = await setup({ start: false });
    const team = await createTeam(engine, ["Ada", "Bob", "Cy"]);
    const seeded = await seededTask(engine, team);
    const other = await seededTask(engine, team);
    const ids = (page: { entries: TaskLogEntry[] } | undefined) =>
      page?.entries.map((entry) => entry.id);
    const list = (filter: Parameters<typeof listTaskLog>[2]) =>
      listTaskLog(exec(), seeded.task.id, filter);
    const newest = await list({ newest: true, limit: 3 });
    expect(ids(newest)).toEqual(seeded.ids.slice(5, 8));
    expect(newest).toMatchObject({ earlier: 5, later: 0 });
    const back = await list({ before: seeded.ids[5], limit: 3 });
    expect(ids(back)).toEqual(seeded.ids.slice(2, 5));
    expect(back).toMatchObject({ earlier: 2, later: 3 });
    // Both cursors: the entries between them, from the older one.
    const between = await list({
      after: seeded.ids[1],
      before: seeded.ids[6],
      limit: 2,
    });
    expect(ids(between)).toEqual(seeded.ids.slice(2, 4));
    expect(between).toMatchObject({ earlier: 2, later: 4 });
    expect(await list({ before: seeded.ids[0] })).toEqual({
      entries: [],
      earlier: 0,
      later: 8,
    });
    // Adjacent cursors: an empty window whose counts still add up.
    expect(await list({ after: seeded.ids[2], before: seeded.ids[3] })).toEqual(
      { entries: [], earlier: 3, later: 5 },
    );
    // Crossed or equal cursors name no window: refused, not double-counted.
    expect(
      await list({ after: seeded.ids[5], before: seeded.ids[2] }),
    ).toBeUndefined();
    expect(
      await list({ after: seeded.ids[3], before: seeded.ids[3] }),
    ).toBeUndefined();
    // The newest reports: 3 of the 8 entries are reports.
    const reports = await list({ kind: "report", newest: true, limit: 2 });
    expect(ids(reports)).toEqual([seeded.ids[4], seeded.ids[7]]);
    expect(reports).toMatchObject({ earlier: 1, later: 0 });
    expect(await list({ before: other.ids[3] })).toBeUndefined();
  });

  it("formats a page with hints that repeat its filters, or says why it is empty", async () => {
    const { engine } = await setup({ start: false });
    const team = await createTeam(engine, ["Ada", "Bob", "Cy"]);
    const seeded = await seededTask(engine, team);
    const filter = {
      kind: "report" as const,
      query: "e",
      before: seeded.ids[7],
      limit: 1,
    };
    const page = await listTaskLog(exec(), seeded.task.id, filter);
    expect(
      page &&
        formatTaskLogPage(page, filter, {
          redact: same,
          tool: "read_task_log",
          args: { id: seeded.task.id },
        }),
    ).toBe(
      [
        `(1 earlier before ${seeded.ids[4]}: call \`read_task_log\` again with id "${seeded.task.id}", before "${seeded.ids[4]}", kind "report", query "e", limit 1.)`,
        `${seeded.ids[4]} [report] system → ${team.names[0]}: ${team.names[2]} failed: boom`,
        `(1 more after ${seeded.ids[4]}: call \`read_task_log\` again with id "${seeded.task.id}", after "${seeded.ids[4]}", kind "report", query "e", limit 1.)`,
      ].join("\n"),
    );
    const empty = { entries: [], earlier: 0, later: 0 };
    const format = { redact: same, tool: "task_log" };
    expect(formatTaskLogPage(empty, {}, format)).toBe("The task log is empty.");
    expect(formatTaskLogPage(empty, { query: "x" }, format)).toBe(
      "No entries match.",
    );
  });

  it("treats a NUL character as matching nothing instead of failing the query", async () => {
    const { engine } = await setup({ start: false });
    const team = await createTeam(engine, ["Ada", "Bob", "Cy"]);
    const seeded = await seededTask(engine, team);
    const nul = `${seeded.ids[0]}\u0000`;
    expect(
      await listTaskLog(exec(), seeded.task.id, { after: nul }),
    ).toBeUndefined();
    expect(
      await listTaskLog(exec(), seeded.task.id, { before: nul }),
    ).toBeUndefined();
    expect(
      await listTaskLog(exec(), seeded.task.id, { query: "red\u0000" }),
    ).toEqual({ entries: [], earlier: 0, later: 0 });
    expect(await readTaskLogEntry(exec(), seeded.task.id, nul)).toBeUndefined();
  });

  it("reads one entry in full, and nothing of another task", async () => {
    const { engine } = await setup({ start: false });
    const team = await createTeam(engine, ["Ada", "Bob", "Cy"]);
    const seeded = await seededTask(engine, team);
    const other = await seededTask(engine, team);
    const entry = await readTaskLogEntry(
      exec(),
      seeded.task.id,
      seeded.ids[1] as string,
    );
    expect(entry?.text).toBe("Write bob.txt in red.\nUse the zoo palette.");
    expect(
      await readTaskLogEntry(exec(), seeded.task.id, other.ids[1] as string),
    ).toBeUndefined();
    expect(
      await readTaskLogEntry(exec(), seeded.task.id, "msg_unknown"),
    ).toBeUndefined();
    // Each task's log holds only its own entries.
    const logs = await Promise.all(
      [seeded, other].map((task) => listTaskLog(exec(), task.task.id)),
    );
    expect(logs[0]?.entries.map((e) => e.id)).toEqual(seeded.ids);
    expect(logs[1]?.entries.map((e) => e.id)).toEqual(other.ids);
  });

  it("formats an index line with a clipped one-line preview", () => {
    const entry: TaskLogEntry = {
      id: "msg_1",
      kind: "brief",
      author: "Ada",
      to: ["Grace", "Linus"],
      everyone: false,
      sessionId: null,
      text: `Write glossary-a.md\n\nwith ${"many ".repeat(60)}terms.`,
      createdAt: new Date(0),
    };
    const line = indexLine(entry, same);
    expect(
      line.startsWith(
        "msg_1 [brief] Ada → Grace, Linus: Write glossary-a.md with many many",
      ),
    ).toBe(true);
    expect(line).not.toContain("\n");
    expect(line.endsWith("…")).toBe(true);
    expect(line.length).toBe("msg_1 [brief] Ada → Grace, Linus: ".length + 160);
    expect(indexLine({ ...entry, to: [], text: "Short." }, same)).toBe(
      "msg_1 [brief] Ada: Short.",
    );
    expect(
      indexLine(
        { ...entry, kind: "message", to: [], everyone: true, text: "All." },
        same,
      ),
    ).toBe("msg_1 [message] Ada → everyone: All.");
  });

  it("reads the task state and each session's brief and report, by session id or bot name", async () => {
    const { engine } = await setup({ start: false });
    const team = await createTeam(engine, ["Ada", "Bob", "Cy", "Dee"]);
    const [ada, bob, cy, dee] = team.names as [string, string, string, string];
    const seeded = await seededTask(engine, team);
    const other = await seededTask(engine, team);
    const state = await readTaskState(exec(), seeded.task.id);
    expect(state).toMatchObject({
      title: "Fence",
      goal: "Paint the fence\nIn red.",
      goalVersion: 1,
    });
    expect(
      state?.sessions.map((s) => [
        s.id,
        s.bot,
        s.role,
        s.status,
        s.requester,
        s.brief,
      ]),
    ).toEqual([
      [
        seeded.root.id,
        ada,
        "coordinator",
        "queued",
        null,
        "Paint the fence\nIn red.",
      ],
      [
        seeded.bobSession.id,
        bob,
        "worker",
        "completed",
        ada,
        "Write bob.txt in red.\nUse the zoo palette.",
      ],
      [seeded.cySession.id, cy, "worker", "failed", ada, "Write cy.txt."],
    ]);
    // The text shows each worker's first brief line.
    expect(state && formatTaskState(state, same)).toBe(
      [
        `Task ${seeded.task.id} "Fence": queued`,
        "Goal (version 1):",
        "Paint the fence\nIn red.",
        "",
        "Sessions, oldest first:",
        `- ${seeded.root.id} ${ada} (coordinator): queued`,
        `- ${seeded.bobSession.id} ${bob} (worker, from ${ada}): completed. Brief: Write bob.txt in red.`,
        `- ${seeded.cySession.id} ${cy} (worker, from ${ada}): failed. Brief: Write cy.txt.`,
      ].join("\n"),
    );

    const bobReport = await readSessionReport(
      exec(),
      seeded.task.id,
      seeded.bobSession.id,
    );
    expect(bobReport && formatSessionReport(bobReport, same)).toBe(
      [
        `Session ${seeded.bobSession.id}: ${bob} (worker, from ${ada}), completed, goal version 1`,
        "Brief:",
        "Write bob.txt in red.\nUse the zoo palette.",
        "Report:",
        "Bob wrote bob.txt in red.",
      ].join("\n"),
    );
    const byName = await readBotReports(
      exec(),
      seeded.task.id,
      cy.toUpperCase(),
    );
    expect(byName?.bot).toBe(cy);
    expect(
      byName?.reports.map((report) => formatSessionReport(report, same)),
    ).toEqual([
      [
        `Session ${seeded.cySession.id}: ${cy} (worker, from ${ada}), failed, goal version 1`,
        "Brief:",
        "Write cy.txt.",
        "Report:",
        "Failed: boom",
      ].join("\n"),
    ]);
    const coordinator = await readSessionReport(
      exec(),
      seeded.task.id,
      seeded.root.id,
    );
    expect(coordinator && formatSessionReport(coordinator, same)).toContain(
      "Brief (the task's goal when it started):\nPaint the fence\nIn red.\nResult:\n(not reported yet: queued)",
    );
    // A participant without a session, a stranger, and another task's session.
    expect(await readBotReports(exec(), seeded.task.id, dee)).toEqual({
      bot: dee,
      reports: [],
    });
    expect(
      await readBotReports(exec(), seeded.task.id, "Stranger"),
    ).toBeUndefined();
    expect(
      await readSessionReport(exec(), seeded.task.id, other.bobSession.id),
    ).toBeUndefined();
    expect(
      await readSessionReport(exec(), seeded.task.id, "sess_unknown"),
    ).toBeUndefined();
  });
});

/** The tool calls a bot's sessions made, with their outputs, from the task's events. */
async function toolOutputs(
  engine: TestEngine["engine"],
  view: TaskView,
  botId: string,
) {
  const sessionIds = new Set(
    view.sessions.filter((s) => s.botId === botId).map((s) => s.id),
  );
  const page = await engine.tasks.events(view.task.id);
  return page.events.flatMap((event) => {
    if (
      event.type !== "tool.finished" ||
      !sessionIds.has(event.sessionId ?? "")
    )
      return [];
    return [
      {
        tool: event.payload.tool,
        summary: event.payload.summary,
        ok: event.payload.ok,
        output: event.payload.output ?? "",
      },
    ];
  });
}

describe("lookup tools", () => {
  it("let a worker read the whole task log, an entry, the task state and any session's report", async () => {
    const { engine, executor } = await setup();
    const team = await createTeam(engine, ["Ada", "Bob", "Cy"]);
    const [ada, bob, cy] = team.names as [string, string, string];
    const USER_TEXT = "Use the red palette and end every line with [kiwi-7].";
    executor
      .brain(ada, (view) => {
        if (said.turns(view) === 0) return { text: "Which palette?" };
        const last = view.messages.at(-1);
        const input = last?.role === "user" ? last.text : "";
        const delegate = (bot: string, brief: string) => ({
          calls: [{ name: "delegate", args: { bot, brief } }],
        });
        if (input.startsWith("Message from the user"))
          return delegate(bob, "Write bob.txt");
        if (input.startsWith(`Result from ${bob} (session`))
          return delegate(cy, "Write cy.txt");
        if (input.startsWith(`Result from ${cy} (session`))
          return { calls: [{ name: "read_report", args: { bot: cy } }] };
        if (last?.role === "tool" && last.name === "read_report")
          return {
            calls: [{ name: "complete_task", args: { result: "Both done." } }],
          };
        return { text: "" };
      })
      .brain(bob, (view) =>
        said.turns(view) === 0
          ? {
              // To the coordinator, not to Cy: Cy still finds it in the log.
              // Then one to everyone, which the log tells apart from a reply
              // to the user.
              calls: [
                {
                  name: "message",
                  args: { to: ada, text: "FYI: I chose crimson." },
                },
                { name: "message", args: { text: "All: crimson it is." } },
              ],
            }
          : { text: "Bob wrote bob.txt in crimson." },
      )
      .brain(cy, (view) => {
        const results = said.results(view);
        switch (said.turns(view)) {
          case 0:
            // Held until the coordinator waits, so what Cy reads is settled.
            return { calls: [{ name: "gate", args: { name: "cy" } }] };
          case 1:
            return {
              calls: [
                { name: "task_state", args: {} },
                { name: "task_log", args: {} },
                { name: "task_log", args: { kind: "user" } },
                { name: "task_log", args: { query: "KIWI-7" } },
                { name: "task_log", args: { limit: 2 } },
                { name: "task_log", args: { kind: "brief", limit: 1 } },
                { name: "task_log", args: { newest: true, limit: 2 } },
              ],
            };
          case 2: {
            const before = /^(msg_\S+) \[report\]/m.exec(
              results[7]?.text ?? "",
            )?.[1];
            const userEntry = /^(msg_\S+) \[user\]/m.exec(
              results[3]?.text ?? "",
            )?.[1];
            const root = new RegExp(
              `^- (sess_\\S+) ${ada} \\(coordinator\\)`,
              "m",
            ).exec(results[1]?.text ?? "")?.[1];
            return {
              calls: [
                { name: "task_log", args: { before, limit: 2 } },
                { name: "read_entry", args: { id: userEntry } },
                { name: "read_report", args: { bot: bob } },
                { name: "read_report", args: { session: root } },
                { name: "read_entry", args: { id: "msg_unknown" } },
                { name: "read_report", args: { session: "sess_unknown" } },
                { name: "read_report", args: { bot: "Stranger" } },
                { name: "task_log", args: { kind: "steering" } },
              ],
            };
          }
          default:
            return { text: "Cy wrote cy.txt." };
        }
      });
    const { task } = await engine.tasks.create({
      goal: "Write two files",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    await untilTask(engine, task.id, (v) => v.task.status === "waiting");
    await engine.tasks.postMessage(task.id, { text: USER_TEXT });
    await executor.gate("cy").reached;
    await untilTask(
      engine,
      task.id,
      (v) =>
        v.sessions.find((s) => s.botId === team.byName[ada])?.status ===
        "waiting",
    );
    executor.gate("cy").open();
    const view = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed",
    );
    const ids = view.messages.map((message) => message.id);
    const outputs = (
      await toolOutputs(engine, view, team.byName[cy] as string)
    ).filter((o) => o.tool !== "gate");
    expect(outputs.map((o) => [o.tool, o.ok])).toEqual([
      ["task_state", true],
      ["task_log", true],
      ["task_log", true],
      ["task_log", true],
      ["task_log", true],
      ["task_log", true],
      ["task_log", true],
      ["task_log", true],
      ["read_entry", true],
      ["read_report", true],
      ["read_report", true],
      ["read_entry", false],
      ["read_report", false],
      ["read_report", false],
      ["task_log", false],
    ]);
    const [
      state,
      all,
      users,
      search,
      paged,
      briefs,
      newest,
      previous,
      entry,
      bobReport,
      rootReport,
    ] = outputs.map((o) => o.output);
    const sessionOf = (name: string) =>
      view.sessions.find(
        (s) => s.botId === team.byName[name],
      ) as TaskView["sessions"][number];
    expect(state).toBe(
      [
        `Task ${task.id} "Write two files": running`,
        "Goal (version 1):",
        "Write two files",
        "",
        "Sessions, oldest first:",
        `- ${sessionOf(ada).id} ${ada} (coordinator): waiting for its delegations`,
        `- ${sessionOf(bob).id} ${bob} (worker, from ${ada}): completed. Brief: Write bob.txt`,
        `- ${sessionOf(cy).id} ${cy} (worker, from ${ada}): running. Brief: Write cy.txt`,
      ].join("\n"),
    );
    // Every entry so far, oldest first, keyed by its message id, including
    // Bob's message to the coordinator. His broadcast reads "→ everyone",
    // while the coordinator's question to the user has no recipient.
    expect(all).toBe(
      [
        `${ids[0]} [message] ${ada}: Which palette?`,
        `${ids[1]} [user] user → ${ada}: ${USER_TEXT}`,
        `${ids[2]} [brief] ${ada} → ${bob}: Write bob.txt`,
        `${ids[3]} [message] ${bob} → ${ada}: FYI: I chose crimson.`,
        `${ids[4]} [message] ${bob} → everyone: All: crimson it is.`,
        `${ids[5]} [report] ${bob} → ${ada}: Bob wrote bob.txt in crimson.`,
        `${ids[6]} [brief] ${ada} → ${cy}: Write cy.txt`,
      ].join("\n"),
    );
    expect(users).toBe(`${ids[1]} [user] user → ${ada}: ${USER_TEXT}`);
    expect(search).toBe(users);
    expect(paged).toBe(
      [
        `${ids[0]} [message] ${ada}: Which palette?`,
        `${ids[1]} [user] user → ${ada}: ${USER_TEXT}`,
        `(5 more after ${ids[1]}: call \`task_log\` again with after "${ids[1]}", limit 2.)`,
      ].join("\n"),
    );
    // The next-page hint keeps the filters it was listed with.
    expect(briefs).toBe(
      [
        `${ids[2]} [brief] ${ada} → ${bob}: Write bob.txt`,
        `(1 more after ${ids[2]}: call \`task_log\` again with after "${ids[2]}", kind "brief", limit 1.)`,
      ].join("\n"),
    );
    // The newest page, still oldest first, points back at what is earlier;
    // the page before a cursor points both ways.
    expect(newest).toBe(
      [
        `(5 earlier before ${ids[5]}: call \`task_log\` again with before "${ids[5]}", limit 2.)`,
        `${ids[5]} [report] ${bob} → ${ada}: Bob wrote bob.txt in crimson.`,
        `${ids[6]} [brief] ${ada} → ${cy}: Write cy.txt`,
      ].join("\n"),
    );
    expect(previous).toBe(
      [
        `(3 earlier before ${ids[3]}: call \`task_log\` again with before "${ids[3]}", limit 2.)`,
        `${ids[3]} [message] ${bob} → ${ada}: FYI: I chose crimson.`,
        `${ids[4]} [message] ${bob} → everyone: All: crimson it is.`,
        `(2 more after ${ids[4]}: call \`task_log\` again with after "${ids[4]}", limit 2.)`,
      ].join("\n"),
    );
    expect(entry).toBe(`${ids[1]} [user] user → ${ada}\n${USER_TEXT}`);
    expect(bobReport).toBe(
      [
        `Session ${sessionOf(bob).id}: ${bob} (worker, from ${ada}), completed, goal version 1`,
        "Brief:",
        "Write bob.txt",
        "Report:",
        "Bob wrote bob.txt in crimson.",
      ].join("\n"),
    );
    expect(rootReport).toContain(
      `Session ${sessionOf(ada).id}: ${ada} (coordinator), waiting for its delegations, goal version 1\nBrief (the task's goal when it started):\nWrite two files\nResult:\n(not reported yet: waiting for its delegations)`,
    );
    expect(outputs.slice(11).map((o) => o.output)).toEqual([
      'No entry "msg_unknown" in this task\'s log. Entry ids look like msg_… and start each `task_log` line.',
      'No session "sess_unknown" on this task. Session ids look like sess_… and come from `task_state`.',
      "Stranger is not on this task.",
      "Unknown kind steering. Use one of: user, brief, report, message.",
    ]);
    // The coordinator reads a worker's report too.
    const adaReads = (
      await toolOutputs(engine, view, team.byName[ada] as string)
    ).filter((o) => o.tool === "read_report");
    expect(adaReads.map((o) => o.output)).toEqual([
      expect.stringMatching(
        new RegExp(
          `^Session ${sessionOf(cy).id}: ${cy} \\(worker, from ${ada}\\), completed, goal version 1\nBrief:\nWrite cy.txt\nReport:\nCy wrote cy.txt.$`,
        ),
      ),
    ]);
    // Tools lead the prompt cache: every session and run of the task gets the
    // same lookup definitions, which name no task, session, bot or entry.
    const runs = executor.inputs.filter((input) =>
      view.sessions.some((s) => s.id === input.sessionId),
    );
    expect(new Set(runs.map((input) => promptBot(input.systemPrompt)))).toEqual(
      new Set([ada, bob, cy]),
    );
    const definitions = runs.map((input) =>
      JSON.stringify(
        input.collaborationTools
          .filter((tool) =>
            (LOOKUP_TOOLS as readonly string[]).includes(tool.name),
          )
          .map(({ name, description, parameters }) => ({
            name,
            description,
            parameters,
          })),
      ),
    );
    expect(definitions.length).toBeGreaterThanOrEqual(5);
    expect(new Set(definitions).size).toBe(1);
    expect(
      JSON.parse(definitions[0] as string).map(
        (tool: { name: string }) => tool.name,
      ),
    ).toEqual([...LOOKUP_TOOLS]);
    for (const text of [
      task.id,
      ada,
      bob,
      cy,
      ...view.sessions.map((s) => s.id),
      ...ids,
    ])
      expect(definitions[0]).not.toContain(text);
  });

  it("refuse a NUL character and a failed read cleanly, without the database's message", async () => {
    const { engine } = await setup({ start: false });
    const team = await createTeam(engine, ["Ada", "Bob", "Cy"]);
    const seeded = await seededTask(engine, team);
    const warnings = quietLogger.warnings.length;
    // Only what the tools use of a run.
    const rcWith = (db: unknown) =>
      ({
        deps: { ctx: { db, logger: quietLogger } },
        task: { id: seeded.task.id },
        session: { id: seeded.root.id },
        redact: same,
      }) as unknown as RunContext;
    const call = (tools: CollabTool[], name: string, args: object) =>
      tools
        .find((tool) => tool.name === name)
        ?.execute(args as Record<string, unknown>, {
          toolCallId: "c",
          signal: new AbortController().signal,
        });
    const tools = lookupTools(rcWith(exec()));
    expect(await call(tools, "read_entry", { id: "msg_\u0000" })).toEqual({
      text: "`id` cannot contain a NUL character.",
      isError: true,
    });
    expect(await call(tools, "task_log", { query: "red\u0000" })).toEqual({
      text: "`query` cannot contain a NUL character.",
      isError: true,
    });
    expect(
      await call(tools, "task_log", { before: `${seeded.ids[1]}\u0000` }),
    ).toEqual({
      text: "`before` cannot contain a NUL character.",
      isError: true,
    });
    expect(
      await call(tools, "task_log", {
        after: seeded.ids[5],
        before: seeded.ids[2],
      }),
    ).toEqual({
      text: "No entries between those cursors: `after` and `before` must both be entries of this task's log, `after` the older one.",
      isError: true,
    });
    const failing = lookupTools(
      rcWith({
        select() {
          throw new Error('Failed query: select * from "task_messages"');
        },
      }),
    );
    for (const name of LOOKUP_TOOLS)
      expect(
        await call(failing, name, { id: seeded.ids[0], bot: "Ada" }),
      ).toEqual({ text: "The lookup failed; try again.", isError: true });
    expect(quietLogger.warnings.length).toBe(warnings + LOOKUP_TOOLS.length);
  });

  it("read only the caller's own task, by id and by search", async () => {
    const { engine, executor } = await setup();
    const team = await createTeam(engine, ["Ada", "Bob"]);
    const [ada, bob] = team.names as [string, string];
    executor
      .brain(ada, (view) => {
        if (said.turns(view) === 0)
          return {
            calls: [
              {
                name: "delegate",
                args: { bot: bob, brief: "Write the secret plan: kiwi-7" },
              },
            ],
          };
        if (!said.heard(view, `Result from ${bob} (session`))
          return { text: "" };
        return lastResult(view)?.name === "complete_task"
          ? { text: "Done." }
          : {
              calls: [{ name: "complete_task", args: { result: "Planned." } }],
            };
      })
      .brain(bob, () => ({ text: "The plan is kiwi-7." }));
    const { task: first } = await engine.tasks.create({
      goal: "Plan",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    const firstView = await untilTask(
      engine,
      first.id,
      (v) => v.task.status === "completed",
    );
    const entryId = firstView.messages[0]?.id as string;
    const bobSession = firstView.sessions.find(
      (s) => s.botId === team.byName[bob],
    )?.id as string;

    // Eve's task shares no bot with the first one.
    const other = await createTeam(engine, ["Eve"]);
    const [eve] = other.names as [string];
    executor.brain(eve, (view) => {
      if (said.turns(view) === 0)
        return {
          calls: [
            { name: "read_entry", args: { id: entryId } },
            { name: "read_report", args: { session: bobSession } },
            { name: "read_report", args: { bot: bob } },
            { name: "task_log", args: { query: "kiwi-7" } },
            { name: "task_log", args: { after: entryId } },
            { name: "task_log", args: {} },
          ],
        };
      return lastResult(view)?.name === "complete_task"
        ? { text: "Done." }
        : {
            calls: [
              { name: "complete_task", args: { result: "Nothing found." } },
            ],
          };
    });
    const { task: second } = await engine.tasks.create({
      goal: "Look around",
      coordinatorBotId: other.byName[eve] as string,
    });
    const secondView = await untilTask(
      engine,
      second.id,
      (v) => v.task.status === "completed",
    );
    const outputs = await toolOutputs(
      engine,
      secondView,
      other.byName[eve] as string,
    );
    expect(outputs.slice(0, 6).map((o) => [o.tool, o.ok, o.output])).toEqual([
      [
        "read_entry",
        false,
        `No entry "${entryId}" in this task's log. Entry ids look like msg_… and start each \`task_log\` line.`,
      ],
      [
        "read_report",
        false,
        `No session "${bobSession}" on this task. Session ids look like sess_… and come from \`task_state\`.`,
      ],
      ["read_report", false, `${bob} is not on this task.`],
      ["task_log", true, "No entries match."],
      [
        "task_log",
        false,
        `No entry "${entryId}" in this task's log. Entry ids look like msg_… and start each \`task_log\` line.`,
      ],
      ["task_log", true, "The task log is empty."],
    ]);
    for (const o of outputs) expect(o.output).not.toContain("kiwi-7");
  });

  it("redact what they read before a preview clips it, whatever the runtime does", async () => {
    const KEY = "sk-test-ghjkmnpqrstvwxyzGHJKMNPQ";
    const { engine, executor } = await setup({
      secrets: [{ name: "OPENAI_API_KEY", value: KEY }],
    });
    const team = await createTeam(engine, ["Ada", "Bob"]);
    const [ada, bob] = team.names as [string, string];
    // The fake executor hands tool results to the brain as they are.
    let seen: string[] = [];
    executor.brain(ada, (view) => {
      if (said.turns(view) === 0) return { text: "Your key?" };
      const results = said.results(view);
      if (results.length === 0)
        return { calls: [{ name: "task_log", args: { kind: "user" } }] };
      if (results.length === 1) {
        const id = /^(msg_\S+) /.exec(results[0]?.text ?? "")?.[1];
        return { calls: [{ name: "read_entry", args: { id } }] };
      }
      if (results.length === 2)
        return { calls: [{ name: "task_state", args: {} }] };
      if (lastResult(view)?.name === "complete_task") return { text: "Done." };
      seen = results.map((result) => result.text);
      return { calls: [{ name: "complete_task", args: { result: "Read." } }] };
    });
    // The user's goal and messages are stored as written.
    const { task } = await engine.tasks.create({
      goal: `Read the key ${KEY}`,
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    await untilTask(engine, task.id, (v) => v.task.status === "waiting");
    // A brief stored before the key was a configured secret: the task state's
    // 80-character first line would cut through it.
    const [root] = await exec()
      .select()
      .from(sessions)
      .where(eq(sessions.taskId, task.id));
    const head = "y".repeat(70);
    await exec()
      .insert(sessions)
      .values({
        id: newId("session"),
        taskId: task.id,
        botId: team.byName[bob] as string,
        parentSessionId: root?.id,
        role: "worker",
        brief: `${head} ${KEY} and more`,
        goalVersion: 1,
        depth: 1,
        status: "completed",
        result: "done",
      });
    // The 160-character preview would cut through this one.
    const pad = "x".repeat(150);
    await engine.tasks.postMessage(task.id, { text: `${pad} ${KEY} is it.` });
    await untilTask(engine, task.id, (v) => v.task.status === "completed");
    expect(seen).toHaveLength(3);
    expect(seen[0]?.endsWith(`: ${pad} [redacte…`)).toBe(true);
    expect(seen[1]).toContain(`${pad} ${REDACTED} is it.`);
    expect(seen[2]).toContain(`Goal (version 1):\nRead the key ${REDACTED}`);
    expect(seen[2]).toContain(`Brief: ${head} [redacte…`);
    for (const text of seen) expect(text).not.toContain(KEY.slice(0, 7));
  });

  it("redact what they return and are capped and spilled like other tool output", async () => {
    const KEY = "sk-test-ghjkmnpqrstvwxyzGHJKMNPQ";
    const faux = fauxProvider();
    const registry = new ModelRegistry({
      env: {},
      extraProviders: [faux.provider],
    });
    const { engine } = await setup({
      runExecutor: new PiSessionExecutor({
        models: registry,
        outputCapBytes: 1024,
      }),
      secrets: [{ name: "OPENAI_API_KEY", value: KEY }],
      config: { outputCapBytes: 1024 },
    });
    const team = await createTeam(engine, ["Ada"]);
    const [ada] = team.names as [string];
    // The user pastes a key into a long message; stored as written.
    const userText = `My key is ${KEY}.\n${"z".repeat(3000)}\nEnd ${KEY}`;
    let read: string | undefined;
    faux.setResponses([
      say("Send me the details."),
      callTool("task_log", { kind: "user" }),
      (context) => {
        const id =
          /^(msg_\S+) \[user\]/m.exec(textOf(context.messages.at(-1)))?.[1] ??
          "";
        return callTool("read_entry", { id });
      },
      (context) => {
        read = textOf(context.messages.at(-1));
        return callTool("complete_task", { result: "Read it." });
      },
    ]);
    const { task } = await engine.tasks.create({
      goal: "Read the user's details",
      coordinatorBotId: team.byName[ada] as string,
    });
    await untilTask(engine, task.id, (v) => v.task.status === "waiting");
    await engine.tasks.postMessage(task.id, { text: userText });
    const view = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed" || v.task.status === "failed",
    );
    expect(view.task.status).toBe("completed");
    // The model saw a capped, redacted preview that names the spilled artifact.
    expect(Buffer.byteLength(read ?? "")).toBeLessThanOrEqual(1024);
    expect(read).not.toContain(KEY);
    expect(read).toContain(`My key is ${REDACTED}.`);
    const spilled = view.artifacts.filter((a) => a.kind === "output");
    expect(spilled).toHaveLength(1);
    expect(read).toContain(`artifact ${spilled[0]?.id}`);
    const content = Buffer.from(
      (await engine.tasks.artifactContent(task.id, spilled[0]?.id as string))
        .content,
    ).toString();
    expect(content).toBe(
      `${view.messages.find((m) => m.authorKind === "user")?.id} [user] user → ${ada}\nMy key is ${REDACTED}.\n${"z".repeat(3000)}\nEnd ${REDACTED}`,
    );
    const page = await engine.tasks.events(task.id);
    const finished = page.events.find(
      (e) => e.type === "tool.finished" && e.payload.tool === "read_entry",
    );
    expect(
      finished?.type === "tool.finished" && finished.payload,
    ).toMatchObject({
      ok: true,
      truncated: true,
      artifactId: spilled[0]?.id,
    });
    const entries = await exec()
      .select({ entry: sessionEntries.entry })
      .from(sessionEntries)
      .where(eq(sessionEntries.sessionId, view.sessions[0]?.id as string));
    expect(JSON.stringify(entries)).not.toContain(KEY);
  });
});
