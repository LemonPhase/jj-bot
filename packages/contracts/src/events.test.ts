import { describe, expect, it } from "vitest";
import {
  addUsage,
  applyTaskEvent,
  type ExecutionSession,
  emptyUsage,
  type ParsedTaskEvent,
  parseTaskEvent,
  TASK_VIEW_EVENT_LIMIT,
  type Task,
  type TaskEventOf,
  type TaskEventType,
  type TaskMessage,
  type TaskView,
  taskViewSchema,
  type Usage,
} from "./index";

const time = (second: number) =>
  `2026-10-31T12:${String(Math.floor(second / 60)).padStart(2, "0")}:${String(second % 60).padStart(2, "0")}.000Z`;

const usage = (inputTokens: number, costUsd: number): Usage => ({
  modelCalls: 1,
  inputTokens,
  outputTokens: inputTokens / 10,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd,
});
const u1 = usage(1000, 0.5);
const u2 = usage(2000, 0.25);
const u3 = usage(500, 0.125);

// --- Records as the server stores them at each step. ---
const taskQueued: Task = {
  id: "t1",
  title: "Find the answer",
  goal: "Find the answer",
  goalVersion: 1,
  coordinatorBotId: "coord",
  participantBotIds: ["coord", "res"],
  status: "queued",
  result: null,
  error: null,
  cancelReason: null,
  cancelRequestedAt: null,
  createdAt: time(1),
  updatedAt: time(1),
  finishedAt: null,
};
const taskRunning: Task = {
  ...taskQueued,
  status: "running",
  updatedAt: time(4),
};
const taskCompleted: Task = {
  ...taskRunning,
  status: "completed",
  result: "The answer is 42.",
  updatedAt: time(30),
  finishedAt: time(30),
};

const s1Queued: ExecutionSession = {
  id: "s1",
  taskId: "t1",
  botId: "coord",
  parentSessionId: null,
  role: "coordinator",
  brief: "Find the answer",
  goalVersion: 1,
  depth: 0,
  status: "queued",
  waitingFor: null,
  result: null,
  error: null,
  activity: null,
  runCount: 0,
  createdAt: time(3),
  updatedAt: time(3),
  startedAt: null,
  finishedAt: null,
};
const s1Running = {
  ...s1Queued,
  status: "running",
  runCount: 1,
  startedAt: time(6),
  updatedAt: time(6),
} satisfies ExecutionSession;
const s1Waiting = {
  ...s1Running,
  status: "waiting",
  waitingFor: "delegations",
  updatedAt: time(13),
} satisfies ExecutionSession;
const s1Woken = {
  ...s1Waiting,
  status: "running",
  waitingFor: null,
  runCount: 2,
  updatedAt: time(25),
} satisfies ExecutionSession;
const s1Done = {
  ...s1Woken,
  status: "completed",
  result: "The answer is 42.",
  updatedAt: time(29),
  finishedAt: time(29),
} satisfies ExecutionSession;

const s2Queued: ExecutionSession = {
  ...s1Queued,
  id: "s2",
  botId: "res",
  parentSessionId: "s1",
  role: "worker",
  brief: "Look it up",
  depth: 1,
  createdAt: time(10),
  updatedAt: time(10),
};
const s2Running = {
  ...s2Queued,
  status: "running",
  runCount: 1,
  startedAt: time(16),
  updatedAt: time(16),
} satisfies ExecutionSession;
const s2Done = {
  ...s2Running,
  status: "completed",
  result: "42",
  updatedAt: time(22),
  finishedAt: time(22),
} satisfies ExecutionSession;

const message = (
  id: string,
  sequence: number,
  fields: Partial<TaskMessage>,
): TaskMessage => ({
  id,
  taskId: "t1",
  sequence,
  authorKind: "bot",
  authorBotId: "coord",
  sessionId: "s1",
  intent: "discussion",
  text: "",
  recipientBotIds: [],
  createdAt: time(sequence),
  ...fields,
});
const m1 = message("m1", 1, {
  authorKind: "user",
  authorBotId: null,
  sessionId: null,
  intent: "steering",
  text: "Find the answer",
  recipientBotIds: ["coord"],
});
const m2 = message("m2", 2, {
  intent: "assignment",
  text: "Look it up",
  recipientBotIds: ["res"],
});
const m3 = message("m3", 3, {
  authorBotId: "res",
  sessionId: "s2",
  intent: "result",
  text: "42",
  recipientBotIds: ["coord"],
});
const m4 = message("m4", 4, {
  intent: "result",
  text: "The answer is 42.",
});
const artifact = {
  id: "a1",
  taskId: "t1",
  sessionId: "s2",
  runId: "r2",
  kind: "output" as const,
  path: "bash output",
  name: "npm-test.log",
  contentType: "text/plain",
  sizeBytes: 90_000,
  sha256: "b".repeat(64),
  createdAt: time(20),
};

// --- The task's event log. ---
const log: ParsedTaskEvent[] = [];
const emit = <Type extends TaskEventType>(
  type: Type,
  payload: TaskEventOf<Type>["payload"],
  sessionId: "s1" | "s2" | null = null,
) => {
  const sequence = log.length + 1;
  log.push(
    parseTaskEvent({
      id: `e${sequence}`,
      taskId: "t1",
      sequence,
      type,
      occurredAt: time(sequence),
      botId: sessionId === "s1" ? "coord" : sessionId === "s2" ? "res" : null,
      sessionId,
      runId: sessionId && `r${sessionId.slice(1)}`,
      causedBy: null,
      payload,
    }),
  );
};
const model = "anthropic/claude-x";

emit("task.created", { task: taskQueued }); // 1
emit("message.posted", { message: m1 }); // 2
emit("session.created", { session: s1Queued }, "s1"); // 3
emit("task.updated", { task: taskRunning, previousStatus: "queued" }); // 4
emit("run.started", { reason: "start" }, "s1"); // 5
emit("session.updated", { session: s1Running, previousStatus: "queued" }, "s1"); // 6
emit("model.started", {}, "s1"); // 7
emit("model.finished", { model, stopReason: "toolUse", usage: u1 }, "s1"); // 8
emit(
  "tool.started",
  { toolCallId: "c1", tool: "delegate", summary: "Researcher" },
  "s1",
); // 9
emit("session.created", { session: s2Queued }, "s2"); // 10
emit("message.posted", { message: m2 }); // 11
emit(
  "tool.finished",
  {
    toolCallId: "c1",
    tool: "delegate",
    summary: "Researcher",
    ok: true,
    output: "Delegated",
    truncated: false,
  },
  "s1",
); // 12
emit(
  "session.updated",
  { session: s1Waiting, previousStatus: "running" },
  "s1",
); // 13
emit("run.finished", { outcome: "waiting" }, "s1"); // 14
emit("run.started", { reason: "start" }, "s2"); // 15
emit("session.updated", { session: s2Running, previousStatus: "queued" }, "s2"); // 16
emit("model.started", {}, "s2"); // 17
emit(
  "tool.started",
  { toolCallId: "c2", tool: "bash", summary: "npm test" },
  "s2",
); // 18
emit(
  "tool.finished",
  {
    toolCallId: "c2",
    tool: "bash",
    summary: "npm test",
    ok: true,
    exitCode: 0,
    interrupted: "no",
    output: "passed",
    truncated: true,
    artifactId: "a1",
  },
  "s2",
); // 19
emit("artifact.created", { artifact }, "s2"); // 20
emit("model.finished", { model, stopReason: "stop", usage: u2 }, "s2"); // 21
emit("session.updated", { session: s2Done, previousStatus: "running" }, "s2"); // 22
emit("message.posted", { message: m3 }, "s2"); // 23
log.push(
  parseTaskEvent({
    id: "e24",
    taskId: "t1",
    sequence: 24,
    type: "bot.waved",
    occurredAt: time(24),
    botId: "coord",
    sessionId: "s1",
    runId: null,
    causedBy: null,
    payload: {},
  }),
); // 24: a type from a newer server
emit("session.updated", { session: s1Woken, previousStatus: "waiting" }, "s1"); // 25
emit("model.started", {}, "s1"); // 26
emit("model.finished", { model, stopReason: "toolUse", usage: u3 }, "s1"); // 27
emit(
  "tool.started",
  { toolCallId: "c3", tool: "complete_task", summary: "" },
  "s1",
); // 28
emit("session.updated", { session: s1Done, previousStatus: "running" }, "s1"); // 29
emit("task.updated", { task: taskCompleted, previousStatus: "running" }); // 30
emit("task.finished", {
  status: "completed",
  result: taskCompleted.result,
  error: null,
}); // 31
emit("message.posted", { message: m4 }, "s1"); // 32

/** Snapshot events drop output previews; that is the one permitted difference. */
const withoutPreviews = (view: TaskView): TaskView => ({
  ...view,
  events: view.events.map((event) => {
    if (event.type !== "tool.finished") return event;
    const { output: _output, ...payload } = event.payload;
    return { ...event, payload };
  }),
});

/** Builds a snapshot the way the server serves it: wire JSON, parsed by the contract. */
const snapshot = (
  fields: Omit<TaskView, "events" | "firstSequence" | "hasEarlier" | "cursor">,
  cursor: number,
): TaskView =>
  taskViewSchema.parse(
    JSON.parse(
      JSON.stringify(
        withoutPreviews({
          ...fields,
          events: log
            .slice(0, cursor)
            .filter(
              (event): event is Exclude<ParsedTaskEvent, { unknown: true }> =>
                !("unknown" in event),
            ),
          firstSequence: 1,
          hasEarlier: false,
          cursor,
        }),
      ),
    ),
  );

// Hand-written server snapshots: records, derived activity and usage at each cursor.
const viewAt14 = snapshot(
  {
    task: taskRunning,
    sessions: [
      {
        ...s1Waiting,
        activity: {
          kind: "waiting",
          text: "Waiting on delegated work",
          since: time(13),
        },
      },
      s2Queued,
    ],
    messages: [m1, m2],
    artifacts: [],
    usage: { total: u1, bySession: { s1: u1 } },
  },
  14,
);
const viewAt32 = snapshot(
  {
    task: taskCompleted,
    sessions: [s1Done, s2Done],
    messages: [m1, m2, m3, m4],
    artifacts: [artifact],
    usage: {
      total: addUsage(addUsage(u1, u2), u3),
      bySession: { s1: addUsage(u1, u3), s2: u2 },
    },
  },
  32,
);

const fold = (view: TaskView, events: readonly ParsedTaskEvent[]) =>
  events.reduce(applyTaskEvent, view);

describe("applyTaskEvent", () => {
  it("keeps a snapshot plus the stream equal to the later snapshot", () => {
    expect(log).toHaveLength(32);
    const live = fold(viewAt14, log.slice(14));
    expect(withoutPreviews(live)).toEqual(viewAt32);
    // Streamed events keep their previews.
    expect(live.events.find((event) => event.sequence === 19)).toMatchObject({
      payload: { output: "passed" },
    });
  });

  it("reaches the same view from the first event", () => {
    const initial = snapshot(
      {
        task: taskQueued,
        sessions: [],
        messages: [],
        artifacts: [],
        usage: { total: emptyUsage(), bySession: {} },
      },
      1,
    );
    expect(withoutPreviews(fold(initial, log.slice(1, 14)))).toEqual(viewAt14);
    expect(withoutPreviews(fold(initial, log.slice(1)))).toEqual(viewAt32);
  });

  it("shows the live activity of each session mid-run", () => {
    const at18 = fold(viewAt14, log.slice(14, 18));
    expect(at18.sessions.map((session) => session.activity?.text)).toEqual([
      "Waiting on delegated work",
      "Running `npm test`",
    ]);
  });

  it("ignores replayed events and skips unknown types", () => {
    const live = fold(viewAt14, log.slice(14));
    expect(fold(live, log)).toBe(live);
    const at24 = fold(viewAt14, log.slice(14, 24));
    expect(at24.cursor).toBe(24);
    expect(at24.events.at(-1)?.sequence).toBe(23);
  });

  it("keeps only the latest events and reports earlier ones", () => {
    const busy = Array.from(
      { length: TASK_VIEW_EVENT_LIMIT + 100 },
      (_, index) =>
        parseTaskEvent({
          id: `busy${index}`,
          taskId: "t1",
          sequence: 33 + index,
          type: "model.started",
          occurredAt: time(33),
          botId: "coord",
          sessionId: "s1",
          runId: "r1",
          causedBy: null,
          payload: {},
        }),
    );
    const view = fold(viewAt32, busy);
    expect(view.events).toHaveLength(TASK_VIEW_EVENT_LIMIT);
    expect(view.cursor).toBe(32 + TASK_VIEW_EVENT_LIMIT + 100);
    expect(view.firstSequence).toBe(view.cursor - TASK_VIEW_EVENT_LIMIT + 1);
    expect(view.hasEarlier).toBe(true);
    expect(taskViewSchema.safeParse(view).success).toBe(true);
  });

  it("drops unknown event types from a snapshot instead of failing it", () => {
    const wire = JSON.parse(JSON.stringify(viewAt14));
    wire.events.push({
      ...wire.events[0],
      id: "e99",
      sequence: 15,
      type: "bot.waved",
      payload: {},
    });
    const parsed = taskViewSchema.parse(wire);
    expect(parsed.events).toHaveLength(viewAt14.events.length);
    wire.events.push({
      ...wire.events[0],
      id: "e98",
      type: "task.updated",
      payload: {},
    });
    expect(taskViewSchema.safeParse(wire).success).toBe(false);
  });
});
