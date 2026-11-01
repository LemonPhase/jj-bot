import {
  type Bot,
  type ExecutionSession,
  emptyUsage,
  type Task,
  type TaskEvent,
  type TaskMessage,
  type TaskView,
} from "@jj/contracts";
import { describe, expect, it } from "vitest";
import { createDemoApi } from "../../api/demoApi";
import { formatBytes, formatCost, formatCount, usageLine } from "./format";
import {
  activityLines,
  briefLine,
  codeSegments,
  defaultSelection,
  flattenTree,
  formatToolCall,
  headingFor,
  mentionSegments,
  participantMood,
  participantsLabel,
  sessionToolCalls,
  sessionTree,
  TASK_NODE,
  taskTimeline,
  toolCount,
  treeShape,
} from "./taskModel";

const T0 = Date.parse("2026-10-31T12:00:00.000Z");
const at = (seconds: number) => new Date(T0 + seconds * 1000).toISOString();

const task: Task = {
  id: "task-1",
  title: "Ship the release",
  goal: "Ship the release",
  goalVersion: 1,
  coordinatorBotId: "bot-a",
  participantBotIds: ["bot-a", "bot-b", "bot-c"],
  status: "running",
  result: null,
  error: null,
  cancelReason: null,
  cancelRequestedAt: null,
  createdAt: at(0),
  updatedAt: at(0),
  finishedAt: null,
};

let order = 0;
const session = (
  id: string,
  parentSessionId: string | null,
  patch: Partial<ExecutionSession> = {},
): ExecutionSession => {
  order += 1;
  return {
    id,
    taskId: "task-1",
    botId: "bot-a",
    parentSessionId,
    role: parentSessionId ? "worker" : "coordinator",
    brief: `Brief for ${id}`,
    goalVersion: 1,
    depth: 0,
    status: "running",
    waitingFor: null,
    result: null,
    error: null,
    activity: null,
    runCount: 1,
    createdAt: at(order),
    updatedAt: at(order),
    startedAt: at(order),
    finishedAt: null,
    ...patch,
  };
};

const view = (
  sessions: ExecutionSession[],
  patch: Partial<TaskView> = {},
): TaskView => ({
  task,
  sessions,
  messages: [],
  artifacts: [],
  usage: { total: emptyUsage(), bySession: {} },
  events: [],
  firstSequence: 1,
  hasEarlier: false,
  cursor: 0,
  ...patch,
});

const base = (sequence: number, sessionId: string | null = null) => ({
  id: `e${sequence}`,
  taskId: "task-1",
  sequence,
  occurredAt: at(sequence),
  botId: null,
  sessionId,
  runId: null,
  causedBy: null,
});

const bot = (id: string, name: string): Bot => ({
  id,
  name,
  role: "",
  instructions: "",
  model: null,
  runtimeProfileId: null,
  appearance: {
    shape: "round",
    face: "dots",
    topper: "none",
    colour: "green",
    body: "ivory",
    gait: "hop",
  },
  presence: "idle",
  activeTaskIds: [],
  createdAt: at(0),
  updatedAt: at(0),
});

const ids = (nodes: { session: ExecutionSession }[]) =>
  nodes.map((node) => node.session.id);

describe("session tree (the execution graph)", () => {
  it("nests delegations under their parent at any depth and width", () => {
    const sessions = [
      session("root", null),
      session("a", "root"),
      session("b", "root"),
      session("c", "root"),
      session("a1", "a"),
      session("a2", "a"),
      session("a1x", "a1"),
    ];
    const roots = sessionTree(view([...sessions].reverse()));
    expect(ids(roots)).toEqual(["root"]);
    expect(ids(roots[0]?.children ?? [])).toEqual(["a", "b", "c"]);
    expect(ids(flattenTree(roots))).toEqual([
      "root",
      "a",
      "a1",
      "a1x",
      "a2",
      "b",
      "c",
    ]);
    expect(flattenTree(roots).map((node) => node.depth)).toEqual([
      0, 1, 2, 3, 2, 1, 1,
    ]);
    expect(treeShape(roots)).toEqual({ depth: 4, width: 3, leaves: 4 });
  });

  it("shows sessions with a missing parent, or in a cycle, as roots", () => {
    const roots = sessionTree(
      view([
        session("root", null),
        session("orphan", "gone"),
        session("x", "y"),
        session("y", "x"),
        session("self", "self"),
      ]),
    );
    expect(flattenTree(roots)).toHaveLength(5);
    // Cycles are broken after the real roots, at their oldest session.
    expect(ids(roots)).toEqual(["root", "orphan", "self", "x"]);
  });

  it("is empty before any session exists", () => {
    expect(sessionTree(view([]))).toEqual([]);
    expect(treeShape([])).toEqual({ depth: 0, width: 0, leaves: 0 });
  });
});

describe("tool calls per session", () => {
  const events: TaskEvent[] = [
    {
      ...base(1, "s"),
      type: "session.created",
      payload: { session: session("s", null) },
    },
    {
      ...base(2, "s"),
      type: "tool.started",
      payload: { toolCallId: "t1", tool: "bash", summary: "npm test" },
    },
    {
      ...base(3, "s"),
      type: "tool.finished",
      payload: {
        toolCallId: "t1",
        tool: "bash",
        summary: "npm test",
        ok: false,
        exitCode: 1,
        truncated: false,
      },
    },
    {
      ...base(4, "other"),
      type: "tool.started",
      payload: { toolCallId: "t2", tool: "read", summary: "a.ts" },
    },
    {
      ...base(5, "s"),
      type: "tool.started",
      payload: { toolCallId: "t3", tool: "complete_task", summary: "" },
    },
  ];

  it("lists them in order with their outcome", () => {
    const tools = sessionToolCalls(view([], { events }), "s");
    expect(tools.partial).toBe(false);
    expect(tools.calls).toEqual([
      {
        id: "t1",
        tool: "bash",
        summary: "npm test",
        state: "failed",
        exitCode: 1,
      },
      {
        id: "t3",
        tool: "complete_task",
        summary: "",
        state: "running",
        exitCode: null,
      },
    ]);
    expect(tools.calls.map(formatToolCall)).toEqual([
      "bash(npm test)",
      "complete_task",
    ]);
    expect(toolCount(tools)).toBe("2 tools");
  });

  it("is partial when older events are not loaded and the session began before them", () => {
    const trimmed = view([], { events: events.slice(1), hasEarlier: true });
    const tools = sessionToolCalls(trimmed, "s");
    expect(tools.partial).toBe(true);
    expect(toolCount(tools)).toBe("2+ tools");
    expect(toolCount({ calls: tools.calls.slice(0, 1), partial: true })).toBe(
      "1+ tools",
    );
    // Its creation is still in the window: nothing is missing.
    expect(
      sessionToolCalls(view([], { events, hasEarlier: true }), "s").partial,
    ).toBe(false);
  });
});

describe("live activity lines", () => {
  it("has one line per session in play, coordinator first", () => {
    const lines = activityLines(
      view([
        session("w1", "root", {
          botId: "bot-b",
          activity: {
            kind: "command",
            text: "Running `npm test`",
            since: at(9),
          },
        }),
        session("root", null, {
          status: "waiting",
          waitingFor: "delegations",
          activity: {
            kind: "waiting",
            text: "Waiting on delegated work",
            since: at(9),
          },
        }),
        session("w2", "root", { botId: "bot-c", status: "queued" }),
        session("w3", "root", { status: "running" }),
        session("done", "root", { status: "completed" }),
      ]),
    );
    expect(
      lines.map((line) => [line.session.id, line.text, line.working]),
    ).toEqual([
      ["root", "Waiting on delegated work", false],
      ["w1", "Running `npm test`", true],
      ["w2", "Queued", false],
      ["w3", "Working…", true],
    ]);
  });

  it("says who a waiting session waits for when it has no activity", () => {
    const [line] = activityLines(
      view([session("root", null, { status: "waiting", waitingFor: "user" })]),
    );
    expect(line?.text).toBe("Waiting for you");
  });

  it("is empty once the task finished", () => {
    expect(
      activityLines({
        ...view([session("root", null)]),
        task: { ...task, status: "cancelled" },
      }),
    ).toEqual([]);
  });

  it("splits commands out of the line", () => {
    expect(codeSegments("Running `npm test` now")).toEqual([
      { text: "Running ", code: false },
      { text: "npm test", code: true },
      { text: " now", code: false },
    ]);
    expect(codeSegments("Odd ` tick")).toEqual([
      { text: "Odd ` tick", code: false },
    ]);
  });
});

describe("mentions", () => {
  const bots = [bot("bot-m", "Moss"), bot("bot-mo", "Moss Two")];

  it("marks @names of known bots, longest first, case-insensitively", () => {
    const segments = mentionSegments(
      "@moss two and @Moss, not @Mossy or email@x",
      bots,
    );
    expect(segments.map((s) => [s.text, s.bot?.id ?? null])).toEqual([
      ["@moss two", "bot-mo"],
      [" and ", null],
      ["@Moss", "bot-m"],
      [", not @Mossy or email@x", null],
    ]);
  });

  it("leaves text without bots alone", () => {
    expect(mentionSegments("Hello @Moss", [])).toEqual([
      { text: "Hello @Moss" },
    ]);
  });
});

describe("chat timeline", () => {
  const message = (
    sequence: number,
    authorKind: TaskMessage["authorKind"],
    text: string,
  ): TaskMessage => ({
    id: `m${sequence}`,
    taskId: "task-1",
    sequence,
    authorKind,
    authorBotId: authorKind === "bot" ? "bot-a" : null,
    sessionId: null,
    intent: authorKind === "user" ? "steering" : "result",
    text,
    recipientBotIds: [],
    createdAt: at(sequence),
  });
  const posted = (sequence: number, m: TaskMessage): TaskEvent => ({
    ...base(sequence),
    type: "message.posted",
    payload: { message: m },
  });

  it("places goal changes, stop requests and the finish where they happened", () => {
    const old = message(1, "bot", "Before the window");
    const steer = message(2, "user", "New goal text");
    const reply = message(3, "bot", "On it");
    const events: TaskEvent[] = [
      posted(10, steer),
      {
        ...base(11),
        type: "task.goal_changed",
        payload: { goal: "New goal text", goalVersion: 2 },
      },
      posted(12, reply),
      {
        ...base(13),
        type: "cancellation.requested",
        payload: { reason: null },
      },
      {
        ...base(14),
        type: "task.finished",
        payload: { status: "cancelled", result: null, error: null },
      },
    ];
    const timeline = taskTimeline(
      view([], {
        messages: [reply, old, steer],
        events,
        firstSequence: 10,
        hasEarlier: true,
      }),
    );
    expect(
      timeline.map((entry) =>
        entry.kind === "notice"
          ? entry.text
          : `${entry.message.text}${entry.goalVersion ? ` (v${entry.goalVersion})` : ""}`,
      ),
    ).toEqual([
      "Before the window",
      "New goal text (v2)",
      "Goal updated to v2",
      "On it",
      "Stop requested",
      "Task stopped",
    ]);
  });

  it("keeps a just-posted message (no event yet) at the end", () => {
    const first = message(1, "bot", "First");
    const mine = message(2, "user", "Mine");
    const timeline = taskTimeline(
      view([], { messages: [first, mine], events: [posted(5, first)] }),
    );
    expect(
      timeline.map((entry) =>
        entry.kind === "message" ? entry.message.id : "",
      ),
    ).toEqual(["m1", "m2"]);
  });
});

describe("header and participants", () => {
  it("shows the whole goal when the title was derived from it", () => {
    expect(headingFor({ title: "Fix it", goal: "Fix it" })).toEqual({
      heading: "Fix it",
      goal: null,
    });
    expect(
      headingFor({
        title: "Check that the stream resumes…",
        goal: "Check that the stream resumes after a reconnect",
      }),
    ).toEqual({
      heading: "Check that the stream resumes after a reconnect",
      goal: null,
    });
    // After a goal change the title no longer describes the goal: show both.
    expect(headingFor({ title: "Fix it", goal: "Fix it and test it" })).toEqual(
      { heading: "Fix it", goal: "Fix it and test it" },
    );
  });

  it("names the coordinator and follows each bot's latest session", () => {
    const getBot = (id: string) =>
      id === "bot-a" ? bot("bot-a", "Juno") : undefined;
    expect(participantsLabel(task, getBot)).toBe(
      "Participants: Juno (coordinator), Unknown bot, Unknown bot",
    );
    const v = view([
      session("old", null, { botId: "bot-b", status: "failed" }),
      session("new", null, { botId: "bot-b", status: "completed" }),
    ]);
    expect(participantMood(v, "bot-b")).toBe("done");
    expect(participantMood(v, "bot-a")).toBe("working"); // coordinator follows the running task
    expect(participantMood(v, "bot-c")).toBe("idle");
  });

  it("cuts briefs to a first line at a word", () => {
    expect(briefLine("  \nFirst line\nsecond")).toBe("First line");
    expect(briefLine("one two three four five six", 12)).toBe("one two…");
  });
});

describe("graph selection", () => {
  it("defaults to the newest running delegation, then the root, then the task", () => {
    expect(defaultSelection(view([]))).toBe(TASK_NODE);
    expect(
      defaultSelection(
        view([
          session("root", null, { status: "waiting" }),
          session("a", "root", { status: "running" }),
          session("b", "root", { status: "running" }),
        ]),
      ),
    ).toBe("b");
    expect(
      defaultSelection(view([session("root", null, { status: "completed" })])),
    ).toBe("root");
  });
});

describe("the demo task, end to end", () => {
  it("derives a two-level graph, partial-free tools and an artifact producer", async () => {
    const api = createDemoApi({
      now: () => new Date(T0),
      autoplay: false,
    });
    const done = await api.getTask("task-102");
    const roots = sessionTree(done);
    expect(treeShape(roots)).toEqual({ depth: 2, width: 1, leaves: 1 });
    const worker = roots[0]?.children[0]?.session;
    expect(worker?.status).toBe("completed");
    const tools = sessionToolCalls(done, worker?.id ?? "");
    expect(tools.calls.map(formatToolCall)).toEqual([
      "bash(npm test)",
      "write(notes/findings.md)",
    ]);
    expect(tools.partial).toBe(false);
    expect(done.artifacts[0]?.sessionId).toBe(worker?.id);
    expect(activityLines(done)).toEqual([]);
    expect(taskTimeline(done).at(-1)).toMatchObject({ text: "Task done" });
  });
});

describe("number formats", () => {
  it("formats counts, cost and sizes", () => {
    expect([950, 14_230, 125_000, 3_100_000].map(formatCount)).toEqual([
      "950",
      "14.2k",
      "125k",
      "3.1M",
    ]);
    expect([0, 0.004, 1.236].map(formatCost)).toEqual([
      "$0.00",
      "<$0.01",
      "$1.24",
    ]);
    expect([512, 2150, 3_500_000].map(formatBytes)).toEqual([
      "512 B",
      "2.1 KB",
      "3.3 MB",
    ]);
    expect(
      usageLine({ ...emptyUsage(), inputTokens: 12_000, outputTokens: 2_200 }),
    ).toBe("14.2k tokens · $0.00");
  });
});
