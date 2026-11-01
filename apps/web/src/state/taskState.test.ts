import {
  emptyUsage,
  type Task,
  type TaskMessage,
  type TaskView,
} from "@jj/contracts";
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import {
  applyOverlay,
  hintNeedsTaskList,
  overlayMessage,
  overlayTask,
  pruneOverlay,
  taskProblem,
} from "./taskState";

const T0 = "2026-10-31T12:00:00.000Z";
const T1 = "2026-10-31T12:01:00.000Z";

const task: Task = {
  id: "task-1",
  title: "Check the stream",
  goal: "Check the stream",
  goalVersion: 1,
  coordinatorBotId: "bot-a",
  participantBotIds: ["bot-a"],
  status: "running",
  result: null,
  error: null,
  cancelReason: null,
  cancelRequestedAt: null,
  createdAt: T0,
  updatedAt: T0,
  finishedAt: null,
};

const message = (sequence: number): TaskMessage => ({
  id: `m${sequence}`,
  taskId: "task-1",
  sequence,
  authorKind: "user",
  authorBotId: null,
  sessionId: null,
  intent: "steering",
  text: `message ${sequence}`,
  recipientBotIds: ["bot-a"],
  createdAt: T0,
});

const view = (messages: TaskMessage[], current: Task = task): TaskView => ({
  task: current,
  sessions: [],
  messages,
  artifacts: [],
  usage: { total: emptyUsage(), bySession: {} },
  events: [],
  firstSequence: 1,
  hasEarlier: false,
  cursor: messages.length,
});

describe("task load problems", () => {
  it("marks NOT_FOUND and UNAUTHORIZED as terminal and the rest as retryable", () => {
    expect(taskProblem("t", new ApiError("NOT_FOUND", "gone")).terminal).toBe(
      true,
    );
    expect(
      taskProblem("t", new ApiError("UNAUTHORIZED", "token")).terminal,
    ).toBe(true);
    expect(
      taskProblem("t", new ApiError("NETWORK_ERROR", "offline")).terminal,
    ).toBe(false);
    expect(
      taskProblem("t", new ApiError("INVALID_RESPONSE", "bad frame")).terminal,
    ).toBe(false);
  });
});

describe("refetch amplification", () => {
  it("skips task-list refetches for the task being streamed", () => {
    const hint = { type: "tasks.changed", taskId: "task-1" } as const;
    expect(hintNeedsTaskList(hint, "task-1")).toBe(false);
    expect(hintNeedsTaskList(hint, "task-2")).toBe(true);
    expect(hintNeedsTaskList(hint, null)).toBe(true);
    expect(hintNeedsTaskList({ type: "bots.changed" }, null)).toBe(false);
  });
});

describe("optimistic task updates", () => {
  it("shows a posted message at once, once, in sequence order", () => {
    const streamed = view([message(1)]);
    let overlay = overlayMessage(undefined, message(2));
    overlay = overlayMessage(overlay, message(2)); // a retry returns the same record
    const shown = applyOverlay(streamed, overlay);
    expect(shown.messages.map((m) => m.id)).toEqual(["m1", "m2"]);
    // The stream delivers it: the overlay is spent and nothing is duplicated.
    const caughtUp = view([message(1), message(2)]);
    expect(pruneOverlay(caughtUp, overlay)).toBeNull();
    expect(applyOverlay(caughtUp, overlay).messages).toHaveLength(2);
  });

  it("shows a stop request's task until the stream reflects it", () => {
    const stopping: Task = {
      ...task,
      cancelRequestedAt: T1,
      updatedAt: T1,
    };
    const overlay = overlayTask(undefined, stopping);
    expect(applyOverlay(view([]), overlay).task.cancelRequestedAt).toBe(T1);
    // A newer or equal streamed record wins and the overlay is dropped.
    expect(pruneOverlay(view([], stopping), overlay)).toBeNull();
    const later = { ...stopping, status: "cancelled" as const, updatedAt: T1 };
    expect(applyOverlay(view([], later), overlay).task.status).toBe(
      "cancelled",
    );
  });

  it("returns the same view and overlay when nothing is pending", () => {
    const streamed = view([message(1)]);
    expect(applyOverlay(streamed, undefined)).toBe(streamed);
    const overlay = overlayMessage(undefined, message(2));
    expect(pruneOverlay(streamed, overlay)).toBe(overlay);
  });
});
