import { emptyUsage, type TaskMessage, type TaskView } from "@jj/contracts";
import { describe, expect, it } from "vitest";
import { followTask, type TaskEventHandlers } from "./follow";

const at = "2026-11-03T00:00:00.000Z";
const task: TaskView["task"] = {
  id: "task-1",
  title: "Long answer",
  goal: "Long answer",
  goalVersion: 1,
  coordinatorBotId: "bot-1",
  participantBotIds: ["bot-1"],
  status: "running",
  result: null,
  error: null,
  cancelReason: null,
  cancelRequestedAt: null,
  verificationPlan: null,
  spendCapUsd: null,
  createdAt: at,
  updatedAt: at,
  finishedAt: null,
};
const message = (text: string): TaskMessage => ({
  id: "m1",
  taskId: "task-1",
  sequence: 1,
  authorKind: "bot",
  authorBotId: "bot-1",
  sessionId: null,
  intent: "discussion",
  text,
  recipientBotIds: [],
  createdAt: at,
});
const view = (messages: TaskMessage[], cursor: number): TaskView => ({
  task,
  sessions: [],
  messages,
  artifacts: [],
  approvals: [],
  verificationChecks: [],
  usage: { total: emptyUsage(), bySession: {} },
  events: [],
  firstSequence: 1,
  hasEarlier: false,
  cursor,
  compactedThrough: 0,
});
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("followTask", () => {
  it("folds an event whose payload arrived clipped, then reloads the view whole and resumes after it", async () => {
    const whole = "x".repeat(300_000);
    const snapshots = [view([], 1), view([message(whole)], 2)];
    const loads: number[] = [];
    const opened: { after: number; handlers: TaskEventHandlers }[] = [];
    const views: TaskView[] = [];
    const stop = followTask(
      "task-1",
      async () => {
        loads.push(Date.now());
        return snapshots.shift() ?? view([], 0);
      },
      (_id, after, handlers) => {
        opened.push({ after, handlers });
        handlers.onOpen();
        return () => {};
      },
      (next) => views.push(next),
      { retryMs: 5 },
    );
    await tick();
    expect(opened.map((entry) => entry.after)).toEqual([1]);
    opened[0]?.handlers.onEvent({
      id: "e2",
      taskId: "task-1",
      sequence: 2,
      occurredAt: at,
      botId: "bot-1",
      sessionId: null,
      runId: null,
      causedBy: null,
      payloadArtifactId: "art-9",
      type: "message.posted",
      payload: { message: message("x… [clipped]") },
    });
    // The clipped copy shows at once, then the whole record replaces it.
    expect(views.at(-1)?.messages[0]?.text).toBe("x… [clipped]");
    await tick();
    expect(loads).toHaveLength(2);
    expect(views.at(-1)?.messages[0]?.text).toBe(whole);
    expect(opened.map((entry) => entry.after)).toEqual([1, 2]);
    stop();
  });

  it("does not reload for an ordinary event", async () => {
    let loads = 0;
    const opened: TaskEventHandlers[] = [];
    const stop = followTask(
      "task-1",
      async () => {
        loads += 1;
        return view([], 1);
      },
      (_id, _after, handlers) => {
        opened.push(handlers);
        return () => {};
      },
      () => {},
    );
    await tick();
    opened[0]?.onEvent({
      id: "e2",
      taskId: "task-1",
      sequence: 2,
      occurredAt: at,
      botId: "bot-1",
      sessionId: null,
      runId: null,
      causedBy: null,
      type: "message.posted",
      payload: { message: message("short") },
    });
    await tick();
    expect(loads).toBe(1);
    expect(opened).toHaveLength(1);
    stop();
  });
});
