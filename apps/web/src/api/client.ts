/**
 * The single seam between the UI and the backend.
 *
 * Every component talks to the backend only through this interface (via
 * `useApi()`). Today it is backed by `createDemoApi()` with local fixture
 * data. To integrate the real backend, implement `JJApi` against the API and
 * pass it to `<ApiProvider api={...}>` in `main.tsx` — no component changes
 * should be needed.
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

export interface JJApi {
  /** "demo" shows the demo-data banner and demo-only controls. */
  readonly mode: "demo" | "live";

  // Bots
  listBots(): Promise<BotProfile[]>;
  createBot(input: NewBotInput): Promise<BotProfile>;
  updateBot(botId: string, patch: BotPatch): Promise<BotProfile>;

  // 1:1 bot chat
  listDirectMessages(botId: string): Promise<DirectMessage[]>;
  /** Returns the full, updated conversation. */
  sendDirectMessage(botId: string, text: string): Promise<DirectMessage[]>;

  // Tasks
  listTasks(): Promise<TaskView[]>;
  createTask(input: NewTaskInput): Promise<TaskView>;
  postTaskMessage(taskId: string, input: TaskMessageInput): Promise<TaskView>;
  stopTask(taskId: string): Promise<TaskView>;

  /**
   * Live updates for one task (group chat, sessions, checks).
   * Returns an unsubscribe function.
   * TODO(backend): back this with the task event stream.
   */
  subscribeToTask(
    taskId: string,
    onUpdate: (task: TaskView) => void,
  ): () => void;

  /** Demo only: advance a task's sessions one step to preview graph states. */
  advanceDemoTask?(taskId: string): Promise<TaskView>;
}
