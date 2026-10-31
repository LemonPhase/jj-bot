import type { BackendStore } from "@jj/db";
import { openStore } from "@jj/db";
import {
  type ExecutorInput,
  type ExecutorResult,
  GeminiSessionExecutor,
  type SessionExecutor,
} from "@jj/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { BackendService } from "./service";

const plan = [
  {
    id: "check",
    description: "Includes done",
    method: "contains",
    expectedEvidence: "Output contains done",
  },
];
function passed(input: ExecutorInput): ExecutorResult {
  return {
    summary: "done",
    checks: input.session.verificationPlan.map((criterion) => ({
      criterionId: criterion.id,
      taskId: input.session.taskId,
      sessionId: input.session.id,
      goalVersion: input.session.goalVersion,
      outcome: "passed",
      evidence: ["Checked output contains done"],
    })),
  };
}
const stores: BackendStore[] = [];
const services: BackendService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.stop();
  for (const store of stores.splice(0)) await store.close();
});
async function setup(
  execute: SessionExecutor["execute"] = async (input) => passed(input),
  options: {
    concurrency?: number;
    maxSessions?: number;
    maxDepth?: number;
  } = {},
) {
  const store = await openStore({ mode: "pglite", path: "memory://" });
  stores.push(store);
  const service = new BackendService({
    store,
    executor: { execute },
    leaseMs: 600,
    ...options,
  });
  services.push(service);
  const bots = await Promise.all(
    ["Coordinator", "Researcher", "Reviewer"].map((name) =>
      service.createBot({ name, instructions: `Act as ${name}` }),
    ),
  );
  return { store, service, bots };
}
function inputFor(bots: Awaited<ReturnType<typeof setup>>["bots"]) {
  return {
    goal: "Find and verify the answer",
    coordinatorBotId: bots[0]!.id,
    participantBotIds: bots.map((bot) => bot.id),
    verificationPlan: plan,
    checks: [{ id: "check", kind: "contains" as const, value: "done" }],
  };
}
async function drain(service: BackendService) {
  for (let index = 0; index < 20; index += 1)
    if ((await service.tick()) === 0) return;
  throw new Error("Worker failed to drain within bounded ticks");
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("durable task coordination", () => {
  it("runs an arbitrary roster, scoped sessions and integrated verification", async () => {
    const seen: ExecutorInput[] = [];
    const { service, bots } = await setup(async (input) => {
      seen.push(input);
      return passed(input);
    });
    const task = await service.createTask(inputFor(bots));
    await drain(service);
    const snapshot = await service.snapshot(task.id);
    expect(snapshot.task.status).toBe("completed");
    expect(
      snapshot.sessions.filter((session) => session.kind === "work"),
    ).toHaveLength(3);
    expect(
      snapshot.sessions.filter((session) => session.kind === "synthesis"),
    ).toHaveLength(1);
    expect(new Set(snapshot.sessions.map((session) => session.id)).size).toBe(
      4,
    );
    expect(snapshot.checks.some((check) => check.sessionId === undefined)).toBe(
      true,
    );
    expect(snapshot.checks.filter((check) => check.sessionId)).toHaveLength(3);
    expect(
      seen.every((input) =>
        input.tools?.some((tool) => tool.name === "read_context"),
      ),
    ).toBe(true);
    expect(
      seen.every((input) =>
        input.tools?.some((tool) => tool.name === "add_numbers"),
      ),
    ).toBe(true);
    expect(snapshot.events.map((event) => event.sequence)).toEqual(
      snapshot.events.map((_, index) => index + 1),
    );
    expect((await service.listConversation(bots[0]!.id))[0]?.taskId).toBe(
      task.id,
    );
  });
  it("rejects invalid coordinator membership and duplicate participants", async () => {
    const { service, bots } = await setup();
    await expect(
      service.createTask({ ...inputFor(bots), coordinatorBotId: "outsider" }),
    ).rejects.toThrow();
    await expect(
      service.createTask({
        ...inputFor(bots),
        participantBotIds: [bots[0]!.id, bots[0]!.id],
      }),
    ).rejects.toThrow();
    expect(await service.listTasks()).toHaveLength(0);
  });
  it("persists shared notifications without waking bots, then selectively activates one", async () => {
    const { service, bots } = await setup();
    const task = await service.createTask({
      ...inputFor(bots),
      autoStart: false,
    });
    await service.postMessage(task.id, {
      text: "Context only",
      authorKind: "user",
      authorId: "user",
      intent: "notification",
      activateBotIds: [],
    });
    expect((await service.snapshot(task.id)).sessions).toHaveLength(0);
    expect(await service.tick()).toBe(0);
    await service.postMessage(task.id, {
      text: "Please research",
      authorKind: "user",
      authorId: "user",
      intent: "assignment",
      activateBotIds: [bots[1]!.id],
    });
    const before = await service.snapshot(task.id);
    expect(before.sessions).toHaveLength(1);
    expect(before.sessions[0]?.botId).toBe(bots[1]!.id);
    await expect(
      service.postMessage(task.id, {
        text: "No",
        authorKind: "bot",
        authorId: "outsider",
        intent: "notification",
        activateBotIds: [],
      }),
    ).rejects.toThrow();
  });
  it("keeps bot memory and conversations scoped across tasks", async () => {
    const seen: ExecutorInput[] = [];
    const { service, bots } = await setup(async (input) => {
      seen.push(input);
      return passed(input);
    });
    await service.setMemory(bots[1]!.id, "private researcher memory");
    await service.recordConversation({
      botId: bots[1]!.id,
      role: "user",
      text: "private conversation",
    });
    const task = await service.createTask(inputFor(bots));
    await drain(service);
    expect(seen.find((item) => item.bot.id === bots[1]!.id)?.context).toContain(
      "private researcher memory",
    );
    expect(
      seen
        .filter((item) => item.bot.id !== bots[1]!.id)
        .every((item) => !item.context.includes("private researcher memory")),
    ).toBe(true);
    expect(
      seen.every((item) => !item.context.includes("private conversation")),
    ).toBe(true);
    expect((await service.getMemory(bots[0]!.id)).text).toBe("");
    expect((await service.snapshot(task.id)).task.status).toBe("completed");
  });
  it("does not complete when a local verification check fails or is absent", async () => {
    const { service, bots } = await setup(async (input) => ({
      summary: "unverified",
      checks: input.bot.name === "Reviewer" ? [] : passed(input).checks,
    }));
    const task = await service.createTask(inputFor(bots));
    await drain(service);
    const snapshot = await service.snapshot(task.id);
    expect(snapshot.task.status).toBe("waiting");
    expect(snapshot.task.result).toBeUndefined();
    expect(
      snapshot.sessions.some((session) => session.kind === "synthesis"),
    ).toBe(false);
  });
  it("cancels queued jobs without starting execution", async () => {
    let executed = 0;
    const { service, bots } = await setup(async (input) => {
      executed += 1;
      return passed(input);
    });
    const task = await service.createTask(inputFor(bots));
    await service.cancel(task.id);
    await drain(service);
    const snapshot = await service.snapshot(task.id);
    expect(executed).toBe(0);
    expect(snapshot.task.status).toBe("cancelled");
    expect(
      snapshot.sessions.every((session) => session.status === "cancelled"),
    ).toBe(true);
    await expect(
      service.spawnSession(task.id, {
        botId: bots[0]!.id,
        brief: "later",
        verificationPlan: plan,
      }),
    ).rejects.toThrow("cancelled");
  });
  it("aborts active execution and rejects late results after cancellation", async () => {
    const entered = deferred();
    const release = deferred();
    let signal: AbortSignal | undefined;
    const { service, bots } = await setup(
      async (input) => {
        signal = input.signal;
        entered.resolve();
        await release.promise;
        return passed(input);
      },
      { concurrency: 1 },
    );
    const task = await service.createTask(inputFor(bots));
    const tick = service.tick();
    await entered.promise;
    await service.cancel(task.id);
    expect(signal?.aborted).toBe(true);
    release.resolve();
    await tick;
    const snapshot = await service.snapshot(task.id);
    expect(snapshot.task.status).toBe("cancelled");
    expect(snapshot.task.result).toBeUndefined();
    expect(snapshot.checks).toHaveLength(0);
  });
  it("steering invalidates active results and creates only current-version work", async () => {
    const entered = deferred();
    const release = deferred();
    let first = true;
    const { service, bots } = await setup(
      async (input) => {
        if (first) {
          first = false;
          entered.resolve();
          await release.promise;
        }
        return passed(input);
      },
      { concurrency: 1 },
    );
    const task = await service.createTask(inputFor(bots));
    const tick = service.tick();
    await entered.promise;
    await service.steer(task.id, {
      text: "Use the revised scope",
      goal: "Revised goal",
    });
    release.resolve();
    await tick;
    await drain(service);
    const snapshot = await service.snapshot(task.id);
    expect(snapshot.task.goalVersion).toBe(2);
    expect(snapshot.task.status).toBe("completed");
    expect(snapshot.checks.every((check) => check.goalVersion === 2)).toBe(
      true,
    );
    expect(
      snapshot.sessions
        .filter((session) => session.goalVersion === 1)
        .every((session) => session.status === "cancelled"),
    ).toBe(true);
    expect(
      snapshot.messages.find((message) => message.intent === "steering")
        ?.activateBotIds,
    ).toEqual([task.coordinatorBotId]);
  });
  it("does not accept synthesis while new work is running", async () => {
    const entered = deferred();
    const release = deferred();
    let held = false;
    const { service, bots } = await setup(async (input) => {
      if ((input.session as { kind?: string }).kind === "synthesis" && !held) {
        held = true;
        entered.resolve();
        await release.promise;
      }
      return passed(input);
    });
    const task = await service.createTask(inputFor(bots));
    const run = (async () => {
      while (!held) await service.tick();
    })();
    await entered.promise;
    await service.spawnSession(task.id, {
      botId: bots[1]!.id,
      brief: "Extra work",
      verificationPlan: plan,
    });
    release.resolve();
    await run;
    await drain(service);
    const snapshot = await service.snapshot(task.id);
    expect(snapshot.task.status).toBe("completed");
    expect(
      snapshot.sessions.filter(
        (session) =>
          session.kind === "synthesis" && session.status === "cancelled",
      ),
    ).toHaveLength(1);
    expect(
      snapshot.sessions.filter(
        (session) =>
          session.kind === "synthesis" && session.status === "completed",
      ),
    ).toHaveLength(1);
  });
  it("bounds delegation and preserves same-bot independent sessions", async () => {
    const { service, bots } = await setup(undefined, {
      maxSessions: 5,
      maxDepth: 1,
    });
    const task = await service.createTask({
      ...inputFor(bots),
      autoStart: false,
    });
    const parent = await service.spawnSession(task.id, {
      botId: bots[0]!.id,
      brief: "Parent",
      verificationPlan: plan,
    });
    const child = await service.spawnSession(task.id, {
      botId: bots[0]!.id,
      parentSessionId: parent.id,
      brief: "Child",
      verificationPlan: plan,
    });
    expect(child.id).not.toBe(parent.id);
    await expect(
      service.spawnSession(task.id, {
        botId: bots[0]!.id,
        parentSessionId: child.id,
        brief: "Too deep",
        verificationPlan: plan,
      }),
    ).rejects.toThrow("depth");
    for (let count = 0; count < 3; count += 1)
      await service.spawnSession(task.id, {
        botId: bots[0]!.id,
        brief: "Independent",
        verificationPlan: plan,
      });
    await expect(
      service.spawnSession(task.id, {
        botId: bots[0]!.id,
        brief: "Too many",
        verificationPlan: plan,
      }),
    ).rejects.toThrow("budget");
  });
  it("uses leases to prevent duplicate execution by competing workers", async () => {
    const entered = deferred();
    const release = deferred();
    let calls = 0;
    const { service, store, bots } = await setup(
      async (input) => {
        calls += 1;
        entered.resolve();
        await release.promise;
        return passed(input);
      },
      { concurrency: 1 },
    );
    const peer = new BackendService({
      store,
      executor: {
        execute: async (input) => {
          calls += 1;
          return passed(input);
        },
      },
      concurrency: 1,
    });
    services.push(peer);
    const task = await service.createTask({
      ...inputFor(bots),
      participantBotIds: [bots[0]!.id],
    });
    const running = service.tick();
    await entered.promise;
    expect(await peer.tick()).toBe(0);
    release.resolve();
    await running;
    await drain(peer);
    expect(calls).toBe(2); // one work execution, one integrated synthesis
    expect((await service.snapshot(task.id)).task.status).toBe("completed");
  });
  it("revises a failing session check within budget, rejects inconclusive checks, and verifies synthesis separately", async () => {
    const store = await openStore({ mode: "pglite", path: "memory://" });
    stores.push(store);
    let modelCalls = 0;
    const executor = new GeminiSessionExecutor({
      apiKey: "test-key",
      model: "gemini-test",
      maxRevisions: 1,
      client: {
        async create() {
          modelCalls += 1;
          const text = modelCalls === 1 ? "draft without keyword" : "done";
          return {
            steps: [
              {
                type: "model_output",
                content: [{ type: "text", text }],
              },
            ],
            output_text: text,
            status: "completed",
          };
        },
      },
    });
    const service = new BackendService({ store, executor, concurrency: 1 });
    services.push(service);
    const lead = await service.createBot({
      name: "Lead",
      instructions: "Coordinate",
    });
    const worker = await service.createBot({
      name: "Worker",
      instructions: "Work",
    });
    const task = await service.createTask({
      goal: "Verify revision loop",
      coordinatorBotId: lead.id,
      participantBotIds: [lead.id, worker.id],
      verificationPlan: plan,
      checks: [{ id: "check", kind: "contains", value: "done" }],
    });
    await drain(service);
    const snapshot = await service.snapshot(task.id);
    expect(snapshot.task.status).toBe("completed");
    expect(
      snapshot.events.some((event) => event.type === "session.revising"),
    ).toBe(true);
    expect(snapshot.checks.some((check) => check.sessionId === undefined)).toBe(
      true,
    );
    expect(snapshot.replayCursor).toBe(snapshot.events.at(-1)?.sequence);

    // Inconclusive checks must not allow task completion
    const inconclusiveTask = await service.createTask({
      goal: "Inconclusive regex check",
      coordinatorBotId: lead.id,
      participantBotIds: [lead.id],
      verificationPlan: plan,
      checks: [{ id: "check", kind: "regex", value: "(a|b)" }],
    });
    await drain(service);
    const inconclusiveSnapshot = await service.snapshot(inconclusiveTask.id);
    expect(inconclusiveSnapshot.task.status).toBe("waiting");
    expect(inconclusiveSnapshot.checks[0]?.outcome).toBe("inconclusive");
  });
  it("rejects steering when observedGoalVersion is stale", async () => {
    const { service, bots } = await setup();
    const task = await service.createTask({
      ...inputFor(bots),
      autoStart: false,
    });
    await expect(
      service.steer(task.id, {
        text: "Stale steer",
        observedGoalVersion: 99,
      }),
    ).rejects.toThrow("goalVersion");
    expect((await service.getTask(task.id)).goalVersion).toBe(1);
  });
  it("reuses a freed slot instead of waiting for the whole batch", async () => {
    const gates = [deferred(), deferred(), deferred()];
    let calls = 0;
    const { service, bots } = await setup(
      async (input) => {
        const index = calls;
        calls += 1;
        await gates[index]?.promise;
        return passed(input);
      },
      { concurrency: 2 },
    );
    const task = await service.createTask({
      ...inputFor(bots),
      participantBotIds: [bots[0]!.id, bots[1]!.id],
    });
    const running = service.tick();
    await until(() => calls === 2);
    await service.spawnSession(task.id, {
      botId: bots[0]!.id,
      brief: "Extra work",
      verificationPlan: plan,
    });
    gates[0]!.resolve();
    await until(() => calls === 3);
    gates[1]!.resolve();
    gates[2]!.resolve();
    await running;
    await drain(service);
    expect((await service.snapshot(task.id)).task.status).toBe("completed");
  }, 20_000);
  it("keeps steering available after superseded sessions", async () => {
    const { service, bots } = await setup(undefined, { maxSessions: 6 });
    const task = await service.createTask({
      ...inputFor(bots),
      participantBotIds: [bots[0]!.id, bots[1]!.id],
      autoStart: false,
    });
    for (let index = 0; index < 5; index += 1)
      await service.steer(task.id, { text: `change ${index}` });
    const snapshot = await service.snapshot(task.id);
    expect(
      snapshot.sessions.filter((session) => session.status !== "cancelled"),
    ).toHaveLength(2);
    expect(snapshot.sessions.length).toBeGreaterThan(6);
  }, 20_000);
  it("rejects invalid verification plans before execution", async () => {
    const { service, bots } = await setup();
    const tooMany = Array.from({ length: 33 }, (_, index) => ({
      id: `criterion-${index}`,
      description: "A criterion",
      method: "review",
      expectedEvidence: "Evidence",
    }));
    await expect(
      service.createTask({
        ...inputFor(bots),
        verificationPlan: tooMany,
        checks: [],
      }),
    ).rejects.toMatchObject({ code: "INVALID_VERIFICATION_PLAN" });
    await expect(
      service.createTask({
        ...inputFor(bots),
        verificationPlan: [plan[0]!, plan[0]!],
      }),
    ).rejects.toMatchObject({ code: "INVALID_VERIFICATION_PLAN" });
    await expect(
      service.createTask({
        ...inputFor(bots),
        checks: [{ id: "missing", kind: "contains", value: "x" }],
      }),
    ).rejects.toMatchObject({ code: "INVALID_CHECK" });
  });
});
