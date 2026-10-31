/**
 * The single seam between the UI and the backend.
 *
 * Every component talks to the backend only through this interface (via
 * `useApi()`). `resolveApi()` picks the live backend when `/api/bootstrap`
 * reports `mode: "backend"`, and falls back to the in-memory demo otherwise.
 */
import type {
  BotPatch,
  BotProfile,
  DirectMessage,
  NewBotInput,
  NewTaskInput,
  TaskMessageInput,
  TaskView,
} from "./types";

export interface ApiBadge {
  label: string;
  tone: "demo" | "live" | "warning";
  title: string;
}

export interface JJApi {
  readonly mode: "demo" | "live";
  /** Shown in the top bar so it is always clear what the UI is talking to. */
  readonly badge: ApiBadge;
  readonly capabilities: {
    /** Whether a bot's name and instructions can be edited after creation. */
    editBotIdentity: boolean;
  };

  // Bots
  listBots(): Promise<BotProfile[]>;
  createBot(input: NewBotInput): Promise<BotProfile>;
  updateBot(botId: string, patch: BotPatch): Promise<BotProfile>;

  // 1:1 bot chat
  listDirectMessages(botId: string): Promise<DirectMessage[]>;
  /** Returns the full, updated conversation. */
  sendDirectMessage(botId: string, text: string): Promise<DirectMessage[]>;
  /** Pushes conversation updates (e.g. a bot reply). Returns an unsubscribe function. */
  subscribeToConversation(
    botId: string,
    onUpdate: (messages: DirectMessage[]) => void,
  ): () => void;

  // Tasks
  listTasks(): Promise<TaskView[]>;
  /** Pushes the full task list when tasks are created or change elsewhere. */
  subscribeToTasks(onUpdate: (tasks: TaskView[]) => void): () => void;
  createTask(input: NewTaskInput): Promise<TaskView>;
  postTaskMessage(taskId: string, input: TaskMessageInput): Promise<TaskView>;
  stopTask(taskId: string): Promise<TaskView>;
  /** Live updates for one task (group chat, sessions, checks). */
  subscribeToTask(
    taskId: string,
    onUpdate: (task: TaskView) => void,
  ): () => void;

  /** Demo only: advance a task's sessions one step to preview graph states. */
  advanceDemoTask?(taskId: string): Promise<TaskView>;
}
