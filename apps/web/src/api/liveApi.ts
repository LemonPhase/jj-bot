/**
 * `JJApi` backed by the real `@jj/api` service (see apps/api/src/routes.ts).
 * Responses are validated against the shared contracts before mapping.
 */
import {
  type Bootstrap,
  bootstrapSchema,
  botSchema,
  taskEventSchema,
  taskSchema,
  taskViewSchema,
  z,
} from "@jj/contracts";
import type { ApiBadge, JJApi } from "./client";
import {
  type BotAppearance,
  TERMINAL_STATUSES,
  toBotProfile,
  toTaskView,
} from "./liveMapping";
import type { BotProfile, DirectMessage, TaskView } from "./types";

const conversationSchema = z.object({
  messages: z.array(
    z.object({
      id: z.string(),
      botId: z.string(),
      role: z.enum(["user", "assistant"]),
      text: z.string(),
      createdAt: z.string(),
      taskId: z.string().optional(),
    }),
  ),
});
const memorySchema = z.object({ memory: z.object({ text: z.string() }) });
const EVENT_TYPES = taskEventSchema.shape.type.options;
const CONVERSATION_POLL_MS = 3000;
const TASK_LIST_POLL_MS = 5000;
const APPEARANCE_KEY = "jj.botAppearance";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
  schema?: z.ZodType<T>,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: init.method ?? "GET",
    headers:
      init.body === undefined
        ? undefined
        : { "Content-Type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const data: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = (data ?? {}) as { error?: string; message?: string };
    throw new ApiError(
      response.status,
      error.error ?? "HTTP_ERROR",
      error.message ?? error.error ?? `Request failed (${response.status})`,
    );
  }
  return schema ? schema.parse(data) : (data as T);
}

function loadAppearance(): Record<string, BotAppearance> {
  try {
    return JSON.parse(localStorage.getItem(APPEARANCE_KEY) ?? "{}");
  } catch {
    return {};
  }
}

function saveAppearance(botId: string, patch: BotAppearance) {
  try {
    const all = loadAppearance();
    all[botId] = { ...all[botId], ...patch };
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify(all));
  } catch {
    // Storage unavailable: appearance falls back to defaults on reload.
  }
}

function badgeFor(bootstrap: Bootstrap): ApiBadge {
  if (!bootstrap.capabilities.agentExecution)
    return {
      label: "Live · no model",
      tone: "warning",
      title:
        "Connected to the backend, but no Gemini model is configured, so sessions cannot run. Set GEMINI_API_KEY and GEMINI_MODEL in .env.",
    };
  return {
    label: "Live",
    tone: "live",
    title: `Connected to the JJ backend · contract ${bootstrap.contractVersion}`,
  };
}

const sameThread = (a: DirectMessage[], b: DirectMessage[]) =>
  a.length === b.length && a.at(-1)?.id === b.at(-1)?.id;

export function createLiveApi(bootstrap: Bootstrap): JJApi {
  const getView = async (taskId: string) =>
    toTaskView(await request(`/tasks/${taskId}`, {}, taskViewSchema));

  const getMemory = async (botId: string) =>
    (await request(`/bots/${botId}/memory`, {}, memorySchema)).memory.text;

  const getBotProfile = async (botId: string): Promise<BotProfile> => {
    const [bot, memory] = await Promise.all([
      request(`/bots/${botId}`, {}, botSchema),
      getMemory(botId),
    ]);
    return toBotProfile(bot, memory, loadAppearance()[botId]);
  };

  const listDirectMessages = async (botId: string) =>
    (
      await request(`/bots/${botId}/messages`, {}, conversationSchema)
    ).messages.map((m): DirectMessage => ({ ...m }));

  const listTasks = async (): Promise<TaskView[]> => {
    const { tasks } = await request(
      "/tasks",
      {},
      z.object({ tasks: z.array(z.object(taskSchema.shape).passthrough()) }),
    );
    const views = await Promise.all(tasks.map((t) => getView(t.id)));
    return views.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  };

  const poll = <T>(
    load: () => Promise<T>,
    onUpdate: (value: T) => void,
    intervalMs: number,
    changed: (prev: T | undefined, next: T) => boolean = () => true,
  ) => {
    let stopped = false;
    let previous: T | undefined;
    const tick = async () => {
      try {
        const next = await load();
        if (!stopped && changed(previous, next)) onUpdate(next);
        previous = next;
      } catch {
        // Transient failures are retried on the next tick.
      }
    };
    const timer = setInterval(tick, intervalMs);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  };

  return {
    mode: "live",
    badge: badgeFor(bootstrap),
    capabilities: { editBotIdentity: false },

    async listBots() {
      const { bots } = await request(
        "/bots",
        {},
        z.object({ bots: z.array(botSchema) }),
      );
      const appearance = loadAppearance();
      const memories = await Promise.all(bots.map((b) => getMemory(b.id)));
      return bots.map((bot, i) =>
        toBotProfile(bot, memories[i] ?? "", appearance[bot.id]),
      );
    },

    async createBot(input) {
      const bot = await request(
        "/bots",
        {
          method: "POST",
          body: { name: input.name, instructions: input.instructions },
        },
        botSchema,
      );
      saveAppearance(bot.id, { role: input.role });
      return toBotProfile(bot, "", loadAppearance()[bot.id]);
    },

    async updateBot(botId, patch) {
      if (patch.name !== undefined || patch.instructions !== undefined)
        throw new Error(
          "The backend can't edit a bot's name or instructions yet.",
        );
      if (patch.memory !== undefined)
        await request(`/bots/${botId}/memory`, {
          method: "PUT",
          body: { text: patch.memory },
        });
      const { role, color, glyph } = patch;
      if (role !== undefined || color !== undefined || glyph !== undefined)
        saveAppearance(botId, { role, color, glyph });
      return getBotProfile(botId);
    },

    listDirectMessages,

    async sendDirectMessage(botId, text) {
      // The backend routes this turn: conversation is answered in the thread,
      // work becomes a task, and follow-ups attach to an active task.
      await request(`/bots/${botId}/turn`, {
        method: "POST",
        body: { text },
      });
      return listDirectMessages(botId);
    },

    subscribeToConversation(botId, onUpdate) {
      return poll(
        () => listDirectMessages(botId),
        onUpdate,
        CONVERSATION_POLL_MS,
        (prev, next) => !prev || !sameThread(prev, next),
      );
    },

    listTasks,

    subscribeToTasks(onUpdate) {
      return poll(listTasks, onUpdate, TASK_LIST_POLL_MS);
    },

    async createTask(input) {
      const [coordinatorBotId] = input.participantBotIds;
      if (!coordinatorBotId) throw new Error("A task needs at least one bot");
      const task = await request(
        "/tasks",
        {
          method: "POST",
          body: {
            goal: input.goal,
            coordinatorBotId,
            participantBotIds: input.participantBotIds,
            verificationPlan: [
              {
                id: "criterion-1",
                description: input.verificationCriterion,
                method: "Independent rubric review",
                expectedEvidence: "Session results and reviewer assessment",
              },
            ],
          },
        },
        z.object({ id: z.string() }).passthrough(),
      );
      return getView(task.id);
    },

    async postTaskMessage(taskId, { text, steering, observedGoalVersion }) {
      if (steering)
        await request(`/tasks/${taskId}/steer`, {
          method: "POST",
          body: { text, observedGoalVersion },
        });
      else
        await request(`/tasks/${taskId}/messages`, {
          method: "POST",
          body: { text },
        });
      return getView(taskId);
    },

    async stopTask(taskId) {
      await request(`/tasks/${taskId}/stop`, {
        method: "POST",
        body: { reason: "Stopped from the workspace" },
      });
      return getView(taskId);
    },

    subscribeToTask(taskId, onUpdate) {
      let source: EventSource | null = null;
      let closed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const refresh = async () => {
        try {
          const view = await getView(taskId);
          if (closed) return;
          onUpdate(view);
          if (TERMINAL_STATUSES.has(view.status)) source?.close();
        } catch {
          // Next event triggers another refresh.
        }
      };
      const scheduleRefresh = () => {
        clearTimeout(timer);
        timer = setTimeout(refresh, 150);
      };

      void (async () => {
        try {
          const view = await getView(taskId);
          if (closed || TERMINAL_STATUSES.has(view.status)) return;
          // Server-sent task events; each one triggers a fresh read-model fetch.
          source = new EventSource(`/api/tasks/${taskId}/stream`);
          for (const type of EVENT_TYPES)
            source.addEventListener(type, scheduleRefresh);
        } catch {
          // Task not readable; nothing to stream.
        }
      })();

      return () => {
        closed = true;
        clearTimeout(timer);
        source?.close();
      };
    },
  };
}

/** `null` when the API is unreachable or replies with something unexpected. */
export async function fetchBootstrap(): Promise<Bootstrap | null> {
  try {
    return await request("/bootstrap", {}, bootstrapSchema);
  } catch {
    return null;
  }
}
