/**
 * In-memory placeholder for the backend. It keeps the UI fully clickable while
 * the real API is built, but never pretends a bot replied or a session ran:
 * user actions are stored locally and answered with explicit system notices.
 */
import type { JJApi } from "./client";
import { demoBots, demoConversations, demoTasks } from "./fixtures";
import {
  BOT_COLORS,
  BOT_GLYPHS,
  type BotProfile,
  type DirectMessage,
  type TaskMessageView,
  type TaskView,
} from "./types";

const NOT_CONNECTED = "Demo mode · not sent, the backend isn't connected yet";

export function createDemoApi(): JJApi {
  let seq = 0;
  const uid = (prefix: string) => `${prefix}-${Date.now()}-${++seq}`;
  const now = () => new Date().toISOString();
  const clone = <T>(value: T): T => structuredClone(value);

  const bots: BotProfile[] = demoBots();
  const conversations: Record<string, DirectMessage[]> = demoConversations();
  let tasks: TaskView[] = demoTasks();
  const listeners = new Map<string, Set<(task: TaskView) => void>>();

  const getBot = (botId: string) => {
    const bot = bots.find((b) => b.id === botId);
    if (!bot) throw new Error(`Unknown bot ${botId}`);
    return bot;
  };
  const getTask = (taskId: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) throw new Error(`Unknown task ${taskId}`);
    return task;
  };
  const systemMessage = (text: string): TaskMessageView => ({
    id: uid("tm"),
    authorId: "system",
    authorKind: "system",
    intent: "notification",
    text,
    createdAt: now(),
  });
  const publish = (task: TaskView) => {
    task.updatedAt = now();
    for (const listener of listeners.get(task.id) ?? []) listener(clone(task));
    return clone(task);
  };

  return {
    mode: "demo",
    badge: {
      label: "Demo data",
      tone: "demo",
      title:
        "The API backend isn't reachable, so the UI is running on local demo data. Nothing is sent to bots.",
    },
    capabilities: { editBotIdentity: true },

    async listBots() {
      return clone(bots);
    },

    async createBot(input) {
      const bot: BotProfile = {
        id: uid("bot"),
        name: input.name,
        role: input.role,
        instructions: input.instructions,
        color: BOT_COLORS[bots.length % BOT_COLORS.length] ?? BOT_COLORS[0],
        glyph: BOT_GLYPHS[bots.length % BOT_GLYPHS.length] ?? BOT_GLYPHS[0],
        presence: "online",
        memory: "",
      };
      bots.push(bot);
      conversations[bot.id] = [];
      return clone(bot);
    },

    async updateBot(botId, patch) {
      const bot = getBot(botId);
      Object.assign(bot, patch);
      return clone(bot);
    },

    async listDirectMessages(botId) {
      return clone(conversations[botId] ?? []);
    },

    async sendDirectMessage(botId, text) {
      getBot(botId);
      const thread = conversations[botId] ?? [];
      conversations[botId] = thread;
      thread.push(
        { id: uid("m"), botId, role: "user", text, createdAt: now() },
        {
          id: uid("m"),
          botId,
          role: "system",
          text: NOT_CONNECTED,
          createdAt: now(),
        },
      );
      return clone(thread);
    },

    subscribeToConversation() {
      return () => {};
    },

    subscribeToTasks() {
      return () => {};
    },

    async listTasks() {
      return clone(tasks);
    },

    async createTask(input) {
      const [coordinatorBotId] = input.participantBotIds;
      if (!coordinatorBotId) throw new Error("A task needs at least one bot");
      const names = input.participantBotIds.map((id) => getBot(id).name);
      const task: TaskView = {
        id: uid("task"),
        goal: input.goal,
        goalVersion: 1,
        status: "queued",
        coordinatorBotId,
        participantBotIds: [...input.participantBotIds],
        updatedAt: now(),
        sessions: input.participantBotIds.map((botId, index) => ({
          id: uid("sess"),
          botId,
          label: `s-${index + 1} · ${index === 0 ? "Coordinate" : "Work"}`,
          status: "queued",
          brief: `${index === 0 ? "Coordinate" : "Execute"} work for: ${input.goal}`,
          tools: [],
          evidence: "Not started",
        })),
        checks: [
          {
            id: uid("chk"),
            description: input.verificationCriterion,
            outcome: "inconclusive",
            evidence: "Not run yet",
          },
        ],
        messages: [
          systemMessage(
            `Task created with ${names.join(", ")} · ${NOT_CONNECTED}`,
          ),
        ],
      };
      tasks = [task, ...tasks];
      return clone(task);
    },

    async postTaskMessage(taskId, { text, steering }) {
      const task = getTask(taskId);
      task.messages.push({
        id: uid("tm"),
        authorId: "user",
        authorKind: "user",
        intent: steering ? "steering" : "discussion",
        text,
        createdAt: now(),
      });
      if (steering) {
        task.goalVersion += 1;
        for (const check of task.checks) {
          check.outcome = "inconclusive";
          check.evidence = `Stale after steering to v${task.goalVersion}`;
        }
        task.messages.push(
          systemMessage(
            `Goal steered to v${task.goalVersion} · ${NOT_CONNECTED}`,
          ),
        );
      } else {
        task.messages.push(systemMessage(NOT_CONNECTED));
      }
      return publish(task);
    },

    async stopTask(taskId) {
      const task = getTask(taskId);
      task.status = "cancelled";
      for (const session of task.sessions) {
        if (session.status !== "completed") session.status = "cancelled";
      }
      task.messages.push(
        systemMessage("Task stopped by user · Active sessions cancelled"),
      );
      return publish(task);
    },

    subscribeToTask(taskId, onUpdate) {
      const set = listeners.get(taskId) ?? new Set();
      set.add(onUpdate);
      listeners.set(taskId, set);
      return () => {
        set.delete(onUpdate);
      };
    },

    async advanceDemoTask(taskId) {
      const task = getTask(taskId);
      const queued = task.sessions.find((s) => s.status === "queued");
      const running = task.sessions.find((s) => s.status === "running");
      const verifying = task.sessions.find((s) => s.status === "verifying");
      if (queued) {
        queued.status = "running";
        queued.evidence = "Demo step · running";
        task.status = "running";
      } else if (running) {
        running.status = "verifying";
        running.evidence = "Demo step · verifying";
      } else if (verifying) {
        verifying.status = "completed";
        verifying.evidence = "Demo step · completed";
        if (task.sessions.every((s) => s.status === "completed")) {
          task.status = "completed";
          for (const check of task.checks) {
            check.outcome = "passed";
            check.evidence = `Demo step · marked passed on v${task.goalVersion}`;
          }
        }
      } else {
        task.status = "running";
        task.sessions.forEach((session, index) => {
          session.status =
            index === 0 ? "completed" : index === 1 ? "running" : "verifying";
        });
      }
      return publish(task);
    },
  };
}
