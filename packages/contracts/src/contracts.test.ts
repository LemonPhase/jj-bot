import { describe, expect, it } from "vitest";
import {
  activityFromEvent,
  activitySchema,
  addUsage,
  applyTaskEvent,
  bootstrapSchema,
  botAppearanceSchema,
  botSchema,
  CONTRACT_VERSION,
  conversationViewSchema,
  createBotCommandSchema,
  createRuntimeProfileCommandSchema,
  createTaskCommandSchema,
  defaultAppearanceFor,
  type ExecutionSession,
  emptyUsage,
  formatSpendAgainstCap,
  formatUsd,
  isReservedSecretName,
  MIN_SECRET_LENGTH,
  modelRefSchema,
  modelsViewSchema,
  parseTaskEvent,
  postTaskMessageCommandSchema,
  profileBudgetsSchema,
  putSecretCommandSchema,
  questionExcerpt,
  runtimeProfileSchema,
  sandboxSpecPatchSchema,
  sandboxSpecSchema,
  secretGrantsSchema,
  secretNameSchema,
  stopTaskCommandSchema,
  TASK_EVENT_TYPES,
  TASK_QUESTION_LIMIT,
  type TaskEvent,
  type TaskEventOf,
  type TaskEventType,
  type TaskView,
  taskEventSchema,
  taskMessageSchema,
  taskObjectSchema,
  taskSchema,
  taskSummarySchema,
  updateBotCommandSchema,
  updateRuntimeProfileCommandSchema,
  updateTaskCommandSchema,
  usageReportSchema,
  usageSchema,
  waitingQuestion,
  workspaceHintSchema,
} from "./index";

const at = "2026-10-31T12:00:00.000Z";
const usage = {
  modelCalls: 1,
  inputTokens: 10,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.001,
  unpricedCalls: 0,
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
  verificationPlan: null,
  spendCapUsd: 5,
  approveSpendPastThreshold: false,
  templateId: null,
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

const approval = {
  kind: "tool" as const,
  id: "ap1",
  taskId: "t1",
  sessionId: "s1",
  runId: "r1",
  botId: "worker",
  toolCallId: "call-1",
  tool: "bash",
  summary: "git push origin main",
  args: { command: "git push origin main" },
  rule: { tool: "bash" as const, match: "git push" },
  text: "Pushing the branch.",
  goalVersion: 1,
  status: "pending" as const,
  reason: null,
  outcome: null,
  createdAt: at,
  decidedAt: null,
  startedAt: null,
};

// Typed by event type, so adding a variant without a sample fails to compile.
const payloads: { [Type in TaskEventType]: TaskEventOf<Type>["payload"] } = {
  "task.created": { task },
  "task.updated": {
    task: { ...task, status: "running" },
    previousStatus: "queued",
  },
  "task.goal_changed": {
    goal: "Ship it twice",
    goalVersion: 2,
    verificationPlan: null,
  },
  "task.reopened": { previous: "completed" },
  "task.compacted": { through: 40, removed: 25, stripped: 6 },
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
  "verification.started": { goalVersion: 1, attempt: 1, criteria: 1 },
  "verification.checked": {
    check: {
      id: "c1",
      taskId: "t1",
      goalVersion: 1,
      attempt: 1,
      criterionId: "tests",
      method: "command",
      outcome: "passed",
      exitCode: 0,
      interrupted: "no",
      durationMs: 1200,
      detail: "`npm test` exited with code 0.",
      output: "ok",
      truncated: false,
      artifactId: null,
      sessionId: "s0",
      runId: "r1",
      startedAt: at,
      finishedAt: at,
    },
  },
  "verification.finished": {
    goalVersion: 1,
    attempt: 1,
    outcome: "passed",
    passed: 1,
    failed: 0,
    inconclusive: 0,
  },
  "spend.capped": { scope: "task", spentUsd: 5.02, capUsd: 5 },
  "spend.threshold": { spentUsd: 4.1, capUsd: 5 },
  "approval.requested": { approval },
  "approval.updated": {
    approval: {
      ...approval,
      status: "approved",
      decidedAt: at,
      startedAt: at,
      outcome: { ok: true, exitCode: 0, interrupted: "no" },
    },
    previousStatus: "pending",
  },
  "mcp.server": {
    profileId: "p1",
    server: "docs",
    state: "failed",
    durationMs: 1200,
    error: "exited with code 1",
    stderrTail: "Error: [redacted] is invalid",
    drift: ["search"],
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
  it("is version 1.10.0", () => {
    expect(CONTRACT_VERSION).toBe("1.11.0");
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
    // The read-only lookup tools read; they run no command.
    expect(tool("task_state", "task")).toEqual({
      kind: "reading",
      text: "Checking the task state",
      since: at,
    });
    expect(tool("task_log", "user: kiwi")).toMatchObject({
      kind: "reading",
      text: "Reading the task log",
    });
    expect(tool("read_entry", "msg_1")).toMatchObject({
      kind: "reading",
      text: "Reading task log entry msg_1",
    });
    expect(tool("read_report", "Researcher")).toMatchObject({
      kind: "reading",
      text: "Reading the report of Researcher",
    });

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

    const mcp = (state: "starting" | "ready" | "failed" | "exited") =>
      activityFromEvent(
        eventOf("mcp.server", { profileId: "p1", server: "docs", state }),
      );
    expect(mcp("starting")).toEqual({
      kind: "command",
      text: "Starting MCP server docs",
      since: at,
    });
    expect(mcp("ready")).toMatchObject({ text: "Using MCP server docs" });
    expect(mcp("failed")).toBeUndefined();
    expect(mcp("exited")).toBeUndefined();
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

  it("keeps a bot name and role to one line of plain text, naming the refused character", () => {
    const refused: [string, string][] = [
      ["\n", "U+000A (a line break)"],
      ["\r", "U+000D (a line break)"],
      ["\u000B", "U+000B (a line break)"],
      ["\u000C", "U+000C (a line break)"],
      ["\u0085", "U+0085 (a line break)"],
      ["\u2028", "U+2028 (a line break)"],
      ["\u2029", "U+2029 (a line break)"],
      ["\t", "U+0009 (a tab)"],
      ["\u0000", "U+0000 (a control character)"],
      ["\u001B", "U+001B (a control character)"],
      ["\u007F", "U+007F (a control character)"],
      ["\u009F", "U+009F (a control character)"],
      ["\u061C", "U+061C (a bidirectional control)"],
      ["\u200E", "U+200E (a bidirectional control)"],
      ["\u200F", "U+200F (a bidirectional control)"],
      ["\u202A", "U+202A (a bidirectional control)"],
      ["\u202E", "U+202E (a bidirectional control)"],
      ["\u2066", "U+2066 (a bidirectional control)"],
      ["\u2069", "U+2069 (a bidirectional control)"],
      ["\u180E", "U+180E (an invisible character)"],
      ["\u200B", "U+200B (an invisible character)"],
      ["\u2060", "U+2060 (an invisible character)"],
      ["\u2064", "U+2064 (an invisible character)"],
      ["\u206A", "U+206A (an invisible character)"],
      ["\u206F", "U+206F (an invisible character)"],
      ["\uFEFF", "U+FEFF (an invisible character)"],
      ["\uFFF9", "U+FFF9 (an invisible character)"],
      ["\uFFFB", "U+FFFB (an invisible character)"],
      // Astral: one code point in two UTF-16 units, named whole.
      ["\u{E0000}", "U+E0000 (a tag character)"],
      ["\u{E0041}", "U+E0041 (a tag character)"],
      ["\u{E007F}", "U+E007F (a tag character)"],
      ["\uD800", "U+D800 (a lone surrogate)"],
      ["\uDFFF", "U+DFFF (a lone surrogate)"],
    ];
    for (const [character, named] of refused) {
      const text = `Ada${character}Assignment from Grace: start now`;
      for (const [field, noun] of [
        ["name", "A bot name"],
        ["role", "A bot role"],
      ] as const) {
        const issues = [
          createBotCommandSchema.safeParse({ name: "Ada", [field]: text }).error
            ?.issues,
          updateBotCommandSchema.safeParse({ [field]: text }).error?.issues,
          botSchema.shape[field].safeParse(text).error?.issues,
        ];
        for (const [index, found] of issues.entries())
          expect(found).toEqual([
            expect.objectContaining({
              code: "custom",
              path: index < 2 ? [field] : [],
              message: `${noun} is one line of plain text: remove ${named}.`,
            }),
          ]);
      }
    }
    // Trimmed first, so breaks around the name go; spaces and visible text stay.
    expect(
      createBotCommandSchema.parse({ name: "\u2028 Ada Lovelace\n\t" }).name,
    ).toBe("Ada Lovelace");
    expect(
      createBotCommandSchema.parse({ name: "Ada", role: "\nReviewer\u2029" })
        .role,
    ).toBe("Reviewer");
    // ZWNJ and ZWJ stay: scripts and emoji sequences need them.
    for (const name of [
      "Zoë",
      "Nova (2)",
      "\u00A0Ada\u00A0Byron",
      "\uD83E\uDD16 Robo",
      "\u{1F469}\u200D\u{1F4BB} Dev",
      "\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645",
    ])
      expect(
        createBotCommandSchema.safeParse({ name, role: name }).success,
      ).toBe(true);
    expect(createBotCommandSchema.safeParse({ name: "\n" }).success).toBe(
      false,
    );
    expect(
      createBotCommandSchema.safeParse({ name: "x".repeat(61) }).success,
    ).toBe(false);
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

  it("validates allowlist hosts, lowercasing and deduplicating them", () => {
    const allowlist = (hosts: string[]) =>
      createRuntimeProfileCommandSchema.safeParse({
        name: "Registry only",
        sandbox: { driver: "docker", network: { mode: "allowlist", hosts } },
      });
    const parsed = allowlist([
      "Registry.NPMJS.org",
      " registry.npmjs.org ",
      "*.pythonhosted.org",
      "files.example.com:8443",
      "93.184.215.14",
    ]);
    expect(parsed.success && parsed.data.sandbox.network).toEqual({
      mode: "allowlist",
      hosts: [
        "registry.npmjs.org",
        "*.pythonhosted.org",
        "files.example.com:8443",
        "93.184.215.14",
      ],
    });
    for (const bad of [
      "https://registry.npmjs.org",
      "registry.npmjs.org/path",
      "*",
      "*.org",
      "*.8.8",
      "*.0x8.0x8:443",
      "two words.com",
      "under_score.com",
      "-leading.com",
      "example.com:0",
      "example.com:65536",
      "[::1]",
      "::1",
      "",
    ]) {
      const result = allowlist(["example.com", bad]);
      expect(result.success, bad).toBe(false);
      expect(result.error?.issues[0]?.path, bad).toEqual([
        "sandbox",
        "network",
        "hosts",
        1,
      ]);
    }
    expect(allowlist([]).success).toBe(false);
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
      mcpServers: [],
      skills: [],
    });
    // A server before 1.7.0 reports neither: nothing is claimed.
    expect(bootstrap.capabilities).toMatchObject({
      mcp: { stdio: false, remote: false },
      skills: false,
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

describe("task summary question", () => {
  const summary = {
    ...task,
    activeSessionCount: 0,
    sessionCount: 1,
    usage,
  };

  it("is optional, and set only while the task is waiting", () => {
    expect(taskSummarySchema.safeParse(summary).success).toBe(true);
    expect(
      taskSummarySchema.safeParse({
        ...summary,
        status: "waiting",
        question: "Which colour?",
      }).success,
    ).toBe(true);
    for (const status of ["running", "completed", "failed"] as const)
      expect(
        taskSummarySchema.safeParse({ ...summary, status, question: "Which?" })
          .success,
      ).toBe(false);
    expect(
      taskSummarySchema.safeParse({
        ...summary,
        status: "waiting",
        question: "x".repeat(TASK_QUESTION_LIMIT + 1),
      }).success,
    ).toBe(false);
  });

  it("is the excerpt of the coordinator's last message to the user", () => {
    const root = { id: "s0", parentSessionId: null };
    const worker = { id: "s1", parentSessionId: "s0" };
    const said = (
      text: string,
      patch: Partial<{
        authorBotId: string;
        sessionId: string;
        intent: "discussion" | "result" | "notification";
        recipientBotIds: string[];
      }> = {},
    ) => ({
      authorKind: "bot" as const,
      authorBotId: "coord",
      sessionId: "s0",
      intent: "discussion" as const,
      recipientBotIds: [],
      text,
      ...patch,
    });
    const view = {
      task: { ...task, status: "waiting" as const },
      sessions: [root, worker],
      messages: [
        said("Earlier status note."),
        said("Which colour,\n\nblue or green?"),
        said("To the worker", { recipientBotIds: ["worker"] }),
        said("From the worker", { authorBotId: "worker", sessionId: "s1" }),
        said("A broadcast", { intent: "notification" }),
      ],
    };
    expect(waitingQuestion(view)).toBe("Which colour, blue or green?");
    expect(
      waitingQuestion({ ...view, task: { ...view.task, status: "running" } }),
    ).toBeUndefined();
    expect(waitingQuestion({ ...view, messages: [] })).toBeUndefined();
    const long = questionExcerpt(`${"x".repeat(TASK_QUESTION_LIMIT - 2)}😀z`);
    expect(long?.length).toBeLessThanOrEqual(TASK_QUESTION_LIMIT);
    expect(long?.endsWith("x…")).toBe(true);
    expect(questionExcerpt(" \n ")).toBeUndefined();
  });
});

describe("spend caps and usage (1.3.0)", () => {
  it("defaults profile caps on, takes null for no cap, and bounds them", () => {
    expect(
      profileBudgetsSchema.parse({ maxTurnsPerRun: 10, maxRunMinutes: 5 }),
    ).toEqual({
      maxTurnsPerRun: 10,
      maxRunMinutes: 5,
      maxUsdPerTask: 5,
      maxUsdPerBotPerDay: 20,
      approveSpendPastThreshold: false,
    });
    expect(
      profileBudgetsSchema.parse({
        maxUsdPerTask: null,
        maxUsdPerBotPerDay: 0.5,
      }),
    ).toMatchObject({ maxUsdPerTask: null, maxUsdPerBotPerDay: 0.5 });
    for (const bad of [0, -1, 10_001, Number.NaN])
      expect(
        profileBudgetsSchema.safeParse({ maxUsdPerTask: bad }).success,
      ).toBe(false);
    // A patch never fills a default cap.
    expect(
      updateRuntimeProfileCommandSchema.parse({ budgets: { maxRunMinutes: 9 } })
        .budgets,
    ).toEqual({ maxRunMinutes: 9 });
    expect(
      updateRuntimeProfileCommandSchema.parse({
        budgets: { maxUsdPerTask: null },
      }).budgets,
    ).toEqual({ maxUsdPerTask: null });
  });

  it("reads tasks and usage stored before caps as uncapped and priced", () => {
    const { spendCapUsd: _cap, ...older } = task;
    expect(taskSchema.parse(older).spendCapUsd).toBeNull();
    const { unpricedCalls: _unpriced, ...olderUsage } = usage;
    expect(usageSchema.parse(olderUsage).unpricedCalls).toBe(0);
    expect(
      addUsage(usage, { ...emptyUsage(), modelCalls: 1, unpricedCalls: 1 }),
    ).toMatchObject({ modelCalls: 2, unpricedCalls: 1, costUsd: 0.001 });
  });

  it("folds unpriced calls into a view's usage", () => {
    const view: TaskView = {
      task,
      sessions: [session],
      messages: [],
      artifacts: [],
      approvals: [],
      verificationChecks: [],
      usage: { total: emptyUsage(), bySession: {} },
      events: [],
      firstSequence: 1,
      hasEarlier: false,
      cursor: 0,
      compactedThrough: 0,
    };
    const folded = applyTaskEvent(
      view,
      parseTaskEvent({
        id: "e1",
        taskId: "t1",
        sequence: 1,
        occurredAt: at,
        botId: "worker",
        sessionId: "s1",
        runId: "r1",
        causedBy: null,
        type: "model.finished",
        payload: {
          model: "free/model",
          stopReason: "stop",
          usage: { ...usage, costUsd: 0, unpricedCalls: 1 },
        },
      }),
    );
    expect(folded.usage.total).toMatchObject({
      modelCalls: 1,
      unpricedCalls: 1,
    });
    expect(folded.usage.bySession.s1?.unpricedCalls).toBe(1);
  });

  it("changes a task's cap with PATCH, null for none", () => {
    expect(updateTaskCommandSchema.safeParse({}).success).toBe(false);
    expect(updateTaskCommandSchema.parse({ spendCapUsd: null })).toEqual({
      spendCapUsd: null,
    });
    expect(updateTaskCommandSchema.safeParse({ spendCapUsd: 0 }).success).toBe(
      false,
    );
    expect(
      createTaskCommandSchema.parse({
        goal: "Go",
        coordinatorBotId: "coord",
        spendCapUsd: 2.5,
      }).spendCapUsd,
    ).toBe(2.5);
  });

  it("formats spend against a cap without changing which is larger", () => {
    expect([5, 12.5, 0.035, 0.5, 0.004789, 0].map(formatUsd)).toEqual([
      "$5.00",
      "$12.50",
      "$0.035",
      "$0.50",
      "$0.004789",
      "$0.00",
    ]);
    const cases: [number, number, string, string][] = [
      [4.996, 5, "$4.996", "$5.00"],
      [5.0000001, 5, "$5.0000001", "$5.00"],
      [0.015, 0.01, "$0.015", "$0.01"],
      [0.004779, 0.004, "$0.004779", "$0.004"],
      [5, 5, "$5.00", "$5.00"],
      [0.42, 5, "$0.42", "$5.00"],
    ];
    for (const [spent, cap, shownSpent, shownCap] of cases)
      expect(formatSpendAgainstCap(spent, cap)).toEqual({
        spent: shownSpent,
        cap: shownCap,
      });
  });

  it("parses a usage report", () => {
    const zero = emptyUsage();
    const report = usageReportSchema.parse({
      asOf: at,
      instance: {
        last24h: zero,
        last7d: zero,
        last30d: zero,
        capUsdPerDay: null,
      },
      bots: [
        {
          botId: "coord",
          name: "Ada",
          archived: false,
          last24h: zero,
          last30d: zero,
          chatLast30d: zero,
          capUsdPerDay: 20,
        },
      ],
      models: [{ model: "openai/gpt", last30d: zero }],
    });
    expect(report.bots[0]?.capUsdPerDay).toBe(20);
  });
});

describe("secrets store (1.5.0)", () => {
  it("names sandbox secrets like environment variables, refusing the reserved ones", () => {
    for (const name of ["GITHUB_TOKEN", "NPM_TOKEN", "A", "X1_2"])
      expect(secretNameSchema.safeParse(name).success, name).toBe(true);
    for (const name of [
      "github_token",
      "1TOKEN",
      "_TOKEN",
      "MY-TOKEN",
      "A".repeat(65),
      "PATH",
      "HOME",
      "HTTPS_PROXY",
      "NO_PROXY",
      "JJ_SECRET_KEY",
      "LD_PRELOAD",
      "NODE_OPTIONS",
      "BASH_ENV",
    ])
      expect(secretNameSchema.safeParse(name).success, name).toBe(false);
    expect(isReservedSecretName("GITHUB_TOKEN")).toBe(false);
    expect(
      secretGrantsSchema.safeParse(["GITHUB_TOKEN", "GITHUB_TOKEN"]).success,
    ).toBe(false);
  });

  it("takes one trimmed line of at least 16 characters, and never repeats it in an issue", () => {
    const value = "ghp_0123456789abcdef";
    expect(putSecretCommandSchema.parse({ value: `  ${value}\n` })).toEqual({
      value,
    });
    for (const bad of [
      "x".repeat(MIN_SECRET_LENGTH - 1),
      `${value}\n${value}`,
      `${value}\u0000`,
      "y".repeat(4097),
    ]) {
      const parsed = putSecretCommandSchema.safeParse({ value: bad });
      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed.error?.issues)).not.toContain(
        bad.slice(0, 12),
      );
    }
  });

  it("reads older answers: providers without a key source, profiles without grants, capabilities without the store", () => {
    const view = modelsViewSchema.parse({
      defaultModel: null,
      providers: [
        {
          id: "openai",
          name: "OpenAI",
          configured: false,
          envVars: [],
          models: [],
        },
      ],
    });
    expect(view.providers[0]).toMatchObject({
      keySource: null,
      storedKey: null,
    });
    expect(
      runtimeProfileSchema.parse({
        id: "p",
        name: "P",
        sandbox: { driver: "local" },
        budgets: {},
        isDefault: true,
        status: { driverAvailable: true, isolated: false },
        createdAt: at,
        updatedAt: at,
      }).secrets,
    ).toEqual([]);
    expect(
      bootstrapSchema.shape.capabilities.parse({
        agentExecution: false,
        persistence: true,
        streaming: true,
        verification: false,
        drivers: [],
      }).secretStore,
    ).toBe(false);
    expect(workspaceHintSchema.parse({ type: "secrets.changed" })).toEqual({
      type: "secrets.changed",
    });
  });
});
