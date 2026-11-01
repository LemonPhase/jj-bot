import { describe, expect, it } from "vitest";
import {
  activityFromEvent,
  activitySchema,
  bootstrapSchema,
  botAppearanceSchema,
  CONTRACT_VERSION,
  conversationViewSchema,
  createRuntimeProfileCommandSchema,
  createTaskCommandSchema,
  defaultAppearanceFor,
  type ExecutionSession,
  modelRefSchema,
  parseTaskEvent,
  postTaskMessageCommandSchema,
  sandboxSpecPatchSchema,
  sandboxSpecSchema,
  stopTaskCommandSchema,
  TASK_EVENT_TYPES,
  type TaskEvent,
  type TaskEventOf,
  type TaskEventType,
  taskEventSchema,
  taskMessageSchema,
  taskObjectSchema,
  taskSchema,
  updateBotCommandSchema,
  updateRuntimeProfileCommandSchema,
} from "./index";

const at = "2026-10-31T12:00:00.000Z";
const usage = {
  modelCalls: 1,
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.001,
};
const task = {
  id: "t1",
  title: "Ship it",
  goal: "Ship it",
  goalVersion: 1,
  coordinatorBotId: "coord",
  participantBotIds: ["coord", "worker"],
  status: "queued" as const,
  result: null,
  error: null,
  cancelReason: null,
  cancelRequestedAt: null,
  createdAt: at,
  updatedAt: at,
  finishedAt: null,
};
const session: ExecutionSession = {
  id: "s1",
  taskId: "t1",
  botId: "worker",
  parentSessionId: "s0",
  role: "worker",
  brief: "Write tests",
  goalVersion: 1,
  depth: 1,
  status: "running",
  waitingFor: null,
  result: null,
  error: null,
  activity: null,
  runCount: 1,
  createdAt: at,
  updatedAt: at,
  startedAt: at,
  finishedAt: null,
};
const message = {
  id: "m1",
  taskId: "t1",
  sequence: 1,
  authorKind: "user" as const,
  authorBotId: null,
  sessionId: null,
  intent: "steering" as const,
  text: "Use the staging database.",
  recipientBotIds: ["coord"],
  createdAt: at,
};
const artifact = {
  id: "a1",
  taskId: "t1",
  sessionId: "s1",
  runId: "r1",
  kind: "file" as const,
  path: "src/app.ts",
  name: "app.ts",
  contentType: "text/typescript",
  sizeBytes: 120,
  sha256: "a".repeat(64),
  createdAt: at,
};

// Typed by event type, so adding a variant without a sample fails to compile.
const payloads: { [Type in TaskEventType]: TaskEventOf<Type>["payload"] } = {
  "task.created": { task },
  "task.updated": {
    task: { ...task, status: "running" },
    previousStatus: "queued",
  },
  "task.goal_changed": { goal: "Ship it twice", goalVersion: 2 },
  "task.reopened": { previous: "completed" },
  "task.finished": { status: "completed", result: "Done.", error: null },
  "message.posted": { message },
  "session.created": { session },
  "session.updated": {
    session: { ...session, status: "completed", result: "Ok" },
    previousStatus: "running",
  },
  "run.started": { reason: "wake" },
  "run.finished": { outcome: "waiting" },
  "model.started": {},
  "model.finished": {
    model: "anthropic/claude-x",
    stopReason: "toolUse",
    usage,
    text: "Running tests.",
  },
  "tool.started": { toolCallId: "c1", tool: "bash", summary: "npm test" },
  "tool.finished": {
    toolCallId: "c1",
    tool: "bash",
    summary: "npm test",
    ok: false,
    exitCode: 1,
    interrupted: "no",
    output: "1 failed",
    truncated: true,
    artifactId: "a1",
  },
  "artifact.created": { artifact },
  "steering.received": {
    messageId: "m1",
    goalVersion: 1,
    delivered: "injected",
  },
  "cancellation.requested": { reason: null },
  "cancellation.completed": {
    stopped: [
      {
        sessionId: "s1",
        botId: "worker",
        interrupted: "unknown",
        command: "npm run deploy",
      },
    ],
    neverStarted: ["s2"],
  },
};

const rawEvent = (type: string, payload: unknown, sequence = 1) => ({
  id: `e${sequence}`,
  taskId: "t1",
  sequence,
  type,
  occurredAt: at,
  botId: "worker",
  sessionId: "s1",
  runId: "r1",
  causedBy: null,
  payload,
});

const eventOf = <Type extends TaskEventType>(
  type: Type,
  payload: TaskEventOf<Type>["payload"],
): TaskEvent => taskEventSchema.parse(rawEvent(type, payload));

const loneSurrogate =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("contracts 1.0", () => {
  it("is version 1.0.1", () => {
    expect(CONTRACT_VERSION).toBe("1.0.1");
  });

  it("requires the coordinator to participate and participants to be unique", () => {
    expect(taskSchema.safeParse(task).success).toBe(true);
    expect(
      taskSchema.safeParse({ ...task, coordinatorBotId: "outsider" }).success,
    ).toBe(false);
    expect(
      taskSchema.safeParse({ ...task, participantBotIds: ["coord", "coord"] })
        .success,
    ).toBe(false);
    expect(Object.keys(taskObjectSchema.pick({ id: true }).shape)).toEqual([
      "id",
    ]);
  });

  it("adds a missing coordinator to a new task's participants", () => {
    expect(
      createTaskCommandSchema.parse({
        goal: "  Ship it  ",
        coordinatorBotId: "coord",
        participantBotIds: ["worker"],
      }),
    ).toMatchObject({
      goal: "Ship it",
      participantBotIds: ["coord", "worker"],
    });
    expect(
      createTaskCommandSchema.parse({ goal: "Solo", coordinatorBotId: "coord" })
        .participantBotIds,
    ).toEqual(["coord"]);
    expect(
      createTaskCommandSchema.parse({
        goal: "Ship it",
        coordinatorBotId: "coord",
        participantBotIds: ["worker", "coord"],
      }).participantBotIds,
    ).toEqual(["worker", "coord"]);
    expect(
      createTaskCommandSchema.safeParse({
        goal: "Ship it",
        coordinatorBotId: "coord",
        participantBotIds: ["worker", "worker"],
      }).success,
    ).toBe(false);
  });

  it("accepts only provider/model references", () => {
    expect(modelRefSchema.safeParse("anthropic/claude-x").success).toBe(true);
    expect(modelRefSchema.safeParse("openrouter/org/model:free").success).toBe(
      true,
    );
    for (const bad of ["claude-x", "/model", "Anthropic/x", "anthropic/"])
      expect(modelRefSchema.safeParse(bad).success).toBe(false);
  });

  it("requires the observed goal version when a message changes the goal", () => {
    expect(postTaskMessageCommandSchema.safeParse({ text: "Go" }).success).toBe(
      true,
    );
    const stale = postTaskMessageCommandSchema.safeParse({
      text: "New goal",
      goal: "Ship it twice",
    });
    expect(stale.success).toBe(false);
    expect(stale.error?.issues[0]?.path).toEqual(["observedGoalVersion"]);
    expect(
      postTaskMessageCommandSchema.safeParse({
        text: "New goal",
        goal: "Ship it twice",
        observedGoalVersion: 1,
      }).success,
    ).toBe(true);
    expect(
      postTaskMessageCommandSchema.safeParse({ text: "   " }).success,
    ).toBe(false);
  });

  it("treats a blank stop reason as none", () => {
    expect(stopTaskCommandSchema.parse({})).toEqual({});
    expect(stopTaskCommandSchema.parse({ reason: "   " }).reason).toBe(
      undefined,
    );
    expect(stopTaskCommandSchema.parse({ reason: " Wrong repo " })).toEqual({
      reason: "Wrong repo",
    });
  });

  it("accepts record text beyond command limits, as the engine produces it", () => {
    const long = "x".repeat(50_000);
    expect(taskMessageSchema.parse({ ...message, text: long }).text).toBe(long);
    expect(
      taskMessageSchema.parse({ ...message, text: "(no text)" }).text,
    ).toBe("(no text)");
    expect(postTaskMessageCommandSchema.safeParse({ text: long }).success).toBe(
      false,
    );
  });

  it("round-trips every event variant and tolerates unknown types", () => {
    expect([...TASK_EVENT_TYPES].sort()).toEqual(Object.keys(payloads).sort());
    for (const type of TASK_EVENT_TYPES) {
      const parsed = eventOf(type, payloads[type]);
      expect(parsed.type).toBe(type);
      expect(taskEventSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(
        parsed,
      );
      expect(parseTaskEvent(JSON.parse(JSON.stringify(parsed)))).toEqual(
        parsed,
      );
    }

    const future = rawEvent("bot.waved", { hand: "left" });
    expect(taskEventSchema.safeParse(future).success).toBe(false);
    expect(parseTaskEvent(future)).toMatchObject({
      unknown: true,
      type: "bot.waved",
      sequence: 1,
    });
    // A known type with a malformed payload is a real error, not an unknown event.
    expect(() =>
      parseTaskEvent(rawEvent("task.reopened", { previous: "cancelled" })),
    ).toThrow();
  });

  it("derives each session's activity line from events", () => {
    const tool = (name: string, summary: string) =>
      activityFromEvent(
        eventOf("tool.started", { toolCallId: "c", tool: name, summary }),
      );

    expect(activityFromEvent(eventOf("model.started", {}))).toEqual({
      kind: "thinking",
      text: "Thinking…",
      since: at,
    });
    expect(tool("bash", "npm test")).toMatchObject({
      kind: "command",
      text: "Running `npm test`",
    });
    expect(tool("read", "src/app.ts")).toMatchObject({ kind: "reading" });
    expect(tool("ls", "src")).toMatchObject({ kind: "reading" });
    expect(tool("edit", "src/app.ts")).toMatchObject({
      kind: "editing",
      text: "Editing src/app.ts",
    });
    expect(tool("write", "src/new.ts")).toMatchObject({
      kind: "editing",
      text: "Editing src/new.ts",
    });
    expect(tool("grep", "TODO")).toMatchObject({ kind: "searching" });
    expect(tool("find", "*.ts")).toMatchObject({ kind: "searching" });
    expect(tool("delegate", "Researcher")).toMatchObject({
      kind: "delegating",
      text: "Delegated to Researcher",
    });
    expect(tool("message", "Researcher")).toMatchObject({ kind: "messaging" });

    const long = tool("bash", `echo ${"x".repeat(280)}\n&& done`);
    expect(long?.text.length).toBeLessThanOrEqual(200);
    expect(long?.text).toMatch(/^Running `echo x+…`$/);

    const updated = (change: Partial<ExecutionSession>) =>
      activityFromEvent(
        eventOf("session.updated", {
          session: { ...session, ...change },
          previousStatus: "running",
        }),
      );
    expect(
      updated({ status: "waiting", waitingFor: "delegations" }),
    ).toMatchObject({ kind: "waiting", text: "Waiting on delegated work" });
    expect(updated({ status: "waiting", waitingFor: "user" })).toEqual({
      kind: "waiting",
      text: "Waiting for you",
      since: at,
    });
    expect(updated({ status: "completed" })).toBeNull();
    expect(updated({ status: "failed" })).toBeNull();
    expect(updated({ status: "running" })).toBeUndefined();
    expect(
      activityFromEvent(eventOf("tool.finished", payloads["tool.finished"])),
    ).toBeUndefined();
    expect(
      activityFromEvent({ ...eventOf("model.started", {}), sessionId: null }),
    ).toBeUndefined();
  });

  it("truncates activity between code points, never inside a surrogate pair", () => {
    // "Running `" + 188 characters leaves one unit before the ellipsis: the emoji needs two.
    const summary = `${"x".repeat(188)}😀${"y".repeat(20)}`;
    const activity = activityFromEvent(
      eventOf("tool.started", { toolCallId: "c", tool: "bash", summary }),
    );
    expect(activity?.text).toBe(`Running \`${"x".repeat(188)}…\``);
    expect(activity?.text).not.toMatch(loneSurrogate);

    const fits = activityFromEvent(
      eventOf("tool.started", {
        toolCallId: "c",
        tool: "bash",
        summary: `${"x".repeat(187)}😀${"y".repeat(20)}`,
      }),
    );
    expect(fits?.text).toBe(`Running \`${"x".repeat(187)}😀…\``);
    expect(activitySchema.safeParse(fits).success).toBe(true);
  });

  it("gives each seed a stable, valid default appearance", () => {
    const seeds = ["Researcher", "Builder", "Reviewer", "Scout", "Ada", ""];
    for (const seed of seeds) {
      const appearance = defaultAppearanceFor(seed);
      expect(botAppearanceSchema.parse(appearance)).toEqual(appearance);
      expect(defaultAppearanceFor(seed)).toEqual(appearance);
    }
  });

  it("requires at least one field to update", () => {
    expect(updateBotCommandSchema.safeParse({}).success).toBe(false);
    expect(updateBotCommandSchema.safeParse({ unknown: 1 }).success).toBe(
      false,
    );
    expect(updateBotCommandSchema.parse({ role: " Reviewer " })).toEqual({
      role: "Reviewer",
    });
    expect(updateBotCommandSchema.parse({ model: null })).toEqual({
      model: null,
    });
    expect(updateRuntimeProfileCommandSchema.safeParse({}).success).toBe(false);
  });

  it("fills sandbox spec defaults in profile create commands", () => {
    const command = createRuntimeProfileCommandSchema.parse({
      name: "Local dev",
      sandbox: { driver: "local" },
    });
    expect(command.sandbox).toEqual({
      driver: "local",
      resources: {},
      network: { mode: "none" },
      workspace: "task",
      limits: { execTimeoutMs: 120_000, maxOutputBytes: 262_144 },
      env: {},
      driverConfig: {},
    });
    expect(command.tools).toBeUndefined();
    expect(
      createRuntimeProfileCommandSchema.safeParse({
        name: "Dup",
        sandbox: { driver: "local" },
        tools: ["bash", "bash"],
      }).success,
    ).toBe(false);
  });

  it("never fills defaults into a profile patch", () => {
    expect(
      updateRuntimeProfileCommandSchema.parse({
        sandbox: { network: { mode: "open" }, limits: { execTimeoutMs: 5000 } },
        budgets: { maxTurnsPerRun: 10 },
      }),
    ).toEqual({
      sandbox: { network: { mode: "open" }, limits: { execTimeoutMs: 5000 } },
      budgets: { maxTurnsPerRun: 10 },
    });
    expect(
      updateRuntimeProfileCommandSchema.safeParse({
        sandbox: { resources: { cpus: -1 } },
      }).success,
    ).toBe(false);
    // The patch mirrors the driver contract's spec field for field.
    expect(Object.keys(sandboxSpecPatchSchema.shape).sort()).toEqual(
      Object.keys(sandboxSpecSchema.shape).sort(),
    );
  });

  it("parses a whole server-shaped bootstrap, filling record defaults", () => {
    const bootstrap = bootstrapSchema.parse({
      mode: "backend",
      contractVersion: CONTRACT_VERSION,
      capabilities: {
        agentExecution: true,
        persistence: true,
        streaming: true,
        verification: false,
        drivers: [{ id: "local", available: true, isolated: false }],
      },
      defaultModel: null,
      bots: [
        {
          id: "coord",
          name: "Coordinator",
          model: null,
          runtimeProfileId: null,
          appearance: defaultAppearanceFor("Coordinator"),
          presence: "idle",
          activeTaskIds: [],
          createdAt: at,
          updatedAt: at,
        },
      ],
      tasks: [
        { ...task, activeSessionCount: 0, sessionCount: 1, usage: usage },
      ],
      profiles: [
        {
          id: "p1",
          name: "Local",
          sandbox: { driver: "local" },
          budgets: {},
          isDefault: true,
          status: { driverAvailable: true, isolated: false },
          createdAt: at,
          updatedAt: at,
        },
      ],
    });
    expect(bootstrap.bots[0]).toMatchObject({ role: "", instructions: "" });
    expect(bootstrap.profiles[0]).toMatchObject({
      description: "",
      tools: ["bash", "read", "edit", "write", "grep", "find", "ls"],
      budgets: { maxTurnsPerRun: 60, maxRunMinutes: 30 },
      sandbox: { network: { mode: "none" }, workspace: "task" },
    });
  });

  it("parses a conversation view with a failed reply and an unlinked message", () => {
    const view = conversationViewSchema.parse({
      botId: "coord",
      messages: [
        {
          id: "c1",
          botId: "coord",
          sequence: 1,
          role: "assistant",
          text: "(no text)",
          taskId: null,
          createdAt: at,
        },
      ],
      replying: false,
      lastReplyError: { message: "Model not configured", at },
    });
    expect(view.messages[0]?.taskId).toBeNull();
    expect(
      conversationViewSchema.safeParse({ ...view, lastReplyError: undefined })
        .success,
    ).toBe(false);
  });
});
