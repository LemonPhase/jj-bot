// @vitest-environment jsdom
import "../test/dom";
import {
  type Bot,
  emptyUsage,
  type Task,
  type TaskMessage,
  type TaskView,
  type WorkspaceHint,
} from "@jj/contracts";
import { act, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiProvider } from "../api/ApiContext";
import {
  ApiError,
  type HintOptions,
  type JJApi,
  type StreamOptions,
} from "../api/client";
import { createDemoApi } from "../api/demoApi";
import { followTask, type TaskEventHandlers } from "../api/follow";
import { useWorkspace, WorkspaceProvider } from "./WorkspaceContext";

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

const message = (sequence: number, text = `message ${sequence}`) =>
  ({
    id: `m${sequence}`,
    taskId: "task-1",
    sequence,
    authorKind: "bot",
    authorBotId: "bot-a",
    sessionId: null,
    intent: "discussion",
    text,
    recipientBotIds: [],
    createdAt: T0,
  }) satisfies TaskMessage;

const view = (messages: TaskMessage[], cursor: number): TaskView => ({
  task,
  sessions: [],
  messages,
  artifacts: [],
  usage: { total: emptyUsage(), bySession: {} },
  events: [],
  firstSequence: 1,
  hasEarlier: false,
  cursor,
});

const posted = (sequence: number, m: TaskMessage) => ({
  id: `e${sequence}`,
  taskId: "task-1",
  sequence,
  occurredAt: T0,
  botId: "bot-a",
  sessionId: null,
  runId: null,
  causedBy: null,
  type: "message.posted",
  payload: { message: m },
});

const bot = (id: string): Bot => ({
  id,
  name: id,
  role: "",
  instructions: "",
  model: null,
  runtimeProfileId: null,
  appearance: {
    shape: "round",
    face: "dots",
    topper: "none",
    colour: "teal",
    body: "ivory",
    gait: "hop",
  },
  presence: "idle",
  activeTaskIds: [],
  createdAt: T0,
  updatedAt: T0,
});

/** A workspace API whose streams the test drives by hand. */
function fakeApi(overrides: Partial<JJApi> = {}) {
  const hints: {
    onHint: (hint: WorkspaceHint) => void;
    options?: HintOptions;
  }[] = [];
  const tasks: {
    onView: (view: TaskView) => void;
    options?: StreamOptions;
  }[] = [];
  const base = createDemoApi({ autoplay: false });
  const api: JJApi = {
    ...base,
    bootstrap: async () => ({
      ...(await base.bootstrap()),
      bots: [bot("bot-a"), bot("bot-b")],
      tasks: [],
      profiles: [],
    }),
    subscribeHints: (onHint, options) => {
      hints.push({ onHint, options });
      return () => {};
    },
    subscribeConversation: vi.fn(() => () => {}),
    subscribeTask: vi.fn((_taskId, onView, options) => {
      tasks.push({ onView, options });
      return () => {};
    }),
    listTasks: vi.fn(async () => []),
    ...overrides,
  };
  const hint = (value: WorkspaceHint) =>
    act(() => {
      for (const h of hints) h.onHint(value);
    });
  return { api, hints, tasks, hint };
}

let workspace: ReturnType<typeof useWorkspace>;
function Probe() {
  workspace = useWorkspace();
  return null;
}

async function mount(api: JJApi, children?: ReactNode) {
  render(
    <ApiProvider api={api}>
      <WorkspaceProvider>
        <Probe />
        {children}
      </WorkspaceProvider>
    </ApiProvider>,
  );
  await waitFor(() => expect(workspace.loading).toBe(false));
}

beforeEach(() => {
  window.location.hash = "#/tasks/task-1";
});

describe("WorkspaceContext: task load failures (a)", () => {
  it("shows a terminal failure instead of loading forever", async () => {
    const { api, tasks } = fakeApi();
    await mount(api);
    expect(workspace.taskViews["task-1"]).toBeUndefined();
    act(() =>
      tasks[0]?.options?.onError?.(new ApiError("NOT_FOUND", "No task.")),
    );
    expect(workspace.taskProblem).toMatchObject({
      taskId: "task-1",
      terminal: true,
      error: { code: "NOT_FOUND", message: "No task." },
    });
  });

  it("marks other failures retryable, retries on demand, and clears on the next view", async () => {
    const { api, tasks } = fakeApi();
    await mount(api);
    act(() =>
      tasks[0]?.options?.onError?.(new ApiError("NETWORK_ERROR", "Offline")),
    );
    expect(workspace.taskProblem?.terminal).toBe(false);
    act(() => workspace.retryTask());
    await waitFor(() => expect(api.subscribeTask).toHaveBeenCalledTimes(2));
    act(() => tasks[1]?.onView(view([], 0)));
    expect(workspace.taskProblem).toBeNull();
    expect(workspace.taskViews["task-1"]?.cursor).toBe(0);
  });
});

describe("WorkspaceContext: malformed events (b)", () => {
  it("reloads the snapshot rather than losing the malformed event's change", async () => {
    const snapshots = [
      view([message(1)], 1),
      view([message(1), message(2)], 2),
    ];
    const streams: TaskEventHandlers[] = [];
    const subscribeTask: JJApi["subscribeTask"] = (taskId, onView, options) =>
      followTask(
        taskId,
        async () => snapshots.shift() ?? view([], 0),
        (_id, _after, handlers) => {
          streams.push(handlers);
          handlers.onOpen();
          return () => {};
        },
        onView,
        { retryMs: 5, ...options },
      );
    const { api } = fakeApi({ subscribeTask });
    await mount(api);
    await waitFor(() => expect(streams).toHaveLength(1));
    act(() =>
      streams[0]?.onEvent({ ...posted(2, message(2)), payload: { bad: 1 } }),
    );
    expect(workspace.taskProblem?.error.code).toBe("INVALID_RESPONSE");
    // The view stays on screen while the fresh snapshot loads.
    expect(workspace.taskViews["task-1"]?.cursor).toBe(1);
    await waitFor(() => expect(streams).toHaveLength(2));
    expect(workspace.taskViews["task-1"]?.messages.map((m) => m.id)).toEqual([
      "m1",
      "m2",
    ]);
    expect(workspace.taskProblem).toBeNull();
  });
});

describe("WorkspaceContext: refetch amplification (f)", () => {
  it("debounces task-list hints and skips the streamed task's own", async () => {
    const { api, tasks, hint } = fakeApi();
    await mount(api);
    act(() => tasks[0]?.onView(view([], 0)));
    hint({ type: "tasks.changed", taskId: "task-1" });
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(api.listTasks).not.toHaveBeenCalled();
    hint({ type: "tasks.changed", taskId: "task-2" });
    hint({ type: "tasks.changed", taskId: "task-3" });
    hint({ type: "tasks.changed", taskId: "task-2" });
    await waitFor(() => expect(api.listTasks).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 260));
    expect(api.listTasks).toHaveBeenCalledTimes(1);
  });

  it("keeps the newest bot list and conversation subscriptions across reorders", async () => {
    const answers: ((bots: Bot[]) => void)[] = [];
    const listBots = vi.fn(
      () => new Promise<Bot[]>((resolve) => answers.push(resolve)),
    );
    const { api, hint } = fakeApi({ listBots });
    await mount(api);
    expect(api.subscribeConversation).toHaveBeenCalledTimes(2);
    hint({ type: "bots.changed" });
    await waitFor(() => expect(listBots).toHaveBeenCalledTimes(1));
    hint({ type: "bots.changed" });
    await waitFor(() => expect(listBots).toHaveBeenCalledTimes(2));
    // The newer answer (same bots, reordered) lands first; the older one must not win.
    await act(async () => answers[1]?.([bot("bot-b"), bot("bot-a")]));
    await act(async () => answers[0]?.([bot("bot-a")]));
    expect(workspace.bots.map((b) => b.id)).toEqual(["bot-b", "bot-a"]);
    expect(api.subscribeConversation).toHaveBeenCalledTimes(2);
  });
});

describe("WorkspaceContext: optimistic updates (h)", () => {
  it("shows a posted message at once, once", async () => {
    const stored = { ...message(2, "Keep going"), authorKind: "user" as const };
    const { api, tasks } = fakeApi({
      postTaskMessage: vi.fn(async () => stored),
    });
    await mount(api);
    act(() => tasks[0]?.onView(view([message(1)], 1)));
    let result: Awaited<ReturnType<typeof workspace.postTaskMessage>> | null =
      null;
    await act(async () => {
      result = await workspace.postTaskMessage("task-1", "Keep going", false);
    });
    expect(result).toEqual({ ok: true });
    expect(workspace.taskViews["task-1"]?.messages.map((m) => m.id)).toEqual([
      "m1",
      "m2",
    ]);
    // An unrelated event arrives before message.posted: the message stays.
    act(() => tasks[0]?.onView({ ...view([message(1)], 1), cursor: 2 }));
    expect(workspace.taskViews["task-1"]?.messages).toHaveLength(2);
    // The stream delivers it: still exactly one copy.
    act(() => tasks[0]?.onView(view([message(1), stored], 3)));
    expect(workspace.taskViews["task-1"]?.messages).toHaveLength(2);
  });

  it("shows stopping at once and reports a failed post in place", async () => {
    const stopping = { ...task, cancelRequestedAt: T1, updatedAt: T1 };
    const { api, tasks } = fakeApi({
      stopTask: vi.fn(async () => stopping),
      postTaskMessage: vi.fn(async () => {
        throw new ApiError("STALE_GOAL_VERSION", "Goal is at v3.");
      }),
    });
    await mount(api);
    act(() => tasks[0]?.onView(view([], 0)));
    await act(async () => {
      await workspace.stopTask("task-1");
    });
    expect(workspace.taskViews["task-1"]?.task.cancelRequestedAt).toBe(T1);
    let result: Awaited<ReturnType<typeof workspace.postTaskMessage>> | null =
      null;
    await act(async () => {
      result = await workspace.postTaskMessage("task-1", "New goal", true);
    });
    expect(result).toMatchObject({
      ok: false,
      error: { code: "STALE_GOAL_VERSION" },
    });
    expect(api.postTaskMessage).toHaveBeenCalledWith("task-1", {
      text: "New goal",
      goal: "New goal",
      observedGoalVersion: 1,
    });
  });
});
