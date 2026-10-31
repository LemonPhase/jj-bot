/**
 * `JJApi` over the JJ Bot HTTP API (route table: docs/contract-changelog.md).
 * Every response is validated with its contract schema at this boundary, and
 * every failure becomes an `ApiError` built from the contract error envelope.
 */
import {
  apiErrorSchema,
  type Bootstrap,
  bootstrapSchema,
  botMemorySchema,
  botSchema,
  CONTRACT_VERSION,
  conversationViewSchema,
  createBotCommandSchema,
  createRuntimeProfileCommandSchema,
  createTaskCommandSchema,
  type ModelsView,
  modelsViewSchema,
  postTaskMessageCommandSchema,
  runtimeProfileSchema,
  sandboxDriverInfoSchema,
  sendBotMessageCommandSchema,
  sendBotMessageResultSchema,
  stopTaskCommandSchema,
  TASK_EVENT_TYPES,
  taskMessageSchema,
  taskSchema,
  taskSummarySchema,
  taskViewSchema,
  updateBotCommandSchema,
  updateBotMemoryCommandSchema,
  updateRuntimeProfileCommandSchema,
  type WorkspaceHint,
  workspaceHintSchema,
  z,
} from "@jj/contracts";
import {
  type ApiBadge,
  ApiError,
  type HintOptions,
  type JJApi,
  type StreamState,
  type Unsubscribe,
} from "./client";
import { followConversation, followTask, type OpenTaskEvents } from "./follow";
import {
  type EventSourceFactory,
  eventSourceConnect,
  fetchSseConnect,
  type SseConnect,
} from "./sse";

export interface HttpOptions {
  /** Prefix for `/api/...`; empty for the same origin (the Vite proxy in development). */
  baseUrl?: string;
  /** Sent as `Authorization: Bearer <token>` on every request and stream. */
  token?: string | null;
  fetch?: typeof fetch;
}

export interface LiveApiOptions extends HttpOptions {
  bootstrap: Bootstrap;
  /** Used to tell a real model from the scripted test model in the badge. */
  models?: ModelsView | null;
  /** Defaults to the browser's EventSource; ignored when a token is set. */
  eventSource?: EventSourceFactory;
  /** First delay before reopening a stream that closed. */
  retryMs?: number;
}

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

const HINT_TYPES = workspaceHintSchema.options.map(
  (option) => option.shape.type.value,
);

/** `details` of the error for a 2xx answer that is not JSON (not the API at all). */
const NOT_JSON = "not-json";

const errorText = (reason: unknown) =>
  reason instanceof Error ? reason.message : String(reason);

/** Validates a command the way the server will, so mistakes fail before the request. */
function command<Schema extends z.ZodType>(
  schema: Schema,
  value: unknown,
): z.output<Schema> {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new ApiError(
    "VALIDATION_FAILED",
    z.prettifyError(parsed.error),
    parsed.error.issues,
  );
}

export function createHttp({
  baseUrl = "",
  token,
  fetch: fetchImpl,
}: HttpOptions) {
  const doFetch =
    fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const authorization: Record<string, string> = token
    ? { Authorization: `Bearer ${token}` }
    : {};

  function request(
    method: Method,
    path: string,
    schema: null,
    body?: unknown,
  ): Promise<void>;
  function request<Schema extends z.ZodType>(
    method: Method,
    path: string,
    schema: Schema,
    body?: unknown,
  ): Promise<z.output<Schema>>;
  async function request<Schema extends z.ZodType>(
    method: Method,
    path: string,
    schema: Schema | null,
    body?: unknown,
  ): Promise<z.output<Schema> | undefined> {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}/api${path}`, {
        method,
        headers: {
          Accept: "application/json",
          ...authorization,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (reason) {
      throw new ApiError(
        "NETWORK_ERROR",
        `Can't reach the JJ Bot API: ${errorText(reason)}`,
      );
    }
    const text = await response.text().catch(() => "");
    let data: unknown = null;
    let json = true;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        json = false;
      }
    }
    if (!response.ok) {
      const envelope = apiErrorSchema.safeParse(data);
      if (envelope.success) {
        const { code, message, details } = envelope.data.error;
        throw new ApiError(code, message, details, response.status);
      }
      throw new ApiError(
        response.status === 401 ? "UNAUTHORIZED" : "INVALID_RESPONSE",
        `${method} /api${path} failed with HTTP ${response.status}`,
        data,
        response.status,
      );
    }
    if (!schema) return undefined;
    if (!json)
      throw new ApiError(
        "INVALID_RESPONSE",
        `${method} /api${path} did not answer with JSON`,
        NOT_JSON,
        response.status,
      );
    const parsed = schema.safeParse(data);
    if (!parsed.success)
      throw new ApiError(
        "INVALID_RESPONSE",
        `${method} /api${path} answered with an unexpected shape: ${z.prettifyError(parsed.error)}`,
        parsed.error.issues,
        response.status,
      );
    return parsed.data;
  }

  return { request, doFetch, authorization, baseUrl };
}

/** The mode chip for a connected backend (decision: frontend brief). */
export function liveBadge(
  bootstrap: Bootstrap,
  models?: ModelsView | null,
): ApiBadge {
  if (!bootstrap.capabilities.agentExecution)
    return {
      label: "No model configured",
      tone: "warning",
      title:
        "Connected to the JJ Bot API, but no model provider is configured, so bots cannot reply or run tasks. Provider keys are set on the server.",
    };
  const configured = (models?.providers ?? []).filter((p) => p.configured);
  const scriptedOnly = configured.length
    ? configured.every((p) => p.id === "scripted")
    : (bootstrap.defaultModel?.startsWith("scripted/") ?? false);
  if (scriptedOnly)
    return {
      label: "Scripted model",
      tone: "warning",
      title:
        "Connected to the JJ Bot API with only the scripted test model: replies and task runs are deterministic test output, not a real model.",
    };
  return {
    label: "Live",
    tone: "live",
    title: `Connected to the JJ Bot API · contract ${bootstrap.contractVersion}`,
  };
}

const RESPONSES = {
  bots: z.object({ bots: z.array(botSchema) }),
  bot: z.object({ bot: botSchema }),
  profiles: z.object({ profiles: z.array(runtimeProfileSchema) }),
  profile: z.object({ profile: runtimeProfileSchema }),
  drivers: z.object({ drivers: z.array(sandboxDriverInfoSchema) }),
  tasks: z.object({ tasks: z.array(taskSummarySchema) }),
  task: z.object({ task: taskSchema }),
  taskMessage: z.object({ message: taskMessageSchema }),
};

export function createLiveApi(options: LiveApiOptions): JJApi {
  const { bootstrap: initial, models, retryMs } = options;
  const http = createHttp(options);
  const { request } = http;
  const id = encodeURIComponent;

  const connect: SseConnect = options.token
    ? fetchSseConnect(http.doFetch, http.authorization)
    : eventSourceConnect(
        options.eventSource ?? ((url) => new EventSource(url)),
      );

  const getConversation = (botId: string) =>
    request("GET", `/bots/${id(botId)}/messages`, conversationViewSchema);
  const getTask = (taskId: string) =>
    request("GET", `/tasks/${id(taskId)}`, taskViewSchema);

  const hints = createHintHub(
    connect,
    `${http.baseUrl}/api/stream`,
    retryMs ?? 1000,
  );

  const openTaskEvents: OpenTaskEvents = (taskId, after, handlers) =>
    connect(
      {
        url: `${http.baseUrl}/api/tasks/${id(taskId)}/stream?after=${after}`,
        lastEventId: after > 0 ? String(after) : undefined,
        eventTypes: TASK_EVENT_TYPES,
      },
      {
        onOpen: handlers.onOpen,
        onError: handlers.onError,
        onFrame: (frame) => {
          let raw: unknown = frame.data;
          try {
            raw = JSON.parse(frame.data);
          } catch {
            // Left as text: validation reports it as malformed.
          }
          handlers.onEvent(raw);
        },
      },
    );

  return {
    mode: "live",
    badge: liveBadge(initial, models),
    capabilities: initial.capabilities,
    contractVersion: initial.contractVersion,

    bootstrap: () => request("GET", "/bootstrap", bootstrapSchema),
    subscribeHints: (onHint, hintOptions) =>
      hints.subscribe(onHint, hintOptions),

    listBots: async () => (await request("GET", "/bots", RESPONSES.bots)).bots,
    getBot: async (botId) =>
      (await request("GET", `/bots/${id(botId)}`, RESPONSES.bot)).bot,
    createBot: async (cmd) =>
      (
        await request(
          "POST",
          "/bots",
          RESPONSES.bot,
          command(createBotCommandSchema, cmd),
        )
      ).bot,
    updateBot: async (botId, cmd) =>
      (
        await request(
          "PATCH",
          `/bots/${id(botId)}`,
          RESPONSES.bot,
          command(updateBotCommandSchema, cmd),
        )
      ).bot,
    archiveBot: (botId) => request("DELETE", `/bots/${id(botId)}`, null),
    getMemory: (botId) =>
      request("GET", `/bots/${id(botId)}/memory`, botMemorySchema),
    putMemory: (botId, cmd) =>
      request(
        "PUT",
        `/bots/${id(botId)}/memory`,
        botMemorySchema,
        command(updateBotMemoryCommandSchema, cmd),
      ),

    getConversation,
    sendBotMessage: async (botId, cmd) =>
      (
        await request(
          "POST",
          `/bots/${id(botId)}/messages`,
          sendBotMessageResultSchema,
          command(sendBotMessageCommandSchema, cmd),
        )
      ).message,
    subscribeConversation: (botId, onView, streamOptions) =>
      followConversation(
        botId,
        getConversation,
        hints.subscribe,
        onView,
        streamOptions,
      ),

    listProfiles: async () =>
      (await request("GET", "/runtime-profiles", RESPONSES.profiles)).profiles,
    getProfile: async (profileId) =>
      (
        await request(
          "GET",
          `/runtime-profiles/${id(profileId)}`,
          RESPONSES.profile,
        )
      ).profile,
    createProfile: async (cmd) =>
      (
        await request(
          "POST",
          "/runtime-profiles",
          RESPONSES.profile,
          command(createRuntimeProfileCommandSchema, cmd),
        )
      ).profile,
    updateProfile: async (profileId, cmd) =>
      (
        await request(
          "PATCH",
          `/runtime-profiles/${id(profileId)}`,
          RESPONSES.profile,
          command(updateRuntimeProfileCommandSchema, cmd),
        )
      ).profile,
    deleteProfile: (profileId) =>
      request("DELETE", `/runtime-profiles/${id(profileId)}`, null),
    listDrivers: async () =>
      (await request("GET", "/sandbox-drivers", RESPONSES.drivers)).drivers,
    getModels: () => request("GET", "/models", modelsViewSchema),

    listTasks: async () =>
      (await request("GET", "/tasks", RESPONSES.tasks)).tasks,
    createTask: async (cmd) =>
      (
        await request(
          "POST",
          "/tasks",
          RESPONSES.task,
          command(createTaskCommandSchema, cmd),
        )
      ).task,
    getTask,
    postTaskMessage: async (taskId, cmd) =>
      (
        await request(
          "POST",
          `/tasks/${id(taskId)}/messages`,
          RESPONSES.taskMessage,
          command(postTaskMessageCommandSchema, cmd),
        )
      ).message,
    stopTask: async (taskId, cmd = {}) =>
      (
        await request(
          "POST",
          `/tasks/${id(taskId)}/stop`,
          RESPONSES.task,
          command(stopTaskCommandSchema, cmd),
        )
      ).task,
    subscribeTask: (taskId, onView, streamOptions) =>
      followTask(taskId, getTask, openTaskEvents, onView, {
        retryMs,
        ...streamOptions,
      }),
    artifactUrl: (taskId, artifactId) =>
      `${http.baseUrl}/api/tasks/${id(taskId)}/artifacts/${id(artifactId)}/content`,
  };
}

interface HintSubscriber {
  onHint: (hint: WorkspaceHint) => void;
  options: HintOptions;
}

/** One `/api/stream` connection shared by every subscriber, open while anyone listens. */
function createHintHub(connect: SseConnect, url: string, retryMs: number) {
  const subscribers = new Set<HintSubscriber>();
  let close: (() => void) | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = retryMs;
  let connectedBefore = false;
  let state: StreamState = "closed";

  const setState = (next: StreamState) => {
    state = next;
    for (const s of subscribers) s.options.onState?.(next);
  };

  const start = () => {
    close?.();
    setState(connectedBefore ? "reconnecting" : "connecting");
    close = connect(
      { url, eventTypes: HINT_TYPES },
      {
        onOpen: () => {
          retryDelay = retryMs;
          setState("open");
          // Not resumable: whatever changed while disconnected must be refetched.
          if (connectedBefore)
            for (const s of subscribers) s.options.onResync?.();
          connectedBefore = true;
        },
        onFrame: (frame) => {
          let raw: unknown;
          try {
            raw = JSON.parse(frame.data);
          } catch {
            return;
          }
          const hint = workspaceHintSchema.safeParse(raw);
          if (hint.success) {
            for (const s of subscribers) s.onHint(hint.data);
            return;
          }
          // Hint types this client does not know are ignored; a known one that is malformed is reported.
          const type = (raw as { type?: unknown } | null)?.type;
          if (
            typeof type === "string" &&
            (HINT_TYPES as readonly string[]).includes(type)
          )
            for (const s of subscribers)
              s.options.onError?.(
                new ApiError(
                  "INVALID_RESPONSE",
                  `Ignored a malformed workspace hint: ${z.prettifyError(hint.error)}`,
                  hint.error.issues,
                ),
              );
        },
        onError: (retrying) => {
          setState("reconnecting");
          if (retrying) return;
          close?.();
          close = null;
          clearTimeout(retryTimer);
          retryTimer = setTimeout(start, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 15_000);
        },
      },
    );
  };

  return {
    subscribe(
      onHint: (hint: WorkspaceHint) => void,
      options: HintOptions = {},
    ): Unsubscribe {
      const subscriber = { onHint, options };
      subscribers.add(subscriber);
      if (subscribers.size === 1) start();
      else options.onState?.(state);
      return () => {
        if (!subscribers.delete(subscriber) || subscribers.size > 0) return;
        clearTimeout(retryTimer);
        close?.();
        close = null;
        connectedBefore = false;
        state = "closed";
      };
    },
  };
}

export type BackendProbe =
  | { ok: true; bootstrap: Bootstrap; models: ModelsView | null }
  | { ok: false; reason: string };

const majorOf = (version: string) => version.split(".")[0];

/**
 * Asks `/api/bootstrap` whether a compatible backend is there. Never throws:
 * the reason it is not usable is shown in the demo badge's tooltip.
 */
export async function probeBackend(
  options: HttpOptions,
): Promise<BackendProbe> {
  const { request } = createHttp(options);
  try {
    const bootstrap = await request("GET", "/bootstrap", bootstrapSchema);
    if (bootstrap.mode !== "backend")
      return {
        ok: false,
        reason:
          "The API is running in scaffold mode, with no backend behind it.",
      };
    if (majorOf(bootstrap.contractVersion) !== majorOf(CONTRACT_VERSION))
      return {
        ok: false,
        reason: `The API speaks contract ${bootstrap.contractVersion}; this app needs ${CONTRACT_VERSION}.`,
      };
    const models = await request("GET", "/models", modelsViewSchema).catch(
      () => null,
    );
    return { ok: true, bootstrap, models };
  } catch (reason) {
    const error =
      reason instanceof ApiError
        ? reason
        : new ApiError("NETWORK_ERROR", errorText(reason));
    if (error.code === "UNAUTHORIZED")
      return {
        ok: false,
        reason:
          "The API requires a token. Open the app once with ?token=<API_TOKEN> to keep it in this browser.",
      };
    if (
      error.code === "NETWORK_ERROR" ||
      (error.status !== undefined && error.status >= 500) ||
      error.details === NOT_JSON
    )
      return { ok: false, reason: "The JJ Bot API isn't reachable." };
    return {
      ok: false,
      reason: `The API's bootstrap doesn't match contract ${CONTRACT_VERSION}.`,
    };
  }
}
