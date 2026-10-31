/**
 * The one status vocabulary (frontend brief, decision 2): a mono word plus a
 * 6px square whose colour comes from `statusColour`.
 */
import type {
  ExecutionSession,
  SessionStatus,
  Task,
  TaskStatus,
} from "@jj/contracts";

export type StatusWord =
  | "queued"
  | "working"
  | "waiting"
  | "done"
  | "failed"
  | "stopped"
  | "stopping";

export type StatusColour = "grey" | "blue" | "green" | "red";

const WORDS: Record<TaskStatus | SessionStatus, StatusWord> = {
  queued: "queued",
  running: "working",
  waiting: "waiting",
  completed: "done",
  failed: "failed",
  cancelled: "stopped",
};

const COLOURS: Record<StatusWord, StatusColour> = {
  queued: "grey",
  working: "blue",
  waiting: "grey",
  done: "green",
  failed: "red",
  stopped: "grey",
  stopping: "grey",
};

export const statusWord = (status: TaskStatus | SessionStatus): StatusWord =>
  WORDS[status];

/** A task the user asked to stop reads "stopping" until it is cancelled. */
export const taskStatusWord = (
  task: Pick<Task, "status" | "cancelRequestedAt">,
): StatusWord =>
  task.cancelRequestedAt && task.status !== "cancelled"
    ? "stopping"
    : WORDS[task.status];

export const statusColour = (word: StatusWord): StatusColour => COLOURS[word];

/** Tooltip for a waiting session: what it is waiting on. */
export const waitingTooltip = (
  session: Pick<ExecutionSession, "status" | "waitingFor">,
): string | undefined => {
  if (session.status !== "waiting") return undefined;
  if (session.waitingFor === "user") return "waiting for you";
  if (session.waitingFor === "delegations") return "waiting on delegated work";
  return "waiting";
};

/** Stop is offered until the task finishes or a stop was requested. */
export const isStoppable = (
  task: Pick<Task, "status" | "cancelRequestedAt">,
): boolean =>
  (task.status === "queued" ||
    task.status === "running" ||
    task.status === "waiting") &&
  !task.cancelRequestedAt;

/** The API answers TASK_TERMINAL for a cancelled or stopping task. */
export const acceptsMessages = (
  task: Pick<Task, "status" | "cancelRequestedAt">,
): boolean => task.status !== "cancelled" && !task.cancelRequestedAt;
