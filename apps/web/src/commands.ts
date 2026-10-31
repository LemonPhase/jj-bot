import type {
  CreateBotCommand,
  CreateTaskCommand,
  PostTaskMessageCommand,
  SteerTaskCommand,
  StopTaskCommand,
} from "@jj/contracts";

// Command endpoints the backend (tasks 02/04) will implement. They do not exist yet, so every
// send below fails with a real error that the UI shows. We deliberately do not simulate success.
export const commandRoutes = {
  bots: "/api/bots",
  tasks: "/api/tasks",
  message: (taskId: string) => `/api/tasks/${taskId}/messages`,
  steer: (taskId: string) => `/api/tasks/${taskId}/steer`,
  stop: (taskId: string) => `/api/tasks/${taskId}/stop`,
} as const;

export type CommandOutcome =
  | { status: "accepted" }
  | { status: "rejected"; reason: string };

async function send(url: string, body: unknown): Promise<CommandOutcome> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (response.ok) return { status: "accepted" };
    return {
      status: "rejected",
      reason:
        response.status === 404
          ? `No handler for ${url} yet (API returned 404). The backend command endpoints are not implemented.`
          : `API returned ${response.status} for ${url}.`,
    };
  } catch (reason) {
    return {
      status: "rejected",
      reason: reason instanceof Error ? reason.message : "Request failed.",
    };
  }
}

export const postTaskMessage = (command: PostTaskMessageCommand) =>
  send(commandRoutes.message(command.taskId), command);

export const steerTask = (command: SteerTaskCommand) =>
  send(commandRoutes.steer(command.taskId), command);

export const stopTask = (command: StopTaskCommand) =>
  send(commandRoutes.stop(command.taskId), command);

export const createBot = (command: CreateBotCommand) =>
  send(commandRoutes.bots, command);

export const createTask = (command: CreateTaskCommand) =>
  send(commandRoutes.tasks, command);
