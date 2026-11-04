/**
 * `JJApi` over the JJ Bot HTTP API (route table: docs/contract-changelog.md).
 * Every response is validated with its contract schema at this boundary, and
 * every failure becomes an `ApiError` built from the contract error envelope.
 */
import {
  apiErrorCodeSchema,
  approvalSchema,
  type Bootstrap,
  bootstrapSchema,
  botMemorySchema,
  botSchema,
  CONTRACT_VERSION,
  conversationViewSchema,
  createBotCommandSchema,
  createRuntimeProfileCommandSchema,
  createTaskCommandSchema,
  createTaskTemplateCommandSchema,
  decideApprovalCommandSchema,
  type ModelsView,
  mcpDiscoveryResultSchema,
  mcpSnapshotResultSchema,
  modelsViewSchema,
  postTaskMessageCommandSchema,
  putSecretCommandSchema,
  runtimeProfileSchema,
  sandboxDriverInfoSchema,
  secretInfoSchema,
  secretsViewSchema,
  sendBotMessageCommandSchema,
  sendBotMessageResultSchema,
  startMcpDiscoveryCommandSchema,
  startTemplateCommandSchema,
  stopTaskCommandSchema,
  TASK_EVENT_TYPES,
  taskMessageSchema,
  taskSchema,
  taskSummarySchema,
  taskTemplateListSchema,
  taskTemplateResultSchema,
  taskViewSchema,
  updateBotCommandSchema,
  updateBotMemoryCommandSchema,
  updateRuntimeProfileCommandSchema,
  updateTaskCommandSchema,
  updateTaskTemplateCommandSchema,
  usageReportSchema,
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

/**
 * The error envelope without the code enum: a newer server may send codes
 * this client does not know, and its message is still worth showing.
 */
const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

/** The ApiError for a non-2xx answer, from its body (already parsed, or null). */
function responseError(
  response: Response,
  data: unknown,
  what: string,
): ApiError {
  const envelope = errorEnvelopeSchema.safeParse(data);
  if (envelope.success) {
    const { code, message, details } = envelope.data.error;
    const known = apiErrorCodeSchema.safeParse(code);
    return new ApiError(
      known.success
        ? known.data
        : response.status === 401
          ? "UNAUTHORIZED"
          : "UNRECOGNIZED_ERROR",
      message,
      details,
      response.status,
      code,
    );
  }
  return new ApiError(
    response.status === 401 ? "UNAUTHORIZED" : "INVALID_RESPONSE",
    `${what} failed with HTTP ${response.status}`,
    data,
    response.status,
  );
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

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
        // Reads must reflect the server now: a hint-driven refetch served from
        // the HTTP cache would undo the update it was meant to show.
        ...(method === "GET" ? { cache: "no-store" as const } : {}),
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
    if (!response.ok)
      throw responseError(response, data, `${method} /api${path}`);
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

  /** `GET` raw content (an artifact) with the same headers and error handling. */
  async function download(path: string): Promise<Blob> {
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}/api${path}`, {
        headers: authorization,
        cache: "no-store",
      });
    } catch (reason) {
      throw new ApiError(
        "NETWORK_ERROR",
        `Can't reach the JJ Bot API: ${errorText(reason)}`,
      );
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw responseError(response, parseJson(text), `GET /api${path}`);
    }
    return response.blob();
  }

  return { request, download, doFetch, authorization, baseUrl };
}

/** The mode chip for a connected backend (decision: frontend brief). */
export function liveBadge(
  bootstrap: Pick<
    Bootstrap,
    "capabilities" | "contractVersion" | "defaultModel"
  >,
  models?: ModelsView | null,
): ApiBadge {
  // A key stored after boot configures a provider: the models view says so.
  const execution = models
    ? models.providers.some((provider) => provider.configured)
    : bootstrap.capabilities.agentExecution;
  if (!execution)
    return {
      label: "No model configured",
      tone: "warning",
      title:
        "Connected to the JJ Bot API, but no model provider is configured, so bots cannot reply or run tasks. Set a provider key on the server, or store one in Settings → Models.",
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
  approval: z.object({ approval: approvalSchema }),
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
    startMcpDiscovery: async (profileId, cmd) =>
      (
        await request(
          "POST",
          `/runtime-profiles/${id(profileId)}/mcp-discoveries`,
          mcpDiscoveryResultSchema,
          command(startMcpDiscoveryCommandSchema, cmd),
        )
      ).discovery,
    getMcpDiscovery: async (discoveryId) =>
      (
        await request(
          "GET",
          `/mcp-discoveries/${id(discoveryId)}`,
          mcpDiscoveryResultSchema,
        )
      ).discovery,
    getMcpSnapshot: async (snapshotId) =>
      (
        await request(
          "GET",
          `/mcp-snapshots/${id(snapshotId)}`,
          mcpSnapshotResultSchema,
        )
      ).snapshot,
    listDrivers: async () =>
      (await request("GET", "/sandbox-drivers", RESPONSES.drivers)).drivers,
    getModels: () => request("GET", "/models", modelsViewSchema),
    putProviderKey: (providerId, body) =>
      request(
        "PUT",
        `/models/providers/${id(providerId)}/key`,
        modelsViewSchema,
        command(putSecretCommandSchema, body),
      ),
    deleteProviderKey: (providerId) =>
      request(
        "DELETE",
        `/models/providers/${id(providerId)}/key`,
        modelsViewSchema,
      ),
    listSecrets: () => request("GET", "/secrets", secretsViewSchema),
    putSecret: async (name, body) =>
      (
        await request(
          "PUT",
          `/secrets/${id(name)}`,
          z.object({ secret: secretInfoSchema }),
          command(putSecretCommandSchema, body),
        )
      ).secret,
    deleteSecret: (name) => request("DELETE", `/secrets/${id(name)}`, null),
    getUsage: () => request("GET", "/usage", usageReportSchema),

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
    updateTask: async (taskId, cmd) =>
      (
        await request(
          "PATCH",
          `/tasks/${id(taskId)}`,
          RESPONSES.task,
          command(updateTaskCommandSchema, cmd),
        )
      ).task,
    decideApproval: async (taskId, approvalId, cmd) =>
      (
        await request(
          "POST",
          `/tasks/${id(taskId)}/approvals/${id(approvalId)}`,
          RESPONSES.approval,
          command(decideApprovalCommandSchema, cmd),
        )
      ).approval,
    listTemplates: async () =>
      (await request("GET", "/task-templates", taskTemplateListSchema))
        .templates,
    getTemplate: async (templateId) =>
      (
        await request(
          "GET",
          `/task-templates/${id(templateId)}`,
          taskTemplateResultSchema,
        )
      ).template,
    createTemplate: async (cmd) =>
      (
        await request(
          "POST",
          "/task-templates",
          taskTemplateResultSchema,
          command(createTaskTemplateCommandSchema, cmd),
        )
      ).template,
    updateTemplate: async (templateId, cmd) =>
      (
        await request(
          "PATCH",
          `/task-templates/${id(templateId)}`,
          taskTemplateResultSchema,
          command(updateTaskTemplateCommandSchema, cmd),
        )
      ).template,
    deleteTemplate: (templateId) =>
      request("DELETE", `/task-templates/${id(templateId)}`, null),
    startTemplate: async (templateId, cmd) =>
      (
        await request(
          "POST",
          `/task-templates/${id(templateId)}/tasks`,
          RESPONSES.task,
          command(startTemplateCommandSchema, cmd),
        )
      ).task,
    subscribeTask: (taskId, onView, streamOptions) =>
      followTask(taskId, getTask, openTaskEvents, onView, {
        retryMs,
        ...streamOptions,
      }),
    artifactUrl: (taskId, artifactId) =>
      `${http.baseUrl}/api/tasks/${id(taskId)}/artifacts/${id(artifactId)}/content`,
    // A link cannot carry the bearer token, so with one the UI fetches instead.
    ...(options.token
      ? {
          fetchArtifact: (taskId: string, artifactId: string) =>
            http.download(
              `/tasks/${id(taskId)}/artifacts/${id(artifactId)}/content`,
            ),
        }
      : {}),
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
  | {
      ok: false;
      reason: string;
      /**
       * Whether the demo data may stand in: only when no JJ Bot backend is
       * there at all (a static build of the app, or a scaffold API). An API
       * that is unreachable, refuses or cannot be used is never replaced by
       * demo data, which would pass for the user's workspace.
       */
      demo: boolean;
    };

const majorOf = (version: string) => version.split(".")[0];

/**
 * Whether `html` is this app's own index.html, as a static host answers
 * every path with: it loads the page's own entry script (or, outside a
 * built page, has the app's root and a module script).
 */
function isAppPage(html: string): boolean {
  // Typed loosely: this module also runs in Node (the API's client tests).
  const page = (
    globalThis as {
      document?: {
        querySelector(selector: string): {
          getAttribute(name: string): string | null;
        } | null;
      };
    }
  ).document;
  const entry =
    page?.querySelector('script[type="module"][src]')?.getAttribute("src") ??
    null;
  return entry
    ? html.includes(`src="${entry}"`)
    : html.includes('<div id="root">') &&
        /<script\b[^>]*type="module"/.test(html);
}

const probeFailure = (demo: boolean, reason: string): BackendProbe => ({
  ok: false,
  demo,
  reason,
});

const UNREACHABLE = "The JJ Bot API isn't reachable.";
const NO_API = "No JJ Bot API answers here.";

/**
 * Asks `/api/bootstrap` whether a compatible backend is there. Never throws:
 * the reason it is not usable is shown in the demo badge's tooltip, or, when
 * the demo data may not stand in, in place of the app. The demo data may
 * stand in only for a 404, the app's own index.html (a static host) or a
 * scaffold API; a redirect (a sign-in page), any other answer or none at all
 * is a backend the app cannot use.
 */
export async function probeBackend(
  options: HttpOptions,
): Promise<BackendProbe> {
  const { baseUrl = "", token, fetch: fetchImpl } = options;
  const doFetch =
    fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  let response: Response;
  try {
    response = await doFetch(`${baseUrl}/api/bootstrap`, {
      headers: {
        Accept: "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      cache: "no-store",
    });
  } catch {
    // Offline, or nothing listening.
    return probeFailure(false, UNREACHABLE);
  }
  const { status } = response;
  if (status === 401)
    return probeFailure(
      false,
      "The API requires a token. Open the app once with ?token=<API_TOKEN> to keep it in this browser.",
    );
  // The server down behind a proxy.
  if (status >= 500) return probeFailure(false, UNREACHABLE);
  if (response.redirected) {
    const to = response.url ? ` to ${new URL(response.url).pathname}` : "";
    return probeFailure(
      false,
      `The API's address was redirected${to} (HTTP ${status}) instead of answering, as to a sign-in page.`,
    );
  }
  if (status === 404) return probeFailure(true, NO_API);
  const text = await response.text().catch(() => "");
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    if (response.ok && isAppPage(text)) return probeFailure(true, NO_API);
    return probeFailure(
      false,
      `The API's address answered HTTP ${status} with a web page, not the JJ Bot API.`,
    );
  }
  if (!response.ok) {
    const envelope = errorEnvelopeSchema.safeParse(data);
    return probeFailure(
      false,
      `The JJ Bot API answered HTTP ${status}${envelope.success ? `: ${envelope.data.error.message}` : "."}`,
    );
  }
  const parsed = bootstrapSchema.safeParse(data);
  if (!parsed.success)
    return probeFailure(
      false,
      `The API's bootstrap doesn't match contract ${CONTRACT_VERSION}.`,
    );
  const bootstrap = parsed.data;
  if (bootstrap.mode !== "backend")
    return probeFailure(
      true,
      "The API is running in scaffold mode, with no backend behind it.",
    );
  if (majorOf(bootstrap.contractVersion) !== majorOf(CONTRACT_VERSION))
    return probeFailure(
      false,
      `The API speaks contract ${bootstrap.contractVersion}; this app needs ${CONTRACT_VERSION}.`,
    );
  const { request } = createHttp(options);
  const models = await request("GET", "/models", modelsViewSchema).catch(
    () => null,
  );
  return { ok: true, bootstrap, models };
}
