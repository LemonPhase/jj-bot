// The engine: one object with a method per API route, returning contract
// shapes, plus the worker. `apps/api` validates nothing twice: every command
// is parsed here with its contract schema.
import {
  type Approval,
  type Artifact,
  type Bootstrap,
  type Bot,
  type BotMemory,
  CONTRACT_VERSION,
  type ConversationView,
  type CreateBotCommand,
  type CreateRuntimeProfileCommand,
  type CreateTaskCommand,
  type CreateTaskTemplateCommand,
  type DecideApprovalCommand,
  type ModelsView,
  type PostTaskMessageCommand,
  type PutSecretCommand,
  type RuntimeProfile,
  type SandboxDriverInfo,
  type SecretInfo,
  type SecretsView,
  type SendBotMessageCommand,
  type SendBotMessageResult,
  type StagedUpload,
  type StartTemplateCommand,
  type StopTaskCommand,
  type Task,
  type TaskEventPage,
  type TaskMessage,
  type TaskSummary,
  type TaskTemplate,
  type TaskView,
  type UpdateBotCommand,
  type UpdateBotMemoryCommand,
  type UpdateRuntimeProfileCommand,
  type UpdateTaskCommand,
  type UpdateTaskTemplateCommand,
  type UploadToTaskCommand,
  type UploadToTaskResult,
  type UsageReport,
  type WorkspaceHint,
} from "@jj/contracts";
import { type Database, type IdKind, queueDepth } from "@jj/db";
import { type Tracer, trace } from "@opentelemetry/api";
import { type EngineConfigInput, resolveConfig } from "./config";
import { defaultIds, type EngineContext, type Logger } from "./context";
import { errorMessage } from "./errors";
import { subscribeHints } from "./events";
import { createLogger, logSettings } from "./observability/logger";
import { createMetrics, type EngineMetrics } from "./observability/metrics";
import type {
  ChatResponder,
  DriverRegistry,
  ModelCatalog,
  RunExecutor,
} from "./ports";
import {
  createRedactor,
  MIN_BARE_SECRET_LENGTH,
  type Secret,
  tooShortToRedact,
} from "./redact";
import { retiredBefore, SecretStore, warnUnreadable } from "./secrets/store";
import { decideApproval } from "./services/approvals";
import { artifactContent } from "./services/artifacts";
import * as botService from "./services/bots";
import { conversationView, sendBotMessage } from "./services/chat";
import { postTaskMessage } from "./services/messages";
import * as profileService from "./services/profiles";
import * as secretService from "./services/secrets";
import {
  subscribeTask,
  type TaskStreamOptions,
  type TaskSubscription,
} from "./services/stream";
import { createTask, stopTask, updateTaskSettings } from "./services/tasks";
import * as templateService from "./services/templates";
import {
  deleteStagedUpload,
  type StageUploadInput,
  stageUpload,
  sweepStagedUploads,
  uploadLimits,
  uploadToTask,
} from "./services/uploads";
import { usageReport } from "./services/usage";
import { VERIFICATION_ENFORCED } from "./services/verification";
import { eventPage, taskSummaries, taskView } from "./services/views";
import { createWorker, type Worker } from "./worker/worker";

export interface EngineOptions {
  /** The opened store (`openDatabase`). */
  db: Pick<Database, "db" | "bus">;
  drivers: DriverRegistry;
  executor: RunExecutor;
  chat: ChatResponder;
  models: ModelCatalog;
  config?: EngineConfigInput;
  clock?: () => Date;
  ids?: (kind: IdKind) => string;
  /** Default: JSON lines on stdout and stderr, at `JJ_LOG_LEVEL` and `JJ_LOG_FORMAT`. */
  logger?: Logger;
  /** Default: a registry of this engine's own, without the process's metrics. */
  metrics?: EngineMetrics;
  /** Default: the global tracer provider's, a no-op unless one is registered. */
  tracer?: Tracer;
  /**
   * The server's secret values (provider keys, the API token, the database
   * password), read when each run starts so values stored later count. They
   * are replaced with `[redacted]` in everything a run persists.
   */
  secrets?: () => readonly Secret[] | Promise<readonly Secret[]>;
  /**
   * The stored secrets. Omitted: a store with no master key over `db`, so
   * nothing can be stored and stored rows are reported unreadable.
   */
  secretStore?: SecretStore;
}

export interface Engine {
  /** `GET /api/bootstrap`. */
  bootstrap(): Promise<Bootstrap>;
  /** `GET /api/stream`: workspace hints. Resolves once listening; returns the unsubscribe. */
  subscribeHints(
    handler: (hint: WorkspaceHint) => void,
  ): Promise<() => Promise<void>>;
  bots: {
    list(): Promise<{ bots: Bot[] }>;
    create(command: CreateBotCommand): Promise<{ bot: Bot }>;
    get(botId: string): Promise<{ bot: Bot }>;
    update(botId: string, command: UpdateBotCommand): Promise<{ bot: Bot }>;
    /** `DELETE /api/bots/:id`: archives; CONFLICT while the bot has active tasks. */
    archive(botId: string): Promise<void>;
    getMemory(botId: string): Promise<BotMemory>;
    putMemory(
      botId: string,
      command: UpdateBotMemoryCommand,
    ): Promise<BotMemory>;
    conversation(botId: string): Promise<ConversationView>;
    sendMessage(
      botId: string,
      command: SendBotMessageCommand,
    ): Promise<SendBotMessageResult>;
  };
  profiles: {
    list(): Promise<{ profiles: RuntimeProfile[] }>;
    create(
      command: CreateRuntimeProfileCommand,
    ): Promise<{ profile: RuntimeProfile }>;
    get(profileId: string): Promise<{ profile: RuntimeProfile }>;
    update(
      profileId: string,
      command: UpdateRuntimeProfileCommand,
    ): Promise<{ profile: RuntimeProfile }>;
    /** PROFILE_IN_USE while a bot references it. */
    delete(profileId: string): Promise<void>;
  };
  /** `GET /api/sandbox-drivers`. */
  drivers(): Promise<{ drivers: SandboxDriverInfo[] }>;
  /** `GET /api/models`. */
  models(): Promise<ModelsView>;
  /** `PUT /api/models/providers/:providerId/key`: CONFLICT while a server variable configures it. */
  putProviderKey(
    providerId: string,
    command: PutSecretCommand,
  ): Promise<ModelsView>;
  /** `DELETE /api/models/providers/:providerId/key`. */
  deleteProviderKey(providerId: string): Promise<ModelsView>;
  secrets: {
    /** `GET /api/secrets`. */
    list(): Promise<SecretsView>;
    /** `PUT /api/secrets/:name`; `created` when it was not stored before. */
    put(
      name: string,
      command: PutSecretCommand,
    ): Promise<{ secret: SecretInfo; created: boolean }>;
    /** `DELETE /api/secrets/:name`, with every profile's grant of it. */
    delete(name: string): Promise<void>;
  };
  /** `GET /api/usage`. */
  usage(): Promise<UsageReport>;
  tasks: {
    list(): Promise<{ tasks: TaskSummary[] }>;
    create(command: CreateTaskCommand): Promise<{ task: Task }>;
    get(taskId: string): Promise<TaskView>;
    postMessage(
      taskId: string,
      command: PostTaskMessageCommand,
    ): Promise<{ message: TaskMessage }>;
    stop(taskId: string, command?: StopTaskCommand): Promise<{ task: Task }>;
    /** `PATCH /api/tasks/:id`: the spend cap. */
    update(taskId: string, command: UpdateTaskCommand): Promise<{ task: Task }>;
    /** `POST /api/tasks/:id/approvals/:approvalId`: the user's answer to a held call. */
    decideApproval(
      taskId: string,
      approvalId: string,
      command: DecideApprovalCommand,
    ): Promise<{ approval: Approval }>;
    /** `GET /api/tasks/:id/events?after=`. */
    events(
      taskId: string,
      options?: { after?: number; limit?: number },
    ): Promise<TaskEventPage>;
    /** `GET /api/tasks/:id/stream`: events after `after`, then live. */
    subscribe(
      taskId: string,
      options: TaskStreamOptions,
    ): Promise<TaskSubscription>;
    /** `GET /api/tasks/:id/artifacts/:artifactId/content`. */
    artifactContent(
      taskId: string,
      artifactId: string,
    ): Promise<{ artifact: Artifact; content: Uint8Array }>;
    /** `POST /api/tasks/:id/uploads`: attaches staged uploads; wakes nothing. */
    upload(
      taskId: string,
      command: UploadToTaskCommand,
    ): Promise<UploadToTaskResult>;
  };
  /** Staged uploads; every method answers NOT_FOUND while uploads are off. */
  uploads: {
    /** `POST /api/uploads`: every limit is checked before the body is read. */
    stage(input: StageUploadInput): Promise<{ upload: StagedUpload }>;
    /** `DELETE /api/uploads/:id`. */
    delete(uploadId: string): Promise<void>;
  };
  /** Task templates: saved task setups the user starts again. */
  templates: {
    /** `GET /api/task-templates`, oldest first, each with its problems now. */
    list(): Promise<{ templates: TaskTemplate[] }>;
    /** `POST /api/task-templates`: CONFLICT past MAX_TASK_TEMPLATES. */
    create(
      command: CreateTaskTemplateCommand,
    ): Promise<{ template: TaskTemplate }>;
    get(templateId: string): Promise<{ template: TaskTemplate }>;
    update(
      templateId: string,
      command: UpdateTaskTemplateCommand,
    ): Promise<{ template: TaskTemplate }>;
    /** `DELETE /api/task-templates/:id`: its tasks keep their `templateId`. */
    delete(templateId: string): Promise<void>;
    /** `POST /api/task-templates/:id/tasks`: TEMPLATE_UNUSABLE while it has problems. */
    start(
      templateId: string,
      command: StartTemplateCommand,
    ): Promise<{ task: Task }>;
  };
  worker: Worker;
  /** `GET /metrics`: the Prometheus metrics of this engine and its worker. */
  metrics: EngineMetrics;
  /** The resolved settings. */
  readonly context: EngineContext;
}

/**
 * Builds the engine and seeds the default runtime profiles on first boot. The
 * worker does not run until `engine.worker.start()`.
 */
export async function createEngine(options: EngineOptions): Promise<Engine> {
  const secrets = async () => (await options.secrets?.()) ?? [];
  const store = options.secretStore ?? new SecretStore({ db: options.db.db });
  const logger = options.logger ?? createLogger(logSettings(process.env, true));
  const metrics =
    options.metrics ??
    createMetrics({
      onError: (what, error) =>
        logger.warn(`Reading ${what} for the metrics failed`, {
          error: errorMessage(error),
        }),
    });
  // The log redacts with the newest redactor built, whichever finishes last.
  let built = 0;
  let applied = 0;
  const ctx: EngineContext = {
    db: options.db.db,
    bus: options.db.bus,
    config: resolveConfig(options.config),
    drivers: options.drivers,
    models: options.models,
    clock: options.clock ?? (() => new Date()),
    ids: options.ids ?? defaultIds,
    logger,
    metrics,
    tracer: options.tracer ?? trace.getTracer("jj-bot"),
    redactor: async (extra = []) => {
      const order = ++built;
      await store.refresh();
      const redactor = createRedactor([
        ...(await secrets()),
        ...store.values(),
        ...store.retiredValues(),
        ...ctx.heldSecrets(),
        ...extra,
      ]);
      if (order > applied) {
        applied = order;
        logger.redactWith?.(redactor);
      }
      return redactor;
    },
    secretStore: store,
    serverSecrets: secrets,
    heldSecrets: () => [],
  };
  for (const name of tooShortToRedact(await secrets()))
    ctx.logger.warn(
      `${name} is shorter than ${MIN_BARE_SECRET_LENGTH} characters, so it is not redacted from task history: a value that short is too likely to be an ordinary word. Use a longer value.`,
    );
  await store.purgeRetired(retiredBefore(ctx.clock()));
  const swept = await sweepStagedUploads(ctx);
  if (swept > 0)
    ctx.logger.info(`Deleted ${swept} staged upload(s) past their time`);
  await store.rotate(ctx.logger);
  await store.refresh();
  warnUnreadable(store, ctx.logger);
  // From here on the log redacts the stored secrets too.
  await ctx.redactor();
  await profileService.seedDefaultProfiles(ctx);
  const worker = createWorker(ctx, options.executor, options.chat);
  metrics.track({
    queueDepth: () => queueDepth(ctx.db),
    activeJobs: () => worker.activeJobs,
  });
  /** A stored secret changed: the log redacts the new value (and the retired one) at once. */
  const refreshing = async <T>(change: Promise<T>): Promise<T> => {
    const result = await change;
    await ctx.redactor().catch((error: unknown) =>
      ctx.logger.warn("Refreshing the log's redaction failed", {
        error: errorMessage(error),
      }),
    );
    return result;
  };

  return {
    context: ctx,
    async bootstrap() {
      const [bots, tasks, profiles, drivers] = await Promise.all([
        botService.listBots(ctx),
        taskSummaries(ctx.db, { redact: await ctx.redactor() }),
        profileService.listProfiles(ctx),
        ctx.drivers.list(),
      ]);
      await store.refresh();
      const providers = ctx.models.providers();
      return {
        mode: "backend",
        contractVersion: CONTRACT_VERSION,
        capabilities: {
          agentExecution: providers.some((provider) => provider.configured),
          persistence: ctx.config.persistence,
          streaming: true,
          verification: VERIFICATION_ENFORCED,
          secretStore: store.available,
          // No MCP server or skill reaches a session on this build; profiles asking for one are refused.
          mcp: { stdio: false, remote: false },
          skills: false,
          uploads: uploadLimits(ctx),
          drivers: drivers.map((info) => ({
            id: info.id,
            available: info.available,
            isolated: info.capabilities.filesystemIsolation,
          })),
        },
        defaultModel: ctx.models.defaultModel(),
        bots: bots.bots,
        tasks,
        profiles: profiles.profiles,
      };
    },
    subscribeHints: (handler) => subscribeHints(ctx.bus, handler),
    bots: {
      list: () => botService.listBots(ctx),
      create: (command) => botService.createBot(ctx, command),
      get: (botId) => botService.getBot(ctx, botId),
      update: (botId, command) => botService.updateBot(ctx, botId, command),
      archive: (botId) => botService.archiveBot(ctx, botId),
      getMemory: (botId) => botService.getMemory(ctx, botId),
      putMemory: (botId, command) => botService.putMemory(ctx, botId, command),
      conversation: (botId) => conversationView(ctx, botId),
      sendMessage: (botId, command) => sendBotMessage(ctx, botId, command),
    },
    profiles: {
      list: () => profileService.listProfiles(ctx),
      create: (command) => profileService.createProfile(ctx, command),
      get: (profileId) => profileService.getProfile(ctx, profileId),
      update: (profileId, command) =>
        profileService.updateProfile(ctx, profileId, command),
      delete: (profileId) => profileService.deleteProfile(ctx, profileId),
    },
    drivers: async () => ({ drivers: await ctx.drivers.list() }),
    models: () => secretService.modelsView(ctx),
    putProviderKey: (providerId, command) =>
      refreshing(secretService.putProviderKey(ctx, providerId, command)),
    deleteProviderKey: (providerId) =>
      refreshing(secretService.deleteProviderKey(ctx, providerId)),
    secrets: {
      list: () => secretService.listSecrets(ctx),
      put: (name, command) =>
        refreshing(secretService.putSecret(ctx, name, command)),
      delete: (name) => refreshing(secretService.deleteSecret(ctx, name)),
    },
    usage: () => usageReport(ctx),
    tasks: {
      list: async () => ({
        tasks: await taskSummaries(ctx.db, { redact: await ctx.redactor() }),
      }),
      create: (command) => createTask(ctx, command),
      get: (taskId) => taskView(ctx, taskId),
      postMessage: (taskId, command) => postTaskMessage(ctx, taskId, command),
      stop: (taskId, command = {}) => stopTask(ctx, taskId, command),
      update: (taskId, command) => updateTaskSettings(ctx, taskId, command),
      decideApproval: (taskId, approvalId, command) =>
        decideApproval(ctx, taskId, approvalId, command),
      events: (taskId, options) => eventPage(ctx, taskId, options),
      subscribe: (taskId, options) => subscribeTask(ctx, taskId, options),
      artifactContent: (taskId, artifactId) =>
        artifactContent(ctx, taskId, artifactId),
      upload: (taskId, command) => uploadToTask(ctx, taskId, command),
    },
    uploads: {
      stage: (input) => stageUpload(ctx, input),
      delete: (uploadId) => deleteStagedUpload(ctx, uploadId),
    },
    templates: {
      list: () => templateService.listTemplates(ctx),
      create: (command) => templateService.createTemplate(ctx, command),
      get: (templateId) => templateService.getTemplate(ctx, templateId),
      update: (templateId, command) =>
        templateService.updateTemplate(ctx, templateId, command),
      delete: (templateId) => templateService.deleteTemplate(ctx, templateId),
      start: (templateId, command) =>
        templateService.startTemplate(ctx, templateId, command),
    },
    worker,
    metrics,
  };
}
