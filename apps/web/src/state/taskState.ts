/**
 * Pure pieces of the workspace's task state, kept out of the React provider
 * so they can be tested on their own.
 */
import type {
  Bot,
  Task,
  TaskMessage,
  TaskView,
  WorkspaceHint,
} from "@jj/contracts";
import type { ApiError } from "../api/client";
import { isTerminalTaskError } from "../api/follow";

/** Why the open task could not be loaded or followed, while that lasts. */
export interface TaskProblem {
  taskId: string;
  error: ApiError;
  /** NOT_FOUND or UNAUTHORIZED: the subscription stopped; retrying will not help on its own. */
  terminal: boolean;
}

export const taskProblem = (taskId: string, error: ApiError): TaskProblem => ({
  taskId,
  error,
  terminal: isTerminalTaskError(error),
});

/**
 * The key the conversation subscriptions are keyed on: the bot ids, sorted, so
 * a reordered bot list does not tear down and reopen every subscription.
 */
export const conversationKey = (bots: readonly Pick<Bot, "id">[]): string =>
  bots
    .map((bot) => bot.id)
    .sort()
    .join("\n");

/**
 * Whether a hint needs the task list refetched. A `tasks.changed` hint for the
 * task being streamed is skipped: its summary already comes from its view.
 */
export function hintNeedsTaskList(
  hint: WorkspaceHint,
  streamedTaskId: string | null,
): boolean {
  if (hint.type !== "tasks.changed") return false;
  return hint.taskId !== streamedTaskId;
}

/**
 * Records the API returned before the stream delivered them: the message a
 * post stored and the task a stop request changed. They are shown at once and
 * dropped once the streamed view has caught up.
 */
export interface TaskOverlay {
  messages: TaskMessage[];
  task: Task | null;
}

export const emptyOverlay = (): TaskOverlay => ({ messages: [], task: null });

const upsertById = <Item extends { id: string }>(
  items: readonly Item[],
  item: Item,
): Item[] =>
  items.some((existing) => existing.id === item.id)
    ? items.map((existing) => (existing.id === item.id ? item : existing))
    : [...items, item];

export const overlayMessage = (
  overlay: TaskOverlay | undefined,
  message: TaskMessage,
): TaskOverlay => {
  const base = overlay ?? emptyOverlay();
  return { ...base, messages: upsertById(base.messages, message) };
};

export const overlayTask = (
  overlay: TaskOverlay | undefined,
  task: Task,
): TaskOverlay => ({ ...(overlay ?? emptyOverlay()), task });

/** The overlay entries the view does not reflect yet; null when none are left. */
export function pruneOverlay(
  view: TaskView,
  overlay: TaskOverlay,
): TaskOverlay | null {
  const known = new Set(view.messages.map((message) => message.id));
  const messages = overlay.messages.filter(
    (message) => message.taskId === view.task.id && !known.has(message.id),
  );
  const task =
    overlay.task &&
    overlay.task.id === view.task.id &&
    overlay.task.updatedAt > view.task.updatedAt
      ? overlay.task
      : null;
  if (messages.length === 0 && task === null) return null;
  if (messages.length === overlay.messages.length && task === overlay.task)
    return overlay;
  return { messages, task };
}

/**
 * The view with the overlay applied: overlay messages deduplicated by id and
 * kept in sequence order, and the overlay task when it is newer.
 */
export function applyOverlay(
  view: TaskView,
  overlay: TaskOverlay | undefined,
): TaskView {
  const pending = overlay && pruneOverlay(view, overlay);
  if (!pending) return view;
  const messages = pending.messages.length
    ? [...view.messages, ...pending.messages].sort(
        (a, b) => a.sequence - b.sequence,
      )
    : view.messages;
  return { ...view, task: pending.task ?? view.task, messages };
}
