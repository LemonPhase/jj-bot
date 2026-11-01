/**
 * In-memory `JJApi` for running the UI without a backend, always under the
 * "Demo data" badge. It is deterministic (ids are counters, time comes from
 * `now`) and it speaks the contract: commands are validated with the contract
 * schemas, records are contract shapes, and task progress is a stream of
 * contract `TaskEvent`s folded with `applyTaskEvent` and delivered through the
 * same `followTask` code the live client uses. Nothing it shows ran on a model
 * or in a sandbox, and every scripted text says so.
 */
import {
  applyTaskEvent,
  type Bot,
  type BotMemory,
  CONTRACT_VERSION,
  type ConversationMessage,
  type ConversationView,
  createBotCommandSchema,
  createRuntimeProfileCommandSchema,
  createTaskCommandSchema,
  defaultAppearanceFor,
  emptyUsage,
  isFinishedStatus,
  postTaskMessageCommandSchema,
  type RuntimeProfile,
  type SandboxSpec,
  sandboxSpecSchema,
  sendBotMessageCommandSchema,
  stopTaskCommandSchema,
  type Task,
  type TaskEvent,
  type TaskEventOf,
  type TaskEventType,
  type TaskSummary,
  type TaskView,
  updateBotCommandSchema,
  updateBotMemoryCommandSchema,
  updateRuntimeProfileCommandSchema,
  type WorkspaceHint,
  z,
} from "@jj/contracts";
import {
  type ApiBadge,
  ApiError,
  type HintOptions,
  type JJApi,
} from "./client";
import {
  type Ago,
  DEMO_BOTS,
  DEMO_CAPABILITIES,
  DEMO_CONVERSATIONS,
  DEMO_DRIVERS,
  DEMO_MODELS,
  DEMO_TASKS,
  demoProfiles,
} from "./demoFixtures";
import {
  askScript,
  continueScript,
  createRootSession,
  type EventRef,
  type IdKind,
  requestCancel,
  type ScriptHost,
  type Step,
  teamScript,
  userMessage,
} from "./demoScript";
import {
  followConversation,
  followTask,
  type OpenTaskEvents,
  stripToolOutput,
  type TaskEventHandlers,
} from "./follow";

export interface DemoApiOptions {
  /** The demo clock. Defaults to the system clock. */
  now?: () => Date;
  /** Advance running demo tasks on a timer. Off: only `advanceDemoTask` moves them. */
  autoplay?: boolean;
  /** Delay between scripted task steps. */
  stepMs?: number;
  /** Delay before a direct-chat reply arrives. */
  replyMs?: number;
  /** Why the demo is running instead of the live API, for the badge tooltip. */
  reason?: string;
}

export const demoBadge = (reason?: string): ApiBadge => ({
  label: "Demo data",
  tone: "demo",
  title: `Demo data: bots, tasks and replies are simulated in this browser and nothing runs on a model.${reason ? ` ${reason}` : ""}`,
});

interface BotRecord {
  bot: Omit<Bot, "presence" | "activeTaskIds">;
  memory: BotMemory;
  archived: boolean;
}

interface TaskState {
  view: TaskView;
  /** Every event with its full payload (snapshots drop tool output previews). */
  log: TaskEvent[];
  steps: Step[];
  autoplay: boolean;
  timer?: ReturnType<typeof setTimeout>;
  listeners: Set<TaskEventHandlers>;
  host: ScriptHost;
}

const clone = <Value>(value: Value): Value => structuredClone(value);

function validate<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): z.output<Schema> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new ApiError(
    "VALIDATION_FAILED",
    z.prettifyError(parsed.error),
    parsed.error.issues,
    400,
  );
}

/** The server's NOT_FOUND (packages/backend errors.ts `notFound`). */
const notFound = (what: string, id: string) =>
  new ApiError(
    "NOT_FOUND",
    `${what[0]?.toUpperCase()}${what.slice(1)} ${id} was not found.`,
    undefined,
    404,
  );

/** The server's goal version budget (backend config `maxGoalVersions`). */
const MAX_GOAL_VERSIONS = 20;

/** A task title from its goal: the first line, cut at a word near 60 characters. */
export function titleFromGoal(goal: string): string {
  const line = goal.trim().split(/\r?\n/)[0] ?? goal;
  if (line.length <= 60) return line;
  const cut = line.slice(0, 60);
  const space = cut.lastIndexOf(" ");
  return `${(space > 30 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

const isGreetingOrQuestion = (text: string) =>
  /^\s*(hi|hello|hey|yo|thanks|thank you|good (morning|afternoon|evening))\b/i.test(
    text,
  ) || text.trim().endsWith("?");

export function createDemoApi(options: DemoApiOptions = {}): JJApi {
  const clock = options.now ?? (() => new Date());
  const autoplay = options.autoplay ?? true;
  const stepMs = options.stepMs ?? 1600;
  const replyMs = options.replyMs ?? 900;
  const startedAt = clock().getTime();
  const ago: Ago = (minutes) =>
    new Date(startedAt - minutes * 60_000).toISOString();

  /** While seeding, time runs on this virtual clock in the past. */
  let seedClock: number | null = null;
  const now = () => {
    if (seedClock === null) return clock().toISOString();
    seedClock += 700;
    return new Date(seedClock).toISOString();
  };

  const hintListeners = new Set<{
    onHint: (hint: WorkspaceHint) => void;
    options: HintOptions;
  }>();
  const notify = (hint: WorkspaceHint) => {
    for (const listener of [...hintListeners]) listener.onHint(clone(hint));
  };

  // ── Bots, memory, conversations ──────────────────────────────────────────
  const bots = new Map<string, BotRecord>();
  const conversations = new Map<string, ConversationView>();
  let botCounter = 0;
  for (const seed of DEMO_BOTS) {
    const created = ago(60 * 24 * 3);
    bots.set(seed.id, {
      bot: {
        id: seed.id,
        name: seed.name,
        role: seed.role,
        instructions: seed.instructions,
        model: null,
        runtimeProfileId: seed.runtimeProfileId,
        appearance: seed.appearance,
        createdAt: created,
        updatedAt: created,
      },
      memory: { botId: seed.id, text: seed.memory, updatedAt: created },
      archived: false,
    });
  }
  for (const seed of DEMO_CONVERSATIONS)
    conversations.set(seed.botId, {
      botId: seed.botId,
      replying: false,
      lastReplyError: null,
      messages: seed.messages.map((message, index) => ({
        id: `${seed.botId}-c${index + 1}`,
        botId: seed.botId,
        sequence: index + 1,
        role: message.role,
        text: message.text,
        taskId: message.taskId ?? null,
        createdAt: ago(message.minutesAgo),
      })),
    });

  const profiles = new Map<string, RuntimeProfile>(
    demoProfiles(ago).map((profile) => [profile.id, profile]),
  );
  let profileCounter = 0;

  // ── Tasks ────────────────────────────────────────────────────────────────
  const tasks = new Map<string, TaskState>();
  let taskCounter = 103;

  const getState = (taskId: string) => {
    const state = tasks.get(taskId);
    if (!state) throw notFound("task", taskId);
    return state;
  };

  const derive = (record: BotRecord): Bot => {
    const active: string[] = [];
    let working = false;
    for (const { view } of tasks.values()) {
      if (!view.task.participantBotIds.includes(record.bot.id)) continue;
      if (!isFinishedStatus(view.task.status)) active.push(view.task.id);
      if (
        view.sessions.some(
          (s) =>
            s.botId === record.bot.id &&
            (s.status === "queued" || s.status === "running"),
        )
      )
        working = true;
    }
    return clone({
      ...record.bot,
      presence: working ? "working" : "idle",
      activeTaskIds: active,
    });
  };
  const botState = () =>
    JSON.stringify(
      [...bots.values()].map((record) => {
        const bot = derive(record);
        return [bot.id, bot.presence, bot.activeTaskIds];
      }),
    );

  const summarize = ({ view }: TaskState): TaskSummary => ({
    ...clone(view.task),
    activeSessionCount: view.sessions.filter(
      (s) => s.status === "queued" || s.status === "running",
    ).length,
    sessionCount: view.sessions.length,
    usage: clone(view.usage.total),
  });

  const createTaskState = (task: Task, autoplayTask: boolean): TaskState => {
    const counters: Record<IdKind, number> = {
      session: 0,
      message: 0,
      run: 0,
      tool: 0,
      artifact: 0,
    };
    const prefixes: Record<IdKind, string> = {
      session: "s",
      message: "m",
      run: "r",
      tool: "t",
      artifact: "a",
    };
    const state: TaskState = {
      view: {
        task,
        sessions: [],
        messages: [],
        artifacts: [],
        usage: { total: emptyUsage(), bySession: {} },
        events: [],
        firstSequence: 1,
        hasEarlier: false,
        cursor: 0,
      },
      log: [],
      steps: [],
      autoplay: autoplayTask,
      listeners: new Set(),
      host: {
        taskId: task.id,
        view: () => state.view,
        now,
        nextId: (kind) => `${task.id}-${prefixes[kind]}${++counters[kind]}`,
        emit: <Type extends TaskEventType>(
          type: Type,
          payload: TaskEventOf<Type>["payload"],
          ref: EventRef = {},
        ) => {
          const sequence = state.view.cursor + 1;
          const event = {
            id: `${task.id}-e${sequence}`,
            taskId: task.id,
            sequence,
            occurredAt: now(),
            botId: ref.botId ?? null,
            sessionId: ref.sessionId ?? null,
            runId: ref.runId ?? null,
            causedBy: ref.causedBy ?? null,
            type,
            payload,
          } as TaskEventOf<Type>;
          state.log.push(event);
          state.view = applyTaskEvent(state.view, event);
          for (const listener of [...state.listeners])
            listener.onEvent(clone(event));
          return event;
        },
        botName: (botId) => bots.get(botId)?.bot.name ?? "a teammate",
        runs: new Map(),
        storeArtifact: (artifactId, content) =>
          artifactContent.set(artifactId, content),
      },
    };
    tasks.set(task.id, state);
    return state;
  };
  const artifactContent = new Map<string, string>();

  /** Runs one step of a task's script, then tells the workspace what changed. */
  const step = (state: TaskState) => {
    const next = state.steps.shift();
    if (!next) return false;
    const before = botState();
    next();
    notify({ type: "tasks.changed", taskId: state.view.task.id });
    if (botState() !== before) notify({ type: "bots.changed" });
    return true;
  };

  const schedule = (state: TaskState) => {
    clearTimeout(state.timer);
    state.timer = undefined;
    if (!state.autoplay || !autoplay || state.steps.length === 0) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      step(state);
      schedule(state);
    }, stepMs);
  };

  const newTask = (input: {
    id: string;
    goal: string;
    coordinatorBotId: string;
    participantBotIds: string[];
    title?: string;
  }): TaskState => {
    const createdAt = now();
    const task: Task = {
      id: input.id,
      title: input.title ?? titleFromGoal(input.goal),
      goal: input.goal,
      goalVersion: 1,
      coordinatorBotId: input.coordinatorBotId,
      participantBotIds: input.participantBotIds,
      status: "queued",
      result: null,
      error: null,
      cancelReason: null,
      cancelRequestedAt: null,
      createdAt,
      updatedAt: createdAt,
      finishedAt: null,
    };
    const state = createTaskState(task, true);
    state.host.emit("task.created", { task });
    // The server creates the coordinator's session with the task.
    createRootSession(state.host);
    return state;
  };

  // Seeded tasks are played through their scripts on a clock in the past.
  for (const seed of DEMO_TASKS) {
    seedClock = startedAt - seed.startedMinutesAgo * 60_000;
    const state = newTask(seed);
    state.autoplay = seed.autoplay;
    state.steps =
      seed.script === "ask" ? askScript(state.host) : teamScript(state.host);
    const count =
      seed.playedSteps === "all" ? state.steps.length : seed.playedSteps;
    for (let index = 0; index < count; index += 1) {
      seedClock += 20_000;
      state.steps.shift()?.();
    }
  }
  seedClock = null;
  for (const state of tasks.values()) schedule(state);

  const createTask = (command: unknown): Task => {
    const parsed = validate(createTaskCommandSchema, command);
    // As services/tasks.ts `createTask`.
    if (parsed.verificationPlan)
      throw new ApiError(
        "VERIFICATION_UNAVAILABLE",
        "Verification plans are not enforced by this server yet; create the task without one.",
        undefined,
        422,
      );
    const missing = parsed.participantBotIds.filter((botId) => {
      const record = bots.get(botId);
      return !record || record.archived;
    });
    if (missing.length > 0)
      throw new ApiError(
        "VALIDATION_FAILED",
        `Unknown bot: ${missing.join(", ")}.`,
        { botIds: missing },
        400,
      );
    const before = botState();
    const state = newTask({ ...parsed, id: `task-${++taskCounter}` });
    state.steps = teamScript(state.host);
    notify({ type: "tasks.changed", taskId: state.view.task.id });
    if (botState() !== before) notify({ type: "bots.changed" });
    schedule(state);
    return clone(state.view.task);
  };

  // ── Direct chat ──────────────────────────────────────────────────────────
  const appendMessage = (
    botId: string,
    message: Omit<
      ConversationMessage,
      "id" | "botId" | "sequence" | "createdAt"
    >,
  ): ConversationMessage => {
    const view = conversations.get(botId) ?? {
      botId,
      messages: [],
      replying: false,
      lastReplyError: null,
    };
    conversations.set(botId, view);
    const sequence = view.messages.length + 1;
    const stored: ConversationMessage = {
      ...message,
      id: `${botId}-c${sequence}`,
      botId,
      sequence,
      createdAt: now(),
    };
    view.messages.push(stored);
    return stored;
  };

  const reply = (botId: string, text: string) => {
    const view = conversations.get(botId);
    const record = bots.get(botId);
    if (!view || !record) return;
    view.replying = false;
    if (isGreetingOrQuestion(text)) {
      appendMessage(botId, {
        role: "assistant",
        text: `Hi! This is a scripted demo reply from ${record.bot.name}: no model is connected, so I can't really answer. Ask me to do something and I'll start a demo task.`,
        taskId: null,
      });
    } else {
      const teammates = [...bots.values()]
        .filter((other) => !other.archived && other.bot.id !== botId)
        .slice(0, 2)
        .map((other) => other.bot.id);
      const task = createTask({
        goal: text,
        coordinatorBotId: botId,
        participantBotIds: [botId, ...teammates],
      });
      appendMessage(botId, {
        role: "assistant",
        text: "I've started a demo task for this. Its progress is simulated: no model or sandbox runs in demo mode.",
        taskId: task.id,
      });
    }
    notify({ type: "conversation.changed", botId });
  };

  // ── Profiles ─────────────────────────────────────────────────────────────
  const unsupported = (message: string) =>
    new ApiError("PROFILE_UNSUPPORTED", message, undefined, 422);
  /**
   * Refuses what the server refuses, with the same messages: the server
   * answers PROFILE_UNSUPPORTED with the driver's own error (packages/sandbox
   * `assertSpecSupported`, then each driver's `validateSpec`).
   */
  const assertSupported = (spec: SandboxSpec) => {
    const driver = DEMO_DRIVERS.find((d) => d.id === spec.driver);
    if (!driver)
      throw unsupported(
        `No sandbox driver "${spec.driver}" is installed on this server.`,
      );
    if (!driver.capabilities.networkModes.includes(spec.network.mode))
      throw unsupported(
        `Driver ${driver.id} cannot enforce network.mode="${spec.network.mode}"`,
      );
    const wantsLimits = Object.values(spec.resources).some(
      (v) => v !== undefined,
    );
    if (wantsLimits && !driver.capabilities.resourceLimits)
      throw unsupported(`Driver ${driver.id} cannot enforce resources`);
    if (driver.id === "local" && spec.image !== undefined)
      throw unsupported(
        `Driver local cannot enforce image "${spec.image}": commands run directly on the host`,
      );
    if (driver.id === "docker" && spec.resources.diskMb !== undefined)
      throw unsupported(
        "Driver docker cannot enforce resources.diskMb: named volumes have no size limit",
      );
    const configKeys = Object.keys(spec.driverConfig);
    if (configKeys.length > 0)
      throw unsupported(
        `Driver ${driver.id} takes no driverConfig; got ${configKeys.join(", ")}`,
      );
  };
  const profileStatus = (spec: SandboxSpec): RuntimeProfile["status"] => {
    const driver = DEMO_DRIVERS.find((d) => d.id === spec.driver);
    return {
      driverAvailable: driver?.available ?? false,
      isolated: driver?.capabilities.filesystemIsolation ?? false,
      detail: driver?.detail,
    };
  };
  const makeDefault = (profileId: string) => {
    for (const profile of profiles.values())
      profile.isDefault = profile.id === profileId;
  };
  const getProfileRecord = (profileId: string) => {
    const profile = profiles.get(profileId);
    if (!profile) throw notFound("runtime profile", profileId);
    return profile;
  };
  const getBotRecord = (botId: string) => {
    const record = bots.get(botId);
    if (!record) throw notFound("bot", botId);
    return record;
  };
  const assertNameFree = (name: string, exceptId?: string) => {
    const taken = [...bots.values()].some(
      (record) =>
        !record.archived &&
        record.bot.id !== exceptId &&
        record.bot.name.toLowerCase() === name.toLowerCase(),
    );
    if (taken)
      throw new ApiError(
        "CONFLICT",
        `A bot named ${name} already exists.`,
        undefined,
        409,
      );
  };
  const checkBotRefs = (fields: { runtimeProfileId?: string | null }) => {
    if (fields.runtimeProfileId && !profiles.has(fields.runtimeProfileId))
      throw new ApiError(
        "VALIDATION_FAILED",
        `Runtime profile ${fields.runtimeProfileId} does not exist.`,
        undefined,
        400,
      );
  };

  // ── Task events for followTask ───────────────────────────────────────────
  const openTaskEvents: OpenTaskEvents = (taskId, after, handlers) => {
    const state = tasks.get(taskId);
    if (!state) {
      handlers.onError(false);
      return () => {};
    }
    handlers.onOpen();
    for (const event of state.log)
      if (event.sequence > after) handlers.onEvent(clone(event));
    state.listeners.add(handlers);
    return () => state.listeners.delete(handlers);
  };

  const getTask = async (taskId: string): Promise<TaskView> => {
    const { view } = getState(taskId);
    // Snapshot events drop `tool.finished` output previews, as the live API does.
    return clone({ ...view, events: view.events.map(stripToolOutput) });
  };
  const getConversation = async (botId: string) => {
    getBotRecord(botId);
    return clone(
      conversations.get(botId) ?? {
        botId,
        messages: [],
        replying: false,
        lastReplyError: null,
      },
    );
  };
  const subscribeHints: JJApi["subscribeHints"] = (
    onHint,
    hintOptions = {},
  ) => {
    const listener = { onHint, options: hintOptions };
    hintListeners.add(listener);
    hintOptions.onState?.("open");
    return () => {
      hintListeners.delete(listener);
    };
  };

  const activeBots = () =>
    [...bots.values()].filter((record) => !record.archived).map(derive);

  return {
    mode: "demo",
    badge: demoBadge(options.reason),
    capabilities: clone(DEMO_CAPABILITIES),
    contractVersion: CONTRACT_VERSION,

    bootstrap: async () => ({
      mode: "scaffold",
      contractVersion: CONTRACT_VERSION,
      capabilities: clone(DEMO_CAPABILITIES),
      defaultModel: DEMO_MODELS.defaultModel,
      bots: activeBots(),
      tasks: [...tasks.values()]
        .map(summarize)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      profiles: clone([...profiles.values()]),
    }),
    subscribeHints,

    listBots: async () => activeBots(),
    getBot: async (botId) => derive(getBotRecord(botId)),
    createBot: async (command) => {
      const parsed = validate(createBotCommandSchema, command);
      checkBotRefs(parsed);
      assertNameFree(parsed.name);
      const id = `bot-new-${++botCounter}`;
      const createdAt = now();
      const record: BotRecord = {
        bot: {
          id,
          name: parsed.name,
          role: parsed.role ?? "",
          instructions: parsed.instructions ?? "",
          model: parsed.model ?? null,
          runtimeProfileId: parsed.runtimeProfileId ?? null,
          appearance: parsed.appearance ?? defaultAppearanceFor(parsed.name),
          createdAt,
          updatedAt: createdAt,
        },
        memory: { botId: id, text: "", updatedAt: createdAt },
        archived: false,
      };
      bots.set(id, record);
      conversations.set(id, {
        botId: id,
        messages: [],
        replying: false,
        lastReplyError: null,
      });
      notify({ type: "bots.changed", botId: id });
      return derive(record);
    },
    updateBot: async (botId, command) => {
      const record = getBotRecord(botId);
      const parsed = validate(updateBotCommandSchema, command);
      checkBotRefs(parsed);
      if (parsed.name !== undefined) assertNameFree(parsed.name, botId);
      const changes = Object.fromEntries(
        Object.entries(parsed).filter(([, value]) => value !== undefined),
      );
      record.bot = { ...record.bot, ...changes, updatedAt: now() };
      notify({ type: "bots.changed", botId });
      return derive(record);
    },
    archiveBot: async (botId) => {
      const record = getBotRecord(botId);
      const bot = derive(record);
      if (bot.activeTaskIds.length)
        throw new ApiError(
          "CONFLICT",
          `${bot.name} still takes part in ${bot.activeTaskIds.length} unfinished task(s); stop or finish them first.`,
          { activeTaskIds: bot.activeTaskIds },
          409,
        );
      record.archived = true;
      notify({ type: "bots.changed", botId });
    },
    getMemory: async (botId) => clone(getBotRecord(botId).memory),
    putMemory: async (botId, command) => {
      const record = getBotRecord(botId);
      const { text } = validate(updateBotMemoryCommandSchema, command);
      record.memory = { botId, text, updatedAt: now() };
      return clone(record.memory);
    },

    getConversation,
    sendBotMessage: async (botId, command) => {
      const record = getBotRecord(botId);
      if (record.archived) throw notFound("bot", botId);
      const { text } = validate(sendBotMessageCommandSchema, command);
      const message = appendMessage(botId, {
        role: "user",
        text,
        taskId: null,
      });
      const view = conversations.get(botId);
      if (view) view.replying = true;
      notify({ type: "conversation.changed", botId });
      setTimeout(() => reply(botId, text), replyMs);
      return clone(message);
    },
    subscribeConversation: (botId, onView, streamOptions) =>
      followConversation(
        botId,
        getConversation,
        subscribeHints,
        onView,
        streamOptions,
      ),

    listProfiles: async () => clone([...profiles.values()]),
    getProfile: async (profileId) => clone(getProfileRecord(profileId)),
    createProfile: async (command) => {
      const parsed = validate(createRuntimeProfileCommandSchema, command);
      assertSupported(parsed.sandbox);
      const createdAt = now();
      const profile: RuntimeProfile = {
        id: `profile-new-${++profileCounter}`,
        name: parsed.name,
        description: parsed.description ?? "",
        sandbox: parsed.sandbox,
        tools: parsed.tools ?? [
          "bash",
          "read",
          "edit",
          "write",
          "grep",
          "find",
          "ls",
        ],
        budgets: parsed.budgets ?? { maxTurnsPerRun: 60, maxRunMinutes: 30 },
        isDefault: false,
        status: profileStatus(parsed.sandbox),
        createdAt,
        updatedAt: createdAt,
      };
      profiles.set(profile.id, profile);
      if (parsed.isDefault) makeDefault(profile.id);
      notify({ type: "profiles.changed" });
      return clone(profile);
    },
    updateProfile: async (profileId, command) => {
      const stored = getProfileRecord(profileId);
      const patch = validate(updateRuntimeProfileCommandSchema, command);
      if (patch.isDefault === false && stored.isDefault)
        throw new ApiError(
          "CONFLICT",
          "Make another profile the default instead of unsetting this one.",
          undefined,
          409,
        );
      // Deep-merge as the server does: tools, network, env and driverConfig
      // are replaced whole, and a driver change drops the old driver's image
      // and driverConfig unless the patch sets them.
      const switching =
        patch.sandbox?.driver !== undefined &&
        patch.sandbox.driver !== stored.sandbox.driver;
      const base: Partial<SandboxSpec> = switching
        ? { ...stored.sandbox, image: undefined, driverConfig: {} }
        : stored.sandbox;
      const changes = Object.fromEntries(
        Object.entries(patch.sandbox ?? {}).filter(([, v]) => v !== undefined),
      );
      const merged: Record<string, unknown> = {
        ...base,
        ...changes,
        resources: { ...base.resources, ...patch.sandbox?.resources },
        limits: { ...base.limits, ...patch.sandbox?.limits },
      };
      if (merged.image === undefined) delete merged.image;
      const sandbox = validate(sandboxSpecSchema, merged);
      assertSupported(sandbox);
      const next: RuntimeProfile = {
        ...stored,
        name: patch.name ?? stored.name,
        description: patch.description ?? stored.description,
        tools: patch.tools ?? stored.tools,
        budgets: { ...stored.budgets, ...patch.budgets },
        sandbox,
        status: profileStatus(sandbox),
        updatedAt: now(),
      };
      profiles.set(profileId, next);
      if (patch.isDefault) makeDefault(profileId);
      notify({ type: "profiles.changed" });
      return clone(next);
    },
    deleteProfile: async (profileId) => {
      const profile = getProfileRecord(profileId);
      if (profile.isDefault)
        throw new ApiError(
          "CONFLICT",
          "This is the default profile; make another profile the default first.",
          undefined,
          409,
        );
      const users = [...bots.values()].filter(
        (record) =>
          !record.archived && record.bot.runtimeProfileId === profileId,
      );
      if (users.length)
        throw new ApiError(
          "PROFILE_IN_USE",
          `Used by ${users.map((u) => u.bot.name).join(", ")}.`,
          { botIds: users.map((u) => u.bot.id) },
          409,
        );
      profiles.delete(profileId);
      notify({ type: "profiles.changed" });
    },
    listDrivers: async () => clone([...DEMO_DRIVERS]),
    getModels: async () => clone(DEMO_MODELS),

    listTasks: async () =>
      [...tasks.values()]
        .map(summarize)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    createTask: async (command) => createTask(command),
    getTask,
    // As services/messages.ts `postTaskMessage`, check for check and message
    // for message.
    postTaskMessage: async (taskId, command) => {
      const parsed = validate(postTaskMessageCommandSchema, command);
      if (parsed.verificationPlan)
        throw new ApiError(
          "VERIFICATION_UNAVAILABLE",
          "Verification plans are not enforced by this server yet.",
          undefined,
          422,
        );
      const state = getState(taskId);
      const { task } = state.view;
      if (task.status === "cancelled" || task.cancelRequestedAt)
        throw new ApiError(
          "TASK_TERMINAL",
          task.status === "cancelled"
            ? "The task was cancelled; start a new task to continue the work."
            : "The task is stopping and takes no new messages.",
          undefined,
          409,
        );
      if (parsed.goal !== undefined && parsed.goal !== task.goal) {
        if (parsed.observedGoalVersion !== task.goalVersion)
          throw new ApiError(
            "STALE_GOAL_VERSION",
            `The goal is at version ${task.goalVersion}; you edited version ${parsed.observedGoalVersion}.`,
            { goalVersion: task.goalVersion },
            409,
          );
        if (task.goalVersion >= MAX_GOAL_VERSIONS)
          throw new ApiError(
            "GOAL_VERSION_BUDGET",
            `The goal can change at most ${MAX_GOAL_VERSIONS - 1} times; start a new task instead.`,
            undefined,
            409,
          );
      }
      const before = botState();
      const { message, reopened } = userMessage(state.host, parsed);
      if (reopened) {
        state.steps.push(...continueScript(state.host));
        // Seeded tasks start paused; one the user continued must move on its own.
        state.autoplay = true;
      }
      notify({ type: "tasks.changed", taskId });
      if (botState() !== before) notify({ type: "bots.changed" });
      schedule(state);
      return clone(message);
    },
    // As services/tasks.ts `stopTask`: idempotent while stopping or cancelled,
    // CONFLICT once completed or failed.
    stopTask: async (taskId, command = {}) => {
      const { reason } = validate(stopTaskCommandSchema, command);
      const state = getState(taskId);
      const { task } = state.view;
      if (task.status === "cancelled" || task.cancelRequestedAt)
        return clone(task);
      if (task.status === "completed" || task.status === "failed")
        throw new ApiError(
          "CONFLICT",
          `The task already ${task.status}; there is nothing to stop.`,
          undefined,
          409,
        );
      const before = botState();
      const settle = requestCancel(state.host, reason ?? null);
      state.steps = settle ? [settle] : [];
      state.autoplay = true;
      notify({ type: "tasks.changed", taskId });
      if (botState() !== before) notify({ type: "bots.changed" });
      schedule(state);
      return clone(state.view.task);
    },
    subscribeTask: (taskId, onView, streamOptions) =>
      followTask(taskId, getTask, openTaskEvents, onView, {
        retryMs: 500,
        ...streamOptions,
      }),
    artifactUrl: (_taskId, artifactId) =>
      `data:text/markdown;charset=utf-8,${encodeURIComponent(
        artifactContent.get(artifactId) ??
          "Demo data: this artifact has no content.",
      )}`,

    advanceDemoTask: async (taskId) => {
      const state = getState(taskId);
      step(state);
      schedule(state);
    },
  };
}
