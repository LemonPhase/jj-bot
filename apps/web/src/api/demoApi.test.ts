import {
  applyTaskEvent,
  bootstrapSchema,
  botMemorySchema,
  botSchema,
  conversationViewSchema,
  modelsViewSchema,
  runtimeProfileSchema,
  sandboxDriverInfoSchema,
  type TaskEvent,
  type TaskView,
  taskEventSchema,
  taskSummarySchema,
  taskViewSchema,
  type WorkspaceHint,
} from "@jj/contracts";
import { describe, expect, it, vi } from "vitest";
import { statusWord } from "../lib/status";
import { ApiError, type JJApi } from "./client";
import { createDemoApi, titleFromGoal } from "./demoApi";
import { DEMO_TASKS } from "./demoFixtures";

const NOW = new Date("2026-10-31T12:00:00.000Z");
const demo = (options: Parameters<typeof createDemoApi>[0] = {}) =>
  createDemoApi({ now: () => NOW, autoplay: false, replyMs: 0, ...options });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Follows a task the way the UI does and drives it to the end of its script. */
async function runToEnd(api: JJApi, taskId: string) {
  const views: TaskView[] = [];
  const unsubscribe = api.subscribeTask(taskId, (view) => views.push(view));
  await flush();
  const finished = () =>
    ["completed", "failed", "cancelled"].includes(
      views.at(-1)?.task.status ?? "",
    );
  for (let step = 0; step < 60 && !finished(); step += 1)
    await api.advanceDemoTask?.(taskId);
  unsubscribe();
  const final = views.at(-1);
  if (!final) throw new Error("no view");
  return { views, final };
}

const expectValidEvents = (events: TaskEvent[]) => {
  for (const event of events) taskEventSchema.parse(event);
  const sequences = events.map((e) => e.sequence);
  expect(sequences).toEqual(sequences.map((_, index) => index + 1));
};

const rejects = async (promise: Promise<unknown>, code: string) => {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ApiError);
  expect((error as ApiError).code).toBe(code);
};

describe("demo API", () => {
  it("is labelled demo data and reports no real capabilities", async () => {
    const api = demo();
    expect(api.mode).toBe("demo");
    expect(api.badge.label).toBe("Demo data");
    expect(api.capabilities).toMatchObject({
      agentExecution: false,
      streaming: false,
      persistence: false,
      verification: false,
    });
    expect((await api.bootstrap()).mode).toBe("scaffold");
    const models = await api.getModels();
    expect(
      models.providers.every((p) => p.id === "demo" && !p.configured),
    ).toBe(true);
  });

  it("serves only contract-valid fixtures", async () => {
    const api = demo();
    const boot = bootstrapSchema.parse(await api.bootstrap());
    expect(boot.bots.length).toBeGreaterThanOrEqual(4);
    for (const bot of await api.listBots()) {
      botSchema.parse(bot);
      botMemorySchema.parse(await api.getMemory(bot.id));
      conversationViewSchema.parse(await api.getConversation(bot.id));
    }
    const profiles = await api.listProfiles();
    for (const profile of profiles) runtimeProfileSchema.parse(profile);
    expect(profiles.map((p) => [p.sandbox.driver, p.status.isolated])).toEqual([
      ["docker", true],
      ["local", false],
    ]);
    for (const driver of await api.listDrivers())
      sandboxDriverInfoSchema.parse(driver);
    modelsViewSchema.parse(await api.getModels());
    const summaries = await api.listTasks();
    expect(summaries.map((t) => t.id).sort()).toEqual(
      DEMO_TASKS.map((t) => t.id).sort(),
    );
    for (const summary of summaries) {
      taskSummarySchema.parse(summary);
      const view = taskViewSchema.parse(await api.getTask(summary.id));
      expectValidEvents(view.events);
    }
  });

  it("is deterministic for a given clock", async () => {
    const [a, b] = [demo(), demo()];
    expect(await a.bootstrap()).toEqual(await b.bootstrap());
    expect(await a.getTask("task-101")).toEqual(await b.getTask("task-101"));
  });

  it("seeds a running, a completed and a waiting task", async () => {
    const api = demo();
    const [running, completed, waiting] = await Promise.all(
      ["task-101", "task-102", "task-103"].map((id) => api.getTask(id)),
    );
    expect(running?.task.status).toBe("running");
    expect(completed?.task.status).toBe("completed");
    expect(waiting?.task.status).toBe("waiting");
    expect(waiting?.sessions[0]?.waitingFor).toBe("user");
    // Snapshot events drop tool output previews, like the live API.
    expect(
      completed?.events.some(
        (e) => e.type === "tool.finished" && e.payload.output !== undefined,
      ),
    ).toBe(false);
  });

  it("runs the demo task to a valid completed view through applyTaskEvent", async () => {
    const api = demo();
    const { views, final } = await runToEnd(api, "task-101");
    expect(views.length).toBeGreaterThan(5);
    taskViewSchema.parse(final);
    expectValidEvents(final.events);
    expect(final.task.status).toBe("completed");
    expect(final.task.result).toMatch(/demo data/i);
    expect(final.events.at(-1)?.type).toBe("task.finished");

    const coordinator = final.sessions.find((s) => s.role === "coordinator");
    const workers = final.sessions.filter((s) => s.role === "worker");
    expect(workers.map((w) => w.botId)).toEqual(["bot-moss", "bot-vesper"]);
    expect(workers.every((w) => w.parentSessionId === coordinator?.id)).toBe(
      true,
    );
    expect(
      final.sessions.every(
        (s) => s.status === "completed" && s.activity === null,
      ),
    ).toBe(true);
    const tools = final.events.flatMap((e) =>
      e.type === "tool.started" ? [e.payload.tool] : [],
    );
    expect(tools).toEqual(
      expect.arrayContaining(["delegate", "bash", "write", "complete_task"]),
    );
    expect(final.messages.map((m) => m.intent)).toEqual([
      "assignment",
      "assignment",
      "result",
      "result",
      "result",
    ]);
    expect(final.artifacts).toHaveLength(1);
    expect(final.usage.total.modelCalls).toBeGreaterThan(0);

    // The client's fold equals the server's view: snapshot n + events n+1..m =
    // view m, exactly, because streamed tool output previews are dropped too.
    expect(final).toEqual(await api.getTask("task-101"));
    expect(api.artifactUrl("task-101", final.artifacts[0]?.id ?? "")).toMatch(
      /^data:text\/markdown/,
    );
  });

  it("intermediate views show live activity lines", async () => {
    const api = demo();
    const { views } = await runToEnd(api, "task-101");
    const lines = views.flatMap((v) =>
      v.sessions.flatMap((s) => (s.activity ? [s.activity.text] : [])),
    );
    expect(lines).toEqual(
      expect.arrayContaining([
        "Thinking…",
        "Running `npm test`",
        "Waiting on delegated work",
      ]),
    );
  });

  it.each([
    [["bot-kite"], 0],
    [["bot-kite", "bot-moss"], 1],
    // A third teammate becomes the first worker's helper, two levels down.
    [["bot-kite", "bot-moss", "bot-vesper", "bot-juno"], 3],
  ])(
    "completes a new task with participants %j",
    async (participants, workers) => {
      const api = demo();
      const task = await api.createTask({
        goal: "Write release notes for the 1.0 contracts",
        coordinatorBotId: "bot-kite",
        participantBotIds: participants,
      });
      expect(task.status).toBe("queued");
      expect(task.title).toBe("Write release notes for the 1.0 contracts");
      const { final } = await runToEnd(api, task.id);
      taskViewSchema.parse(final);
      expectValidEvents(final.events);
      expect(final.task.status).toBe("completed");
      expect(final.sessions.filter((s) => s.role === "worker")).toHaveLength(
        workers,
      );
      const parents = new Map(final.sessions.map((s) => [s.id, s]));
      const depthOf = (id: string | null): number =>
        id ? 1 + depthOf(parents.get(id)?.parentSessionId ?? null) : -1;
      expect(Math.max(...final.sessions.map((s) => depthOf(s.id)))).toBe(
        workers === 3 ? 2 : Math.min(workers, 1),
      );
      expect(final.sessions.every((s) => s.depth === depthOf(s.id))).toBe(true);
    },
  );

  it("continues a waiting task when the user answers", async () => {
    const api = demo();
    const message = await api.postTaskMessage("task-103", {
      text: "Keep a fallback.",
    });
    expect(message).toMatchObject({ authorKind: "user", intent: "steering" });
    const view = await api.getTask("task-103");
    expect(view.task.status).toBe("running");
    expect(view.events.map((e) => e.type)).toEqual(
      expect.arrayContaining(["task.reopened", "steering.received"]),
    );
    const { final } = await runToEnd(api, "task-103");
    expect(final.task.status).toBe("completed");
    expectValidEvents(final.events);
  });

  it("posts a goal change in the server's event order", async () => {
    const api = demo();
    // Waiting task: the goal change also reopens it.
    await api.postTaskMessage("task-103", {
      text: "Switch over in one go",
      goal: "Plan a one-step rollout of the Docker sandbox driver",
      observedGoalVersion: 1,
    });
    const { events } = await api.getTask("task-103");
    const from = events.findIndex((e) => e.type === "task.goal_changed") - 1;
    expect(events.slice(from).map((e) => e.type)).toEqual([
      "task.updated",
      "task.goal_changed",
      "task.updated",
      "task.reopened",
      "message.posted",
      "steering.received",
    ]);
    // A completed task's finished coordinator session is queued again too.
    await api.postTaskMessage("task-102", { text: "One more thing" });
    const after = (await api.getTask("task-102")).events;
    const reopened = after.findIndex((e) => e.type === "task.reopened");
    expect(after.slice(reopened - 1).map((e) => e.type)).toEqual([
      "task.updated",
      "task.reopened",
      "session.updated",
      "message.posted",
      "steering.received",
    ]);
  });

  it("checks the goal version only when the goal changes", async () => {
    const api = demo();
    const { task } = await api.getTask("task-101");
    // The same goal is no change: no version check, no new version.
    await api.postTaskMessage("task-101", {
      text: "Same goal, more detail",
      goal: task.goal,
      observedGoalVersion: 99,
    });
    expect((await api.getTask("task-101")).task.goalVersion).toBe(1);
    await expect(
      api.postTaskMessage("task-101", {
        text: "New goal",
        goal: "Something else",
        observedGoalVersion: 3,
      }),
    ).rejects.toMatchObject({
      code: "STALE_GOAL_VERSION",
      message: "The goal is at version 1; you edited version 3.",
      details: { goalVersion: 1 },
    });
  });

  it("changes the goal only against the observed version", async () => {
    const api = demo();
    await rejects(
      api.postTaskMessage("task-101", {
        text: "New goal",
        goal: "New goal",
        observedGoalVersion: 7,
      }),
      "STALE_GOAL_VERSION",
    );
    await api.postTaskMessage("task-101", {
      text: "Also cover the hint stream",
      goal: "Check the task and hint streams",
      observedGoalVersion: 1,
    });
    const { task, events } = await api.getTask("task-101");
    expect(task).toMatchObject({
      goal: "Check the task and hint streams",
      goalVersion: 2,
    });
    expect(events.some((e) => e.type === "task.goal_changed")).toBe(true);
  });

  it("stops a task as the server does: stopping while runs stop, then cancelled", async () => {
    const api = demo();
    // Start the workers, so there are runs to stop.
    await api.advanceDemoTask?.("task-101");
    const stopping = await api.stopTask("task-101", { reason: "  " });
    expect(stopping.cancelReason).toBeNull();
    expect(statusWord(stopping)).toBe("stopping");
    const refused = await api
      .postTaskMessage("task-101", { text: "hello" })
      .catch((reason: unknown) => reason);
    expect(refused).toMatchObject({
      code: "TASK_TERMINAL",
      message: "The task is stopping and takes no new messages.",
    });
    // A repeat stop is idempotent.
    expect((await api.stopTask("task-101")).cancelRequestedAt).toBe(
      stopping.cancelRequestedAt,
    );
    await api.advanceDemoTask?.("task-101");
    const view = taskViewSchema.parse(await api.getTask("task-101"));
    expect(view.task.status).toBe("cancelled");
    expect(
      view.sessions.every((s) => ["cancelled", "completed"].includes(s.status)),
    ).toBe(true);
    const types = view.events.map((e) => e.type);
    const requested = types.indexOf("cancellation.requested");
    // The server's order: request; runs stop (run.finished, then the session);
    // the task is cancelled; cancellation.completed; task.finished.
    expect(types.slice(requested - 1, requested + 1)).toEqual([
      "task.updated",
      "cancellation.requested",
    ]);
    expect(types.slice(-3)).toEqual([
      "task.updated",
      "cancellation.completed",
      "task.finished",
    ]);
    const firstStop = types.indexOf("run.finished", requested);
    expect(types[firstStop + 1]).toBe("session.updated");
    expectValidEvents(view.events);
    expect((await api.stopTask("task-101")).status).toBe("cancelled");
    await expect(
      api.postTaskMessage("task-101", { text: "hello" }),
    ).rejects.toMatchObject({
      code: "TASK_TERMINAL",
      message: "The task was cancelled; start a new task to continue the work.",
    });
  });

  it("settles a stop at once with no run in progress, and refuses finished tasks", async () => {
    const api = demo();
    // task-101 as seeded: the coordinator waits and the workers are queued.
    const stopped = await api.stopTask("task-101");
    expect(stopped.status).toBe("cancelled");
    const view = await api.getTask("task-101");
    const completed = view.events.find(
      (e) => e.type === "cancellation.completed",
    );
    expect(
      completed?.type === "cancellation.completed" && completed.payload,
    ).toMatchObject({ stopped: [] });
    await expect(api.stopTask("task-102")).rejects.toMatchObject({
      code: "CONFLICT",
      message: "The task already completed; there is nothing to stop.",
    });
  });

  it("replies to a greeting without starting a task", async () => {
    const api = demo();
    const hints: WorkspaceHint[] = [];
    api.subscribeHints((hint) => hints.push(hint));
    const sent = await api.sendBotMessage("bot-kite", { text: "Hello Kite" });
    expect(sent.role).toBe("user");
    expect((await api.getConversation("bot-kite")).replying).toBe(true);
    await flush();
    const view = conversationViewSchema.parse(
      await api.getConversation("bot-kite"),
    );
    expect(view.replying).toBe(false);
    expect(view.messages.at(-1)).toMatchObject({
      role: "assistant",
      taskId: null,
    });
    expect(view.messages.at(-1)?.text).toMatch(/demo/);
    expect(hints).toEqual([
      { type: "conversation.changed", botId: "bot-kite" },
      { type: "conversation.changed", botId: "bot-kite" },
    ]);
  });

  it("starts a task from a work request in direct chat", async () => {
    const api = demo();
    const views: unknown[] = [];
    const unsubscribe = api.subscribeConversation("bot-moss", (view) =>
      views.push(view),
    );
    await api.sendBotMessage("bot-moss", {
      text: "Add a retry to the hint stream",
    });
    await flush();
    unsubscribe();
    const view = await api.getConversation("bot-moss");
    const reply = view.messages.at(-1);
    expect(reply?.taskId).toBeTruthy();
    const task = (await api.listTasks()).find((t) => t.id === reply?.taskId);
    expect(task).toMatchObject({
      coordinatorBotId: "bot-moss",
      status: "queued",
    });
    expect(task?.participantBotIds[0]).toBe("bot-moss");
    // The subscriber saw the reply land (superseded refetches are dropped).
    expect(views.at(-1)).toEqual(view);
  });

  it("rejects what the server would reject", async () => {
    const api = demo();
    await rejects(api.createBot({ name: "  " }), "VALIDATION_FAILED");
    await rejects(
      api.createTask({
        goal: "Check it",
        coordinatorBotId: "bot-kite",
        verificationPlan: [
          { id: "c", description: "d", method: "m", expectedEvidence: "e" },
        ],
      }),
      "VERIFICATION_UNAVAILABLE",
    );
    await rejects(api.archiveBot("bot-juno"), "CONFLICT");
    await rejects(api.createBot({ name: "juno" }), "CONFLICT");
    await rejects(api.updateBot("bot-kite", { name: "Moss" }), "CONFLICT");
    await rejects(api.deleteProfile("profile-docker"), "CONFLICT");
    await rejects(api.deleteProfile("profile-local"), "PROFILE_IN_USE");
    await rejects(
      api.updateProfile("profile-docker", { isDefault: false }),
      "CONFLICT",
    );
    await rejects(
      api.createProfile({
        name: "Offline local",
        sandbox: { driver: "local", network: { mode: "none" } },
      }),
      "PROFILE_UNSUPPORTED",
    );
    await rejects(api.getTask("task-999"), "NOT_FOUND");
  });

  it("refuses specs with the drivers' own messages, as the server does", async () => {
    const api = demo();
    const message = async (promise: Promise<unknown>) =>
      (
        (await promise.then(
          () => null,
          (reason: unknown) => reason,
        )) as ApiError | null
      )?.message;
    expect(
      await message(
        api.createProfile({
          name: "Offline local",
          sandbox: { driver: "local", network: { mode: "none" } },
        }),
      ),
    ).toBe('Driver local cannot enforce network.mode="none"');
    // Switching the docker profile to local keeps its network "none".
    expect(
      await message(
        api.updateProfile("profile-docker", { sandbox: { driver: "local" } }),
      ),
    ).toBe('Driver local cannot enforce network.mode="none"');
    // With an open network the image is dropped, but the resources stay.
    expect(
      await message(
        api.updateProfile("profile-docker", {
          sandbox: { driver: "local", network: { mode: "open" } },
        }),
      ),
    ).toBe("Driver local cannot enforce resources");
    expect(
      await message(
        api.createProfile({
          name: "Local image",
          sandbox: {
            driver: "local",
            image: "node:22",
            network: { mode: "open" },
          },
        }),
      ),
    ).toBe(
      'Driver local cannot enforce image "node:22": commands run directly on the host',
    );
  });

  it("creates, edits and archives bots with contract defaults", async () => {
    const api = demo();
    const bot = botSchema.parse(await api.createBot({ name: "Nova" }));
    expect(bot).toMatchObject({
      role: "",
      instructions: "",
      model: null,
      presence: "idle",
    });
    const renamed = await api.updateBot(bot.id, { role: "Security review" });
    expect(renamed.role).toBe("Security review");
    expect(
      (await api.putMemory(bot.id, { text: "Prefers short answers" })).text,
    ).toBe("Prefers short answers");
    await api.archiveBot(bot.id);
    expect((await api.listBots()).some((b) => b.id === bot.id)).toBe(false);
  });

  it("manages runtime profiles", async () => {
    const api = demo();
    const profile = await api.createProfile({
      name: "Docker online",
      sandbox: { driver: "docker", network: { mode: "open" } },
    });
    runtimeProfileSchema.parse(profile);
    expect(profile.status.isolated).toBe(true);
    const updated = await api.updateProfile(profile.id, {
      sandbox: { resources: { cpus: 1 } },
      isDefault: true,
    });
    expect(updated.sandbox).toMatchObject({
      network: { mode: "open" },
      resources: { cpus: 1 },
    });
    expect(
      (await api.listProfiles()).filter((p) => p.isDefault).map((p) => p.id),
    ).toEqual([profile.id]);
    await rejects(api.deleteProfile("profile-local"), "PROFILE_IN_USE");
  });

  it("keeps a reopened seeded task moving on its own", async () => {
    // Seeded task-103 waits for an answer with autoplay off.
    const api = demo({ autoplay: true, stepMs: 2 });
    const statuses: string[] = [];
    const unsubscribe = api.subscribeTask("task-103", (view) =>
      statuses.push(view.task.status),
    );
    await flush();
    expect(statuses).toEqual(["waiting"]);
    await api.postTaskMessage("task-103", { text: "Keep a fallback." });
    await vi.waitFor(() => expect(statuses.at(-1)).toBe("completed"), {
      timeout: 3000,
    });
    unsubscribe();
  });

  it("advances on a timer when autoplay is on", async () => {
    const api = demo({ autoplay: true, stepMs: 2 });
    const statuses: string[] = [];
    const unsubscribe = api.subscribeTask("task-101", (view) =>
      statuses.push(view.task.status),
    );
    await vi.waitFor(() => expect(statuses.at(-1)).toBe("completed"), {
      timeout: 3000,
    });
    unsubscribe();
  });

  it("delivers the same view to a late subscriber as to one that followed along", async () => {
    const api = demo();
    const early: TaskView[] = [];
    const stop = api.subscribeTask("task-101", (view) => early.push(view));
    await flush();
    for (let i = 0; i < 4; i += 1) await api.advanceDemoTask?.("task-101");
    const late: TaskView[] = [];
    const stopLate = api.subscribeTask("task-101", (view) => late.push(view));
    await flush();
    await api.advanceDemoTask?.("task-101");
    stop();
    stopLate();
    expect(late.at(-1)).toEqual(early.at(-1));
    // Folding is idempotent: replaying an applied event changes nothing.
    const last = early.at(-1) as TaskView;
    const replayed = last.events.at(-1);
    if (replayed) expect(applyTaskEvent(last, replayed)).toBe(last);
  });

  it("derives task titles from goals", () => {
    expect(titleFromGoal("Short goal")).toBe("Short goal");
    expect(titleFromGoal("First line\nsecond line")).toBe("First line");
    const long = titleFromGoal(
      "Check that the task stream resumes after a reconnect without gaps or duplicates",
    );
    expect(long.length).toBeLessThanOrEqual(61);
    expect(long.endsWith("…")).toBe(true);
  });
});
