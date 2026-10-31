import { randomUUID } from "node:crypto";
import {
  type Bot,
  type TaskEvent,
  type TaskMessage,
  taskSchema,
} from "@jj/contracts";
import {
  type CheckDefinition,
  type CheckRecord,
  type ConversationMessage,
  type CreateBotInput,
  type CreateTaskInput,
  createBotSchema,
  createTaskSchema,
  type JobRecord,
  type MemoryRecord,
  type PostMessageInput,
  postMessageSchema,
  type SessionRecord,
  type SpawnSessionInput,
  type SteerTaskInput,
  spawnSessionSchema,
  steerTaskSchema,
  type TaskRecord,
} from "@jj/contracts/backend";
import type { BackendStore, StoreTx } from "@jj/db";
import {
  type BotRouter,
  type BotTurnDecision,
  builtinTools,
  fallbackBotTurn,
  type RuntimeTool,
  type SessionExecutor,
} from "@jj/runtime";

export class BackendError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BackendError";
  }
}
const now = () => new Date().toISOString();
const terminal = new Set(["completed", "failed", "cancelled"]);
const DEFAULT_TURN_PLAN = [
  {
    id: "request",
    description:
      "Address the user request accurately, with supporting evidence and any remaining limitations.",
    method: "Independent rubric review",
    expectedEvidence: "Supporting context/tool results and reviewer assessment",
  },
];

export interface BackendServiceOptions {
  store: BackendStore;
  executor: SessionExecutor;
  router?: BotRouter;
  workerId?: string;
  leaseMs?: number;
  concurrency?: number;
  maxSessions?: number;
  maxDepth?: number;
}

/** Application orchestration. Provider threads never replace durable JJ task/session identities. */
export class BackendService {
  readonly store: BackendStore;
  private readonly executor: SessionExecutor;
  private readonly router: BotRouter;
  private readonly workerId: string;
  private readonly leaseMs: number;
  private readonly concurrency: number;
  private readonly maxSessions: number;
  private readonly maxDepth: number;
  private readonly active = new Map<string, AbortController>();
  private timer?: ReturnType<typeof setInterval>;
  private stopped = false;
  private ticking = false;
  private readonly pending = new Set<Promise<unknown>>();

  constructor(options: BackendServiceOptions) {
    this.store = options.store;
    this.executor = options.executor;
    this.router = options.router ?? {
      decide: async (input) => fallbackBotTurn(input.text),
    };
    this.workerId = options.workerId ?? randomUUID();
    this.leaseMs = Math.max(300, options.leaseMs ?? 30_000);
    this.concurrency = Math.max(1, options.concurrency ?? 4);
    this.maxSessions = Math.max(2, options.maxSessions ?? 64);
    this.maxDepth = Math.max(1, options.maxDepth ?? 8);
  }

  private async requireTask(tx: StoreTx, id: string) {
    const task = await tx.get<TaskRecord>("tasks", id);
    if (!task) throw new BackendError(404, "TASK_NOT_FOUND", "Task not found");
    return task;
  }
  private async requireBot(tx: StoreTx, id: string) {
    const bot = await tx.get<Bot>("bots", id);
    if (!bot) throw new BackendError(404, "BOT_NOT_FOUND", "Bot not found");
    return bot;
  }
  private async updateTask(tx: StoreTx, task: TaskRecord) {
    task.updatedAt = now();
    await tx.put("tasks", task.id, task);
  }
  private assertPlan(
    plan: TaskRecord["verificationPlan"],
    checks: CheckDefinition[] | undefined,
  ) {
    if (plan.length < 1 || plan.length > 32)
      throw new BackendError(
        400,
        "INVALID_VERIFICATION_PLAN",
        "A task requires between 1 and 32 verification criteria",
      );
    const ids = new Set<string>();
    for (const criterion of plan) {
      if (ids.has(criterion.id))
        throw new BackendError(
          400,
          "INVALID_VERIFICATION_PLAN",
          "Verification criteria must have unique ids",
        );
      ids.add(criterion.id);
    }
    for (const check of checks ?? [])
      if (!ids.has(check.id))
        throw new BackendError(
          400,
          "INVALID_CHECK",
          "Every check must reference a verification criterion",
        );
  }

  async createBot(input: CreateBotInput): Promise<Bot> {
    const bot = { ...createBotSchema.parse(input), id: randomUUID() };
    await this.store.transaction((tx) => tx.put("bots", bot.id, bot));
    return bot;
  }
  listBots() {
    return this.store.read((tx) => tx.list<Bot>("bots"));
  }
  getBot(id: string) {
    return this.store.read((tx) => this.requireBot(tx, id));
  }
  async setMemory(botId: string, text: string): Promise<MemoryRecord> {
    return this.store.transaction(async (tx) => {
      await this.requireBot(tx, botId);
      const memory = { id: botId, botId, text, updatedAt: now() };
      await tx.put("memory", botId, memory);
      return memory;
    });
  }
  async getMemory(botId: string): Promise<MemoryRecord> {
    return this.store.read(async (tx) => {
      await this.requireBot(tx, botId);
      return (
        (await tx.get<MemoryRecord>("memory", botId)) ?? {
          id: botId,
          botId,
          text: "",
          updatedAt: now(),
        }
      );
    });
  }
  private async nextConversationSequence(tx: StoreTx, botId: string) {
    const messages = await tx.list<ConversationMessage>("conversations");
    return (
      messages.reduce(
        (max, message) =>
          message.botId === botId ? Math.max(max, message.sequence ?? 0) : max,
        0,
      ) + 1
    );
  }
  async recordConversation(input: {
    botId: string;
    role: "user" | "assistant";
    text: string;
    taskId?: string;
  }): Promise<ConversationMessage> {
    const { botId } = input;
    return this.store.transaction(async (tx) => {
      await this.requireBot(tx, botId);
      const message = {
        ...input,
        id: randomUUID(),
        botId,
        createdAt: now(),
        sequence: await this.nextConversationSequence(tx, botId),
      };
      await tx.put("conversations", message.id, message);
      return message;
    });
  }
  async listConversation(botId: string) {
    return this.store.read(async (tx) => {
      await this.requireBot(tx, botId);
      return (await tx.list<ConversationMessage>("conversations"))
        .filter((message) => message.botId === botId)
        .sort(
          (a, b) =>
            (a.sequence ?? 0) - (b.sequence ?? 0) ||
            a.createdAt.localeCompare(b.createdAt),
        );
    });
  }

  /**
   * Route a direct message to a bot. Conversation stays in the bot chat; work
   * becomes a task, and a follow-up is forwarded to an active task rather than
   * duplicating it.
   */
  async botTurn(
    botId: string,
    text: string,
  ): Promise<{ kind: "reply" | "task" | "routed"; task?: TaskRecord }> {
    const input = text.trim();
    if (!input)
      throw new BackendError(400, "EMPTY_MESSAGE", "Message must contain text");
    const bot = await this.getBot(botId);
    const [memory, conversation, tasks] = await Promise.all([
      this.getMemory(botId),
      this.listConversation(botId),
      this.listTasks(),
    ]);
    const active = tasks
      .filter(
        (task) =>
          task.participantBotIds.includes(botId) && !terminal.has(task.status),
      )
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .slice(0, 8);
    let decision: BotTurnDecision;
    try {
      decision = await this.router.decide({
        bot,
        memory: memory.text,
        messages: conversation.map((message) => ({
          role: message.role,
          text: message.text,
        })),
        tasks: active.map((task) => ({
          id: task.id,
          goal: task.goal,
          status: task.status,
          goalVersion: task.goalVersion,
          result: task.result,
        })),
        text: input,
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      decision = fallbackBotTurn(input);
    }
    if (decision.kind === "reply" && decision.reply?.trim()) {
      await this.recordConversation({ botId, role: "user", text: input });
      await this.recordConversation({
        botId,
        role: "assistant",
        text: decision.reply.trim(),
      });
      return { kind: "reply" };
    }
    if (decision.kind === "existing_task") {
      const target = active.find((task) => task.id === decision.taskId);
      if (target) {
        await this.postMessage(target.id, {
          authorKind: "user",
          authorId: "user",
          text: input,
          intent: "assignment",
          activateBotIds: [botId],
        });
        await this.recordConversation({
          botId,
          role: "user",
          text: input,
          taskId: target.id,
        });
        return { kind: "routed", task: await this.getTask(target.id) };
      }
    }
    const task = await this.createTask({
      goal: input,
      coordinatorBotId: botId,
      participantBotIds: [botId],
      verificationPlan: DEFAULT_TURN_PLAN,
    });
    await this.recordConversation({
      botId,
      role: "user",
      text: input,
      taskId: task.id,
    });
    return { kind: "task", task };
  }

  async createTask(input: CreateTaskInput): Promise<TaskRecord> {
    const parsed = createTaskSchema.parse(input);
    this.assertPlan(parsed.verificationPlan, parsed.checks);
    return this.store.transaction(async (tx) => {
      for (const botId of parsed.participantBotIds)
        await this.requireBot(tx, botId);
      const task: TaskRecord = {
        ...parsed,
        id: randomUUID(),
        goalVersion: 1,
        status: parsed.autoStart ? "queued" : "waiting",
        createdAt: now(),
        updatedAt: now(),
      };
      taskSchema.parse(task);
      await tx.put("tasks", task.id, task);
      await tx.appendEvent({
        taskId: task.id,
        botId: task.coordinatorBotId,
        type: "task.created",
        payload: { task },
      });
      if (parsed.autoStart) {
        for (const botId of task.participantBotIds)
          await this.enqueue(tx, task, {
            botId,
            brief: task.goal,
            verificationPlan: task.verificationPlan,
            checks: task.checks,
          });
      }
      return task;
    });
  }
  getTask(id: string) {
    return this.store.read((tx) => this.requireTask(tx, id));
  }
  listTasks() {
    return this.store.read((tx) => tx.list<TaskRecord>("tasks"));
  }
  async snapshot(id: string) {
    const snapshot = await this.store.read(async (tx) => {
      const task = await this.requireTask(tx, id);
      const allBots = await tx.list<Bot>("bots");
      const participants = task.participantBotIds
        .map((botId) => allBots.find((bot) => bot.id === botId))
        .filter((bot): bot is Bot => Boolean(bot));
      const checks = (await tx.list<CheckRecord>("checks")).filter(
        (check) => check.taskId === id,
      );
      return {
        task,
        bots: participants,
        participants,
        sessions: (await tx.list<SessionRecord>("sessions")).filter(
          (session) => session.taskId === id,
        ),
        messages: (
          await tx.list<TaskMessage & { createdAt?: string }>("messages")
        )
          .filter((message) => message.taskId === id)
          .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? "")),
        checks,
        verificationResults: checks,
        events: await tx.events(id),
      };
    });
    const replayCursor = snapshot.events.at(-1)?.sequence ?? 0;
    return { ...snapshot, replayCursor };
  }
  getTaskView(id: string) {
    return this.snapshot(id);
  }

  private async enqueue(
    tx: StoreTx,
    task: TaskRecord,
    input: SpawnSessionInput,
    kind: "work" | "synthesis" = "work",
  ) {
    if (!task.participantBotIds.includes(input.botId))
      throw new BackendError(
        400,
        "NOT_PARTICIPANT",
        "Bot must participate in this task",
      );
    await this.requireBot(tx, input.botId);
    if (input.parentSessionId) {
      const parent = await tx.get<SessionRecord>(
        "sessions",
        input.parentSessionId,
      );
      if (!parent || parent.taskId !== task.id)
        throw new BackendError(
          400,
          "INVALID_PARENT",
          "Parent session must belong to this task",
        );
    }
    const taskSessions = (await tx.list<SessionRecord>("sessions")).filter(
      (item) => item.taskId === task.id,
    );
    // Superseded sessions must not permanently consume the budget.
    const liveSessions = taskSessions.filter(
      (item) => item.status !== "cancelled",
    );
    if (liveSessions.length >= this.maxSessions)
      throw new BackendError(
        409,
        "SESSION_BUDGET",
        `Task session budget reached (${this.maxSessions})`,
      );
    let depth = 0;
    let parentId = input.parentSessionId;
    while (parentId) {
      depth += 1;
      if (depth > this.maxDepth)
        throw new BackendError(
          409,
          "SESSION_DEPTH",
          "Task delegation depth limit reached",
        );
      parentId = taskSessions.find(
        (item) => item.id === parentId,
      )?.parentSessionId;
    }
    const session: SessionRecord = {
      ...input,
      id: randomUUID(),
      taskId: task.id,
      goalVersion: task.goalVersion,
      kind,
      status: "queued",
      createdAt: now(),
      updatedAt: now(),
      attempts: 0,
    };
    const job: JobRecord = {
      id: randomUUID(),
      taskId: task.id,
      sessionId: session.id,
      status: "queued",
      attempts: 0,
      createdAt: now(),
    };
    await tx.put("sessions", session.id, session);
    await tx.put("jobs", job.id, job);
    return session;
  }
  async spawnSession(
    taskId: string,
    input: SpawnSessionInput,
  ): Promise<SessionRecord> {
    const parsed = spawnSessionSchema.parse(input);
    this.assertPlan(parsed.verificationPlan, parsed.checks);
    return this.store.transaction(async (tx) => {
      const task = await this.requireTask(tx, taskId);
      if (task.status === "cancelled")
        throw new BackendError(409, "TASK_CANCELLED", "Task is cancelled");
      task.status = "running";
      task.result = undefined;
      await this.updateTask(tx, task);
      return this.enqueue(tx, task, parsed);
    });
  }

  async postMessage(
    taskId: string,
    input: PostMessageInput,
  ): Promise<TaskMessage> {
    const parsed = postMessageSchema.parse(input);
    return this.store.transaction(async (tx) => {
      const task = await this.requireTask(tx, taskId);
      if (
        parsed.authorKind === "bot" &&
        !task.participantBotIds.includes(parsed.authorId)
      )
        throw new BackendError(
          400,
          "NOT_PARTICIPANT",
          "Message bot is not a participant",
        );
      for (const botId of parsed.activateBotIds)
        if (!task.participantBotIds.includes(botId))
          throw new BackendError(
            400,
            "NOT_PARTICIPANT",
            "Activated bot is not a participant",
          );
      const message: TaskMessage & { createdAt: string } = {
        createdAt: now(),
        ...parsed,
        id: randomUUID(),
        taskId,
      };
      await tx.put("messages", message.id, message);
      await tx.appendEvent({
        taskId,
        botId: parsed.authorKind === "bot" ? parsed.authorId : undefined,
        type: "message.posted",
        payload: { message },
      });
      if (parsed.activateBotIds.length) {
        if (task.status === "cancelled")
          throw new BackendError(409, "TASK_CANCELLED", "Task is cancelled");
        task.status = "running";
        task.result = undefined;
        await this.updateTask(tx, task);
        for (const botId of new Set(parsed.activateBotIds))
          await this.enqueue(tx, task, {
            botId,
            brief: parsed.text,
            verificationPlan: task.verificationPlan,
            checks: task.checks,
          });
      }
      return message;
    });
  }
  async addParticipant(taskId: string, botId: string, activate = false) {
    return this.store.transaction(async (tx) => {
      const task = await this.requireTask(tx, taskId);
      if (task.status === "cancelled")
        throw new BackendError(409, "TASK_CANCELLED", "Task is cancelled");
      await this.requireBot(tx, botId);
      if (!task.participantBotIds.includes(botId)) {
        task.participantBotIds = [...task.participantBotIds, botId];
        await this.updateTask(tx, task);
      }
      if (activate) {
        task.status = "running";
        task.result = undefined;
        await this.updateTask(tx, task);
        await this.enqueue(tx, task, {
          botId,
          brief: task.goal,
          verificationPlan: task.verificationPlan,
          checks: task.checks,
        });
      }
      return task;
    });
  }
  async transferCoordinator(taskId: string, botId: string) {
    return this.store.transaction(async (tx) => {
      const task = await this.requireTask(tx, taskId);
      if (!task.participantBotIds.includes(botId))
        throw new BackendError(
          400,
          "NOT_PARTICIPANT",
          "Coordinator must participate",
        );
      const previous = task.coordinatorBotId;
      task.coordinatorBotId = botId;
      await this.updateTask(tx, task);
      await tx.appendEvent({
        taskId,
        botId,
        type: "message.posted",
        payload: { operation: "coordinator.transferred", previous, botId },
      });
      return task;
    });
  }

  async steer(taskId: string, input: SteerTaskInput) {
    const parsed = steerTaskSchema.parse(input);
    const task = await this.store.transaction(async (tx) => {
      const task = await this.requireTask(tx, taskId);
      if (task.status === "cancelled")
        throw new BackendError(409, "TASK_CANCELLED", "Task is cancelled");
      if (
        parsed.observedGoalVersion !== undefined &&
        parsed.observedGoalVersion !== task.goalVersion
      )
        throw new BackendError(
          409,
          "STALE_GOAL_VERSION",
          `Task is at goalVersion ${task.goalVersion}; steering targeted goalVersion ${parsed.observedGoalVersion}`,
        );
      // Every steering update changes execution context, even when the top-level goal text stays.
      task.goalVersion += 1;
      const nextGoal = parsed.replacementGoal ?? parsed.goal;
      if (nextGoal) task.goal = nextGoal;
      const nextPlan = parsed.verificationPlan ?? task.verificationPlan;
      const nextChecks =
        parsed.checks ??
        (parsed.verificationPlan
          ? task.checks?.filter((check) =>
              nextPlan.some((criterion) => criterion.id === check.id),
            )
          : task.checks);
      this.assertPlan(nextPlan, nextChecks);
      task.verificationPlan = nextPlan;
      task.checks = nextChecks;
      task.status = "running";
      task.result = undefined;
      await this.cancelJobs(tx, task.id, "Superseded by user steering");
      const message: TaskMessage & { createdAt: string } = {
        createdAt: now(),
        id: randomUUID(),
        taskId,
        authorId: parsed.authorId ?? "user",
        authorKind: "user",
        intent: "steering",
        text: parsed.text,
        activateBotIds: [task.coordinatorBotId],
      };
      await tx.put("messages", message.id, message);
      await tx.appendEvent({
        taskId,
        type: "steering.received",
        payload: { message, goalVersion: task.goalVersion },
      });
      await tx.appendEvent({
        taskId,
        type: "message.posted",
        payload: { message },
      });
      await this.updateTask(tx, task);
      // Coordinator receives steering and redistributes bounded sessions for current participants.
      for (const botId of task.participantBotIds)
        await this.enqueue(tx, task, {
          botId,
          brief: `${task.goal}\nUser steering: ${parsed.text}`,
          verificationPlan: task.verificationPlan,
          checks: task.checks,
        });
      return task;
    });
    this.abortTaskSessions(taskId);
    return task;
  }
  private abortTaskSessions(taskId: string) {
    for (const [key, controller] of this.active)
      if (key.startsWith(`${taskId}:`))
        controller.abort(new Error("Task cancelled or steered"));
  }
  private async cancelJobs(tx: StoreTx, taskId: string, reason: string) {
    for (const job of await tx.list<JobRecord>("jobs")) {
      if (
        job.taskId !== taskId ||
        terminal.has(job.status) ||
        job.status === "done"
      )
        continue;
      job.status = "cancelled";
      job.error = reason;
      await tx.put("jobs", job.id, job);
    }
    for (const session of await tx.list<SessionRecord>("sessions")) {
      if (session.taskId !== taskId || terminal.has(session.status)) continue;
      session.status = "cancelled";
      session.updatedAt = now();
      await tx.put("sessions", session.id, session);
      await tx.appendEvent({
        taskId,
        sessionId: session.id,
        botId: session.botId,
        type: "session.finished",
        payload: { status: "cancelled", reason },
      });
    }
  }
  async cancel(taskId: string, reason = "Task cancelled by user") {
    const task = await this.store.transaction(async (tx) => {
      const task = await this.requireTask(tx, taskId);
      if (task.status === "cancelled") return task;
      task.status = "cancelled";
      task.cancelledAt = now();
      task.cancelReason = reason;
      await this.updateTask(tx, task);
      await this.cancelJobs(tx, taskId, reason);
      await tx.appendEvent({
        taskId,
        type: "cancellation.requested",
        payload: { status: "cancelled", reason },
      });
      return task;
    });
    this.abortTaskSessions(taskId);
    return task;
  }

  private async claim(): Promise<
    | {
        job: JobRecord;
        session: SessionRecord;
        task: TaskRecord;
        bot: Bot;
        context: string;
      }
    | undefined
  > {
    return this.store.transaction(async (tx) => {
      const jobs = (await tx.list<JobRecord>("jobs")).sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      );
      for (const job of jobs) {
        if (
          !(
            job.status === "queued" ||
            (job.status === "running" && (job.leaseUntil ?? 0) < Date.now())
          )
        )
          continue;
        const task = await this.requireTask(tx, job.taskId);
        const session = await tx.get<SessionRecord>("sessions", job.sessionId);
        if (
          !session ||
          task.status === "cancelled" ||
          session.goalVersion !== task.goalVersion
        ) {
          job.status = "cancelled";
          await tx.put("jobs", job.id, job);
          continue;
        }
        if (job.attempts >= 3) {
          job.status = "failed";
          session.status = "failed";
          session.error = "Recovery attempt budget exhausted";
          task.status = "waiting";
          await tx.put("jobs", job.id, job);
          await tx.put("sessions", session.id, session);
          await this.updateTask(tx, task);
          continue;
        }
        job.status = "running";
        job.owner = this.workerId;
        job.leaseUntil = Date.now() + this.leaseMs;
        job.attempts += 1;
        session.status = "running";
        session.attempts += 1;
        session.runId = randomUUID();
        session.updatedAt = now();
        task.status = "running";
        await tx.put("jobs", job.id, job);
        await tx.put("sessions", session.id, session);
        await this.updateTask(tx, task);
        await tx.appendEvent({
          taskId: task.id,
          sessionId: session.id,
          botId: session.botId,
          runId: session.runId,
          type: "session.started",
          payload: {
            kind: session.kind,
            attempt: session.attempts,
            goalVersion: task.goalVersion,
          },
        });
        const bot = await this.requireBot(tx, session.botId);
        const memory = await tx.get<MemoryRecord>("memory", bot.id);
        const messages = (
          await tx.list<TaskMessage & { createdAt?: string }>("messages")
        )
          .filter((item) => item.taskId === task.id)
          .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));
        const results = (await tx.list<SessionRecord>("sessions")).filter(
          (item) =>
            item.taskId === task.id &&
            item.goalVersion === task.goalVersion &&
            item.result,
        );
        const context = JSON.stringify({
          goal: task.goal,
          goalVersion: task.goalVersion,
          botMemory: memory?.text ?? "",
          sharedMessages: messages.slice(-60),
          sessionResults:
            session.kind === "synthesis"
              ? results.map((item) => ({
                  botId: item.botId,
                  sessionId: item.id,
                  result: item.result,
                }))
              : [],
        });
        return { job, session, task, bot, context };
      }
      return undefined;
    });
  }

  private async stillOwns(tx: StoreTx, job: JobRecord, session: SessionRecord) {
    const currentJob = await tx.get<JobRecord>("jobs", job.id);
    const currentTask = await tx.get<TaskRecord>("tasks", job.taskId);
    const currentSession = await tx.get<SessionRecord>("sessions", session.id);
    return (
      currentJob?.owner === this.workerId &&
      currentJob.status === "running" &&
      currentTask?.status !== "cancelled" &&
      currentTask?.goalVersion === session.goalVersion &&
      currentSession?.runId === session.runId
    );
  }

  private toolsFor(task: TaskRecord, session: SessionRecord): RuntimeTool[] {
    return [
      {
        name: "send_bot_message",
        description:
          "Post a message to the shared task chat. Specify activate=false for an informational message; activate=true asks the named bot to perform work.",
        parameters: {
          type: "object",
          properties: {
            botId: { type: "string" },
            text: { type: "string" },
            activate: { type: "boolean" },
          },
          required: ["botId", "text"],
        },
        execute: async (args, signal) => {
          signal.throwIfAborted();
          if (typeof args.botId !== "string" || typeof args.text !== "string")
            throw new Error("botId and text must be strings");
          if (!task.participantBotIds.includes(args.botId))
            throw new Error("Target bot must participate in the task");
          return this.postMessage(task.id, {
            authorKind: "bot",
            authorId: session.botId,
            text: args.text,
            intent: args.activate === true ? "assignment" : "notification",
            activateBotIds: args.activate === true ? [args.botId] : [],
          });
        },
      },
      {
        name: "delegate_task",
        description:
          "Delegate a bounded part of this task to a participant bot in a separate execution session. Use only when additional work is necessary.",
        parameters: {
          type: "object",
          properties: { botId: { type: "string" }, brief: { type: "string" } },
          required: ["botId", "brief"],
        },
        execute: async (args, signal) => {
          signal.throwIfAborted();
          if (typeof args.botId !== "string" || typeof args.brief !== "string")
            throw new Error("botId and brief must be strings");
          if (session.kind === "synthesis")
            throw new Error(
              "Synthesis must use completed work rather than recursively delegate",
            );
          const child = await this.spawnSession(task.id, {
            botId: args.botId,
            brief: args.brief,
            parentSessionId: session.id,
            verificationPlan: session.verificationPlan,
            checks: session.checks,
          });
          return { sessionId: child.id, status: child.status };
        },
      },
    ];
  }

  private async executeClaim(
    claim: NonNullable<Awaited<ReturnType<BackendService["claim"]>>>,
  ) {
    const { job, session, task, bot, context } = claim;
    const key = `${task.id}:${session.id}`;
    const controller = new AbortController();
    this.active.set(key, controller);
    let heartbeatBusy = false;
    let heartbeatFailures = 0;
    const heartbeat = setInterval(
      () => {
        if (heartbeatBusy) return;
        heartbeatBusy = true;
        void this.store
          .transaction(async (tx) => {
            if (!(await this.stillOwns(tx, job, session))) {
              controller.abort();
              return;
            }
            job.leaseUntil = Date.now() + this.leaseMs;
            await tx.put("jobs", job.id, job);
          })
          .then(() => {
            heartbeatFailures = 0;
          })
          .catch(() => {
            // A transient store error must not discard a running session immediately.
            heartbeatFailures += 1;
            if (heartbeatFailures >= 2) controller.abort();
          })
          .finally(() => {
            heartbeatBusy = false;
          });
      },
      Math.max(50, Math.floor(this.leaseMs / 3)),
    );
    try {
      const result = await this.executor.execute({
        session,
        bot,
        context,
        signal: controller.signal,
        checks: session.checks,
        tools: [...builtinTools(context), ...this.toolsFor(task, session)],
        emit: async (event) => {
          await this.store.transaction(async (tx) => {
            if (!(await this.stillOwns(tx, job, session))) {
              controller.abort();
              return;
            }
            const allowed = new Set([
              "model.started",
              "model.finished",
              "tool.started",
              "tool.finished",
              "verification.started",
              "verification.recorded",
              "session.revising",
            ]);
            if (!allowed.has(event.type)) return;
            await tx.appendEvent({
              taskId: task.id,
              sessionId: session.id,
              botId: bot.id,
              runId: session.runId,
              type: event.type as TaskEvent["type"],
              payload: event.payload,
            });
          });
        },
      });
      await this.store.transaction(async (tx) => {
        if (!(await this.stillOwns(tx, job, session))) return;
        const currentTask = await this.requireTask(tx, task.id);
        if (session.kind === "synthesis") {
          const currentWork = (await tx.list<SessionRecord>("sessions")).filter(
            (item) =>
              item.taskId === task.id &&
              item.goalVersion === task.goalVersion &&
              item.kind === "work",
          );
          const sourceIds = (
            session as SessionRecord & { sourceSessionIds?: string[] }
          ).sourceSessionIds;
          if (
            currentWork.some((item) => item.status !== "completed") ||
            JSON.stringify(currentWork.map((item) => item.id).sort()) !==
              JSON.stringify(sourceIds)
          ) {
            session.status = "cancelled";
            session.updatedAt = now();
            job.status = "cancelled";
            await tx.put("sessions", session.id, session);
            await tx.put("jobs", job.id, job);
            await tx.appendEvent({
              taskId: task.id,
              sessionId: session.id,
              botId: bot.id,
              type: "session.finished",
              payload: {
                status: "cancelled",
                reason: "Synthesis inputs changed",
              },
            });
            await this.maybeSynthesize(tx, currentTask);
            return;
          }
        }
        const checks = result.checks.map((check) => ({
          ...check,
          id: randomUUID(),
          createdAt: now(),
          taskId: task.id,
          sessionId: session.kind === "synthesis" ? undefined : session.id,
          goalVersion: session.goalVersion,
        }));
        for (const check of checks) {
          await tx.put("checks", check.id, check);
          await tx.appendEvent({
            taskId: task.id,
            sessionId: session.id,
            botId: bot.id,
            runId: session.runId,
            type: "verification.recorded",
            payload: { check },
          });
        }
        const passed =
          session.verificationPlan.every((criterion) =>
            checks.some(
              (check) =>
                check.criterionId === criterion.id &&
                check.outcome === "passed" &&
                check.evidence.length > 0,
            ),
          ) && checks.every((check) => check.outcome === "passed");
        session.result = result.summary;
        session.status = passed ? "completed" : "failed";
        session.updatedAt = now();
        job.status = passed ? "done" : "failed";
        await tx.put("sessions", session.id, session);
        await tx.put("jobs", job.id, job);
        const message: TaskMessage & { createdAt: string } = {
          createdAt: now(),
          id: randomUUID(),
          taskId: task.id,
          authorId: bot.id,
          authorKind: "bot",
          intent: "result",
          text: result.summary,
          activateBotIds: [],
        };
        await tx.put("messages", message.id, message);
        await tx.appendEvent({
          taskId: task.id,
          botId: bot.id,
          sessionId: session.id,
          type: "message.posted",
          payload: { message },
        });
        await tx.appendEvent({
          taskId: task.id,
          botId: bot.id,
          sessionId: session.id,
          runId: session.runId,
          type: "session.finished",
          payload: { status: session.status, summary: result.summary },
        });
        if (!passed) {
          currentTask.status = "waiting";
          await this.updateTask(tx, currentTask);
          return;
        }
        if (session.kind === "synthesis") {
          currentTask.status = "completed";
          currentTask.result = result.summary;
          await this.updateTask(tx, currentTask);
          await tx.appendEvent({
            taskId: task.id,
            botId: bot.id,
            sessionId: session.id,
            type: "task.finished",
            payload: { status: "completed", result: result.summary },
          });
          const conversation: ConversationMessage = {
            id: randomUUID(),
            botId: currentTask.coordinatorBotId,
            role: "assistant",
            text: result.summary,
            taskId: task.id,
            createdAt: now(),
            sequence: await this.nextConversationSequence(
              tx,
              currentTask.coordinatorBotId,
            ),
          };
          await tx.put("conversations", conversation.id, conversation);
        } else await this.maybeSynthesize(tx, currentTask);
      });
    } catch (error) {
      await this.store.transaction(async (tx) => {
        if (!(await this.stillOwns(tx, job, session))) return;
        const currentTask = await this.requireTask(tx, task.id);
        let reason =
          error instanceof Error ? error.message : "Execution failed";
        for (const secret of [
          process.env.GEMINI_API_KEY,
          process.env.GOOGLE_API_KEY,
        ])
          if (secret) reason = reason.split(secret).join("[REDACTED]");
        reason = reason.slice(0, 1500);
        session.status = this.stopped
          ? "queued"
          : controller.signal.aborted
            ? "cancelled"
            : "failed";
        session.error = reason;
        session.updatedAt = now();
        job.status = this.stopped
          ? "queued"
          : controller.signal.aborted
            ? "cancelled"
            : "failed";
        job.error = reason;
        currentTask.status = this.stopped ? "queued" : "waiting";
        await tx.put("sessions", session.id, session);
        await tx.put("jobs", job.id, job);
        await this.updateTask(tx, currentTask);
        await tx.appendEvent({
          taskId: task.id,
          sessionId: session.id,
          botId: bot.id,
          runId: session.runId,
          type: "session.finished",
          payload: { status: session.status, error: reason },
        });
      });
    } finally {
      clearInterval(heartbeat);
      this.active.delete(key);
    }
  }

  private async maybeSynthesize(tx: StoreTx, task: TaskRecord) {
    const sessions = (await tx.list<SessionRecord>("sessions")).filter(
      (session) =>
        session.taskId === task.id && session.goalVersion === task.goalVersion,
    );
    const work = sessions.filter((session) => session.kind === "work");
    if (!work.length) return;
    if (
      work.some(
        (session) =>
          session.status === "failed" || session.status === "cancelled",
      )
    ) {
      task.status = "waiting";
      await this.updateTask(tx, task);
      return;
    }
    if (work.some((session) => session.status !== "completed")) return;
    const workIds = work.map((session) => session.id).sort();
    if (
      sessions.some(
        (session) =>
          session.kind === "synthesis" &&
          JSON.stringify(
            (session as SessionRecord & { sourceSessionIds?: string[] })
              .sourceSessionIds,
          ) === JSON.stringify(workIds),
      )
    )
      return;
    const synthesis = await this.enqueue(
      tx,
      task,
      {
        botId: task.coordinatorBotId,
        brief: `Consolidate the other sessions' results into the final answer for: ${task.goal}. Independently verify the integrated result.`,
        verificationPlan: task.verificationPlan,
        checks: task.checks,
      },
      "synthesis",
    );
    await tx.put("sessions", synthesis.id, {
      ...synthesis,
      sourceSessionIds: workIds,
    });
  }

  async tick(): Promise<number> {
    if (this.stopped || this.ticking) return 0;
    this.ticking = true;
    let started = 0;
    try {
      const running = new Set<Promise<void>>();
      const start = (
        claim: NonNullable<Awaited<ReturnType<BackendService["claim"]>>>,
      ) => {
        started += 1;
        const run = (async () => {
          try {
            await this.executeClaim(claim);
          } catch (error) {
            // Never let one failing execution abort the scheduler or crash the process.
            console.error(
              "Task execution failed",
              error instanceof Error ? error.message : error,
            );
          }
        })();
        running.add(run);
        this.pending.add(run);
        void run.then(() => {
          running.delete(run);
          this.pending.delete(run);
        });
      };
      for (;;) {
        // Refill freed slots instead of waiting for the whole batch to finish.
        while (!this.stopped && running.size < this.concurrency) {
          const claim = await this.claim();
          if (!claim) break;
          start(claim);
        }
        if (!running.size) break;
        await Promise.race(running);
      }
      return started;
    } finally {
      this.ticking = false;
    }
  }
  private reportTickError(error: unknown) {
    console.error(
      "Scheduler tick failed",
      error instanceof Error ? error.message : error,
    );
  }
  start(intervalMs = 250) {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => {
      void this.tick().catch((error) => this.reportTickError(error));
    }, intervalMs);
    void this.tick().catch((error) => this.reportTickError(error));
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const controller of this.active.values())
      controller.abort(new Error("Worker stopped"));
    await Promise.allSettled([...this.pending]);
  }
}
