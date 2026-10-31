import { BackendService } from "@jj/backend";
import {
  type Bot,
  type Task,
  type TaskEvent,
  taskViewSchema,
} from "@jj/contracts";
import type { SessionRecord, TaskRecord } from "@jj/contracts/backend";
import { type BackendStore, openStore } from "@jj/db";
import {
  type ExecutorInput,
  GeminiSessionExecutor,
  type InteractionClient,
  type SessionExecutor,
} from "@jj/runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app";

const verificationPlan = [
  {
    id: "answer",
    description: "Return 42",
    method: "Literal check",
    expectedEvidence: "The output contains 42",
  },
];
const executors: ExecutorInput[] = [];
const fakeExecutor: SessionExecutor = {
  async execute(input) {
    input.signal.throwIfAborted();
    executors.push(input);
    await input.emit({
      type: "verification.recorded",
      payload: {
        criterionId: "answer",
        outcome: "passed",
        evidence: ["Output contains 42"],
      },
    });
    return {
      summary: "42",
      checks: input.session.verificationPlan.map((criterion) => ({
        criterionId: criterion.id,
        taskId: input.session.taskId,
        sessionId: input.session.id,
        goalVersion: input.session.goalVersion,
        outcome: "passed" as const,
        evidence: ["Output contains 42"],
      })),
    };
  },
};
let store: BackendStore;
let service: BackendService;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  executors.length = 0;
  store = await openStore({ mode: "pglite", path: "memory://" });
  service = new BackendService({
    store,
    executor: fakeExecutor,
    concurrency: 3,
  });
  app = createApp({
    agentUrl: "http://127.0.0.1:3001/api/agent",
    modelConfigured: true,
    service,
  });
});
afterEach(async () => {
  await service.stop();
  await store.close();
});
async function request(path: string, body?: unknown, method = "POST") {
  return app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function bot(name = "Researcher"): Promise<Bot> {
  const response = await request("/api/bots", {
    name,
    instructions: `You are ${name}.`,
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<Bot>;
}
async function task(bots: Bot[], autoStart = true): Promise<TaskRecord> {
  const response = await request("/api/tasks", {
    goal: "Add 19 and 23",
    coordinatorBotId: bots[0]?.id,
    participantBotIds: bots.map((item) => item.id),
    verificationPlan,
    checks: [{ id: "answer", kind: "contains", value: "42" }],
    autoStart,
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<TaskRecord>;
}
async function finish(taskId: string) {
  for (let attempt = 0; attempt < 12; attempt++) {
    await service.tick();
    const value = await service.getTask(taskId);
    if (["completed", "failed", "cancelled", "waiting"].includes(value.status))
      return value;
  }
  throw new Error("Task did not reach a terminal result");
}

describe("backend HTTP integration", () => {
  it("creates bots and tasks and returns a real multi-session verified snapshot", async () => {
    const first = await bot("Coordinator");
    const second = await bot("Researcher");
    const third = await bot("Reviewer");
    const created = await task([first, second, third]);
    expect((await finish(created.id)).status).toBe("completed");
    const response = await app.request(`/api/tasks/${created.id}`);
    expect(response.status).toBe(200);
    const snapshot = (await response.json()) as {
      task: TaskRecord;
      sessions: SessionRecord[];
      checks: unknown[];
      events: TaskEvent[];
    };
    expect(snapshot.task.result).toBe("42");
    expect(
      new Set(snapshot.sessions.map((session) => session.botId)).size,
    ).toBe(3);
    expect(
      snapshot.sessions.filter((session) => session.kind === "work"),
    ).toHaveLength(3);
    expect(
      snapshot.sessions.some((session) => session.kind === "synthesis"),
    ).toBe(true);
    expect(snapshot.checks.length).toBeGreaterThanOrEqual(4);
    expect(
      snapshot.events.some((event) => event.type === "task.finished"),
    ).toBe(true);
    const bootstrap = (await (await app.request("/api/bootstrap")).json()) as {
      mode: string;
      capabilities: Record<string, boolean>;
      bots: Bot[];
      tasks: Task[];
    };
    expect(bootstrap.mode).toBe("backend");
    expect(bootstrap.capabilities.persistence).toBe(true);
    expect(bootstrap.bots).toHaveLength(3);
    expect(bootstrap.tasks.some((item) => item.id === created.id)).toBe(true);
  });

  it("keeps explicit bot memory scoped and records bot conversations", async () => {
    const first = await bot("Alpha");
    const second = await bot("Beta");
    expect(
      (
        await request(
          `/api/bots/${first.id}/memory`,
          { text: "Alpha-private-memory" },
          "PUT",
        )
      ).status,
    ).toBe(200);
    const other = (await (
      await app.request(`/api/bots/${second.id}/memory`)
    ).json()) as { memory: { text: string } };
    expect(other.memory.text).toBe("");
    const response = await request(`/api/bots/${first.id}/messages`, {
      text: "Add 19 and 23",
      participantBotIds: [first.id, second.id],
      verificationPlan,
      checks: [{ id: "answer", kind: "contains", value: "42" }],
    });
    expect(response.status).toBe(202);
    const created = (await response.json()) as { task: TaskRecord };
    await finish(created.task.id);
    const conversation = (await (
      await app.request(`/api/bots/${first.id}/messages`)
    ).json()) as { messages: { role: string; text: string }[] };
    expect(
      conversation.messages.some(
        (message) =>
          message.role === "user" && message.text === "Add 19 and 23",
      ),
    ).toBe(true);
    expect(
      executors.find((input) => input.bot.id === first.id)?.context,
    ).toContain("Alpha-private-memory");
    expect(
      executors.find((input) => input.bot.id === second.id)?.context,
    ).not.toContain("Alpha-private-memory");
  });

  it("stores shared notifications without waking bots and rejects nonparticipants", async () => {
    const first = await bot("One");
    const second = await bot("Two");
    const outsider = await bot("Outsider");
    const created = await task([first, second], false);
    const notification = await request(`/api/tasks/${created.id}/messages`, {
      authorId: "user",
      authorKind: "user",
      text: "For reference",
      intent: "notification",
      activateBotIds: [],
    });
    expect(notification.status).toBe(201);
    const snapshot = await service.snapshot(created.id);
    expect(snapshot.messages).toHaveLength(1);
    expect(snapshot.sessions).toHaveLength(0);
    expect(await service.tick()).toBe(0);
    expect(
      (
        await request(`/api/tasks/${created.id}/messages`, {
          authorId: "user",
          authorKind: "user",
          text: "Wake outsider",
          intent: "assignment",
          activateBotIds: [outsider.id],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(`/api/tasks/${created.id}/sessions`, {
          botId: outsider.id,
          brief: "Do work",
          verificationPlan,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request(`/api/tasks/${created.id}/coordinator`, {
          botId: outsider.id,
        })
      ).status,
    ).toBe(400);
    const activate = await request(`/api/tasks/${created.id}/messages`, {
      authorId: "user",
      authorKind: "user",
      text: "Answer now",
      intent: "assignment",
      activateBotIds: [second.id],
    });
    expect(activate.status).toBe(201);
    expect(
      (await service.snapshot(created.id)).sessions.map(
        (session) => session.botId,
      ),
    ).toEqual([second.id]);
  });

  it("returns clear validation, malformed JSON, missing resource and cursor errors", async () => {
    expect(
      (await request("/api/bots", { name: "Missing instructions" })).status,
    ).toBe(400);
    const invalid = await app.request("/api/bots", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{",
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toEqual({ error: "INVALID_JSON" });
    expect((await app.request("/api/bots/missing")).status).toBe(404);
    expect((await app.request("/api/tasks/missing")).status).toBe(404);
    const first = await bot();
    const created = await task([first], false);
    expect(
      (await app.request(`/api/tasks/${created.id}/events?after=-1`)).status,
    ).toBe(400);
    expect(
      (
        await request("/api/tasks", {
          goal: "G",
          coordinatorBotId: first.id,
          participantBotIds: [first.id, first.id],
          verificationPlan,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request("/api/tasks", {
          goal: "G",
          coordinatorBotId: "outsider",
          participantBotIds: [first.id],
          verificationPlan,
        })
      ).status,
    ).toBe(400);
  });

  it("replays ordered events and closes SSE for a completed task without rerunning it", async () => {
    const first = await bot();
    const created = await task([first]);
    await finish(created.id);
    const before = executors.length;
    const all = await store.events(created.id);
    const response = await app.request(
      `/api/tasks/${created.id}/events?after=1`,
    );
    const replay = (await response.json()) as { events: TaskEvent[] };
    expect(replay.events.map((event) => event.sequence)).toEqual(
      all.filter((event) => event.sequence > 1).map((event) => event.sequence),
    );
    const stream = await app.request(`/api/tasks/${created.id}/stream`, {
      headers: { "Last-Event-ID": "1" },
    });
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const text = await stream.text();
    expect(text).toContain("event: task.finished");
    expect(text).not.toContain("id: 1\n");
    expect(executors).toHaveLength(before);
  });

  it("enforces configured API authentication and emits AG-UI lifecycle/output for a durable task", async () => {
    const secured = createApp({
      agentUrl: "http://127.0.0.1:3001/api/agent",
      modelConfigured: true,
      service,
      apiToken: "test-only-token",
    });
    expect((await secured.request("/health")).status).toBe(200);
    expect((await secured.request("/api/bootstrap")).status).toBe(401);
    expect(
      (
        await secured.request("/api/bootstrap", {
          headers: { Authorization: "Bearer wrong" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await secured.request("/api/bootstrap", {
          headers: { Authorization: "Bearer test-only-token" },
        })
      ).status,
    ).toBe(200);
    const first = await bot();
    const created = await task([first]);
    await finish(created.id);
    const stream = await secured.request("/api/agent", {
      method: "POST",
      headers: {
        Authorization: "Bearer test-only-token",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        threadId: "thread-one",
        runId: "run-one",
        messages: [],
        forwardedProps: { taskId: created.id },
      }),
    });
    expect(stream.status).toBe(200);
    const events = (await stream.text())
      .split("\n\n")
      .filter(Boolean)
      .map(
        (chunk) =>
          JSON.parse(chunk.replace(/^data: /, "")) as {
            type: string;
            delta?: string;
          },
      );
    expect(events[0]?.type).toBe("RUN_STARTED");
    expect(
      events.some(
        (event) =>
          event.type === "TEXT_MESSAGE_CONTENT" && event.delta === "42",
      ),
    ).toBe(true);
    expect(events.at(-1)?.type).toBe("RUN_FINISHED");
  });
  it("steers a task through versioned sessions, transfers coordination and cancels queued work", async () => {
    const first = await bot("Lead");
    const second = await bot("Partner");
    const created = await task([first, second], false);
    const transfer = await request(`/api/tasks/${created.id}/coordinator`, {
      botId: second.id,
    });
    expect(transfer.status).toBe(200);
    expect(((await transfer.json()) as TaskRecord).coordinatorBotId).toBe(
      second.id,
    );
    const steered = await request(`/api/tasks/${created.id}/steer`, {
      text: "Use the updated requirement",
      goal: "Return 42 after review",
      observedGoalVersion: 1,
    });
    expect(steered.status).toBe(200);
    const changed = (await steered.json()) as TaskRecord;
    expect(changed.goalVersion).toBe(2);
    expect(changed.goal).toBe("Return 42 after review");
    const staleSteer = await request(`/api/tasks/${created.id}/steer`, {
      text: "Stale steering request",
      observedGoalVersion: 1,
    });
    expect(staleSteer.status).toBe(409);
    const viewRes = await app.request(`/api/tasks/${created.id}/view`);
    expect(viewRes.status).toBe(200);
    const pending = taskViewSchema.parse(await viewRes.json());
    expect(pending.replayCursor).toBeGreaterThan(0);
    expect(pending.participants).toHaveLength(2);
    expect(pending.sessions).toHaveLength(2);
    expect(pending.sessions.every((session) => session.goalVersion === 2)).toBe(
      true,
    );
    expect(
      pending.messages.some((message) => message.intent === "steering"),
    ).toBe(true);
    const cancelled = await request(`/api/tasks/${created.id}/stop`, {
      reason: "Stopped from UI",
    });
    expect(cancelled.status).toBe(200);
    expect(((await cancelled.json()) as TaskRecord).status).toBe("cancelled");
    expect(await service.tick()).toBe(0);
    expect(
      (await service.snapshot(created.id)).sessions.every(
        (session) => session.status === "cancelled",
      ),
    ).toBe(true);
    expect(
      (
        await request(`/api/tasks/${created.id}/sessions`, {
          botId: first.id,
          brief: "Must not launch",
          verificationPlan,
        })
      ).status,
    ).toBe(409);
  });

  it("executes the full bot-chat -> tool-call -> verification -> stream -> view -> steer -> stop workflow with GeminiSessionExecutor", async () => {
    const mockClient: InteractionClient = {
      async create(params) {
        const input = params.input;
        const hasToolResult =
          Array.isArray(input) &&
          input.some((item) => item.type === "function_result");
        if (!hasToolResult && params.tools && params.tools.length > 0) {
          return {
            status: "requires_action",
            steps: [
              {
                type: "function_call",
                id: "call-add",
                name: "add_numbers",
                arguments: { a: 19, b: 23 },
              },
            ],
          };
        }
        return {
          status: "completed",
          output_text: "19 + 23 = 42",
          steps: [],
        };
      },
    };
    const realExecutor = new GeminiSessionExecutor({
      apiKey: "test-key",
      client: mockClient,
      model: "gemini-test",
    });
    const fullService = new BackendService({
      store,
      executor: realExecutor,
      concurrency: 3,
    });
    const fullApp = createApp({
      agentUrl: "http://127.0.0.1:3001/api/agent",
      modelConfigured: true,
      service: fullService,
    });
    const post = (path: string, body?: unknown) =>
      fullApp.request(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

    try {
      const planner = (await (
        await post("/api/bots", {
          name: "Planner",
          instructions: "Solve arithmetic concisely.",
        })
      ).json()) as Bot;
      const reviewer = (await (
        await post("/api/bots", {
          name: "Reviewer",
          instructions: "Verify arithmetic concisely.",
        })
      ).json()) as Bot;
      const observer = (await (
        await post("/api/bots", {
          name: "Observer",
          instructions: "Observe and assist when added.",
        })
      ).json()) as Bot;

      const startRes = await post(`/api/bots/${planner.id}/messages`, {
        text: "Compute 19 + 23 with add_numbers. Include 42 in the final answer.",
        participantBotIds: [planner.id, reviewer.id],
        verificationPlan: [
          {
            id: "includes-42",
            description: "Final response includes 42",
            method: "contains: 42",
            expectedEvidence: "Output contains 42",
          },
        ],
        checks: [{ id: "includes-42", kind: "contains", value: "42" }],
      });
      expect(startRes.status).toBe(202);
      const { task: startedTask } = (await startRes.json()) as {
        task: TaskRecord;
      };

      const addParticipantRes = await post(
        `/api/tasks/${startedTask.id}/participants`,
        { botId: observer.id, activate: false },
      );
      expect(addParticipantRes.status).toBe(200);

      for (let i = 0; i < 10; i++) {
        await fullService.tick();
        const current = await fullService.getTask(startedTask.id);
        if (current.status === "completed") break;
      }

      const streamRes = await fullApp.request(
        `/api/tasks/${startedTask.id}/stream`,
      );
      expect(streamRes.status).toBe(200);
      const streamText = await streamRes.text();
      expect(streamText).toContain("event: task.created");
      expect(streamText).toContain("event: tool.started");
      expect(streamText).toContain("event: tool.finished");
      expect(streamText).toContain("event: verification.recorded");
      expect(streamText).toContain("event: task.finished");

      const viewRes = await fullApp.request(
        `/api/tasks/${startedTask.id}/view`,
      );
      expect(viewRes.status).toBe(200);
      const view = taskViewSchema.parse(await viewRes.json());
      expect(view.task.status).toBe("completed");
      expect(view.task.result).toBe("19 + 23 = 42");
      expect(view.participants).toHaveLength(3);
      expect(view.sessions).toHaveLength(3);
      expect(view.checks).toHaveLength(3);
      expect(view.replayCursor).toBeGreaterThan(0);

      const noteRes = await post(`/api/tasks/${startedTask.id}/messages`, {
        authorKind: "user",
        authorId: "me",
        intent: "notification",
        text: "FYI: keep answers under 3 sentences.",
        activateBotIds: [],
      });
      expect(noteRes.status).toBe(201);

      const steerRes = await post(`/api/tasks/${startedTask.id}/steer`, {
        text: "Now also compute 42 + 8.",
        goal: "Compute 19 + 23 and 42 + 8 using add_numbers.",
      });
      expect(steerRes.status).toBe(200);
      const steered = (await steerRes.json()) as TaskRecord;
      expect(steered.goalVersion).toBe(2);
      expect(steered.status).toBe("running");

      const stopRes = await post(`/api/tasks/${startedTask.id}/stop`, {
        reason: "Manual stop test",
      });
      expect(stopRes.status).toBe(200);
      const stopped = (await stopRes.json()) as TaskRecord & {
        cancelReason?: string;
      };
      expect(stopped.status).toBe("cancelled");
      expect(stopped.cancelReason).toBe("Manual stop test");
    } finally {
      await fullService.stop();
    }
  });
});
