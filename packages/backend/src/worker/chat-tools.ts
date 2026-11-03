// Direct chat's task tools. Each covers only the tasks the bot takes part in
// (its task_participants rows): list_tasks, get_task and read_task_log read
// them through the task log service and write nothing; create_task,
// send_to_task and stop_task act, keyed by the user message being answered so
// a reply that runs again repeats nothing. Task ids are plain string
// parameters checked inside each tool, so the definitions are the same
// whatever tasks exist (they lead the prompt cache).
import { FINISHED_TASK_STATUSES } from "@jj/contracts";
import {
  bots,
  type Executor,
  TASK_STATUSES,
  type TaskRow,
  type Tx,
  taskMessages,
  taskParticipants,
  tasks,
} from "@jj/db";
import {
  and,
  count,
  desc,
  eq,
  gt,
  inArray,
  notInArray,
  type SQL,
} from "drizzle-orm";
import type { EngineContext } from "../context";
import { DomainError, errorMessage } from "../errors";
import type { CollabTool, CollabToolResult } from "../ports";
import { continueTask, deliver, postMessage } from "../services/messages";
import { lockTask } from "../services/sessions";
import {
  clipLine,
  formatEntry,
  formatTaskLogPage,
  formatTaskState,
  hasNul,
  listTaskLog,
  type Redact,
  readTaskLogEntry,
  readTaskState,
} from "../services/task-log";
import { createTaskTx, requestStopTx } from "../services/tasks";
import {
  guardedLookup,
  results,
  taskLogPageResult,
  taskLogProperties,
} from "./lookup-tools";
import { textArg } from "./tool-args";

const HOUR_MS = 60 * 60_000;

/** Tasks `list_tasks` shows by default, and at most. */
export const LIST_TASKS_DEFAULT = 10;
export const LIST_TASKS_MAX = 50;
/** Task log entries `get_task` shows. */
export const GET_TASK_LOG_ENTRIES = 10;

/** The read tools: all an update-triggered reply gets. */
export const CHAT_READ_TOOLS = [
  "list_tasks",
  "get_task",
  "read_task_log",
] as const;

export interface ChatState {
  /**
   * The user message being answered. Side effects are keyed by it, so a reply
   * that runs again after a hand-off or crash does not repeat them.
   */
  triggerId: string;
  /** The task the reply created, continued or stopped: its card goes under the reply. */
  linkedTaskId: string | null;
  /** Tasks the reply opened with `get_task` or `read_task_log`. */
  lookedAt: Set<string>;
}

export type Write = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

export interface ChatToolsInput {
  ctx: EngineContext;
  bot: { id: string; name: string };
  redact: Redact;
  /** Records the tasks the reply opens. */
  state?: Pick<ChatState, "lookedAt">;
}

export interface ChatActInput extends ChatToolsInput {
  write: Write;
  everyone: readonly { id: string; name: string; model: string | null }[];
  state: ChatState;
}

const STATUS_FILTERS = [...TASK_STATUSES, "unfinished", "finished"] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];

const taskIdProperty = {
  type: "string",
  description: "The task's id (task_…), as `list_tasks` shows it.",
};

const notYours = (id: string) =>
  `You take part in no task ${JSON.stringify(id)}. Task ids look like task_… and come from \`list_tasks\`.`;

/** The task and the bot's role in it; undefined when the bot does not take part. */
async function membership(
  exec: Executor,
  botId: string,
  taskId: string,
): Promise<{ task: TaskRow; coordinator: boolean } | undefined> {
  if (!taskId || hasNul(taskId)) return undefined;
  const [row] = await exec
    .select({ task: tasks })
    .from(taskParticipants)
    .innerJoin(tasks, eq(tasks.id, taskParticipants.taskId))
    .where(
      and(
        eq(taskParticipants.taskId, taskId),
        eq(taskParticipants.botId, botId),
      ),
    );
  return row
    ? { task: row.task, coordinator: row.task.coordinatorBotId === botId }
    : undefined;
}

const statusText = (task: Pick<TaskRow, "status" | "cancelRequestedAt">) =>
  task.cancelRequestedAt && task.status !== "cancelled"
    ? "stopping"
    : task.status === "waiting"
      ? "waiting for the user"
      : task.status;

const minute = (date: Date) => `${date.toISOString().slice(0, 16)}Z`;

/**
 * One `list_tasks` line: `- <id> "<title>": <status> · you coordinate ·
 * updated <time>`, then the result or error on one line. The scripted test
 * model reads the id, title and status.
 */
function taskLine(
  task: Pick<
    TaskRow,
    | "id"
    | "title"
    | "status"
    | "cancelRequestedAt"
    | "coordinatorBotId"
    | "result"
    | "error"
    | "updatedAt"
  >,
  botId: string,
  redact: Redact,
): string {
  const parts = [
    `- ${task.id} ${JSON.stringify(task.title)}: ${statusText(task)}`,
    task.coordinatorBotId === botId ? "you coordinate" : "you take part",
    `updated ${minute(task.updatedAt)}`,
  ];
  if (task.result !== null)
    parts.push(`Result: ${clipLine(redact(task.result), 120)}`);
  if (task.error !== null)
    parts.push(`Error: ${clipLine(redact(task.error), 120)}`);
  return parts.join(" · ");
}

function statusCondition(filter: StatusFilter | undefined): SQL | undefined {
  if (filter === undefined) return undefined;
  if (filter === "unfinished")
    return notInArray(tasks.status, [...FINISHED_TASK_STATUSES]);
  if (filter === "finished")
    return inArray(tasks.status, [...FINISHED_TASK_STATUSES]);
  return eq(tasks.status, filter);
}

/** The read tools: list_tasks, get_task and read_task_log. */
export function chatReadTools(input: ChatToolsInput): CollabTool[] {
  const { ctx, bot, redact } = input;
  const { db, logger } = ctx;
  const { ok, refuse } = results(redact);
  const guarded = (
    run: (args: Record<string, unknown>) => Promise<CollabToolResult>,
  ) => guardedLookup(redact, logger, { botId: bot.id, chat: true }, run);
  return [
    {
      name: "list_tasks",
      description:
        "Your tasks (the ones you take part in), newest first: each with its id, title, status, your role, when it last changed and its result or error on one line.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: [...STATUS_FILTERS],
            description:
              "Only tasks in this status; unfinished is queued, running or waiting, finished is completed, failed or cancelled.",
          },
          limit: {
            type: "integer",
            description: `At most this many tasks (default ${LIST_TASKS_DEFAULT}, at most ${LIST_TASKS_MAX}).`,
          },
        },
        additionalProperties: false,
      },
      readOnly: true,
      summarize: (args) => textArg(args.status) ?? "all",
      execute: guarded(async (args) => {
        const status = textArg(args.status);
        if (
          status !== undefined &&
          !STATUS_FILTERS.includes(status as StatusFilter)
        )
          return refuse(
            `Unknown status ${status}. Use one of: ${STATUS_FILTERS.join(", ")}.`,
          );
        const requested = Number(args.limit ?? LIST_TASKS_DEFAULT);
        const limit = Number.isFinite(requested)
          ? Math.min(Math.max(Math.floor(requested), 1), LIST_TASKS_MAX)
          : LIST_TASKS_DEFAULT;
        const where = and(
          eq(taskParticipants.botId, bot.id),
          statusCondition(status as StatusFilter | undefined),
        );
        const rows = await db
          .select({
            id: tasks.id,
            title: tasks.title,
            status: tasks.status,
            cancelRequestedAt: tasks.cancelRequestedAt,
            coordinatorBotId: tasks.coordinatorBotId,
            result: tasks.result,
            error: tasks.error,
            updatedAt: tasks.updatedAt,
          })
          .from(taskParticipants)
          .innerJoin(tasks, eq(tasks.id, taskParticipants.taskId))
          .where(where)
          .orderBy(desc(tasks.createdAt), desc(tasks.id))
          .limit(limit);
        if (rows.length === 0)
          return ok(
            status
              ? `None of your tasks is ${status}.`
              : "You take part in no tasks yet.",
          );
        const [total] = await db
          .select({ value: count() })
          .from(taskParticipants)
          .innerJoin(tasks, eq(tasks.id, taskParticipants.taskId))
          .where(where);
        const all = Number(total?.value ?? rows.length);
        const lines = [
          `Your ${status ? `${status} ` : ""}tasks, newest first (${rows.length} of ${all}):`,
          ...rows.map((task) => taskLine(task, bot.id, redact)),
        ];
        if (all > rows.length)
          lines.push(
            `(${all - rows.length} older not shown${limit < LIST_TASKS_MAX ? `: pass a larger limit, up to ${LIST_TASKS_MAX}` : ""}.)`,
          );
        return ok(lines.join("\n"));
      }),
    },
    {
      name: "get_task",
      description:
        "One of your tasks in detail: its goal and goal version, status, result or error, every session (bot, role, status, the first line of its brief) and its latest task log entries. Open an entry in full with `read_task_log`.",
      parameters: {
        type: "object",
        properties: { id: taskIdProperty },
        required: ["id"],
        additionalProperties: false,
      },
      readOnly: true,
      summarize: (args) => String(args.id ?? ""),
      execute: guarded(async (args) => {
        const id = textArg(args.id) ?? "";
        const member = await membership(db, bot.id, id);
        if (member) input.state?.lookedAt.add(id);
        if (!member) return refuse(notYours(id));
        const state = await readTaskState(db, id);
        if (!state) return refuse(notYours(id));
        const filter = { newest: true, limit: GET_TASK_LOG_ENTRIES };
        const page = await listTaskLog(db, id, filter);
        return ok(
          [
            formatTaskState(state, redact),
            member.coordinator
              ? "You coordinate this task."
              : "You take part in this task; another bot coordinates it.",
            "",
            "Latest task log entries:",
            page
              ? formatTaskLogPage(
                  page,
                  { newest: true },
                  { redact, tool: "read_task_log", args: { id } },
                )
              : "The task log is empty.",
          ].join("\n"),
        );
      }),
    },
    {
      name: "read_task_log",
      description:
        "One of your tasks' log: the user's messages, briefs, reports and every message between its bots, as an index (entry id msg_…, [kind], author → recipients, preview), newest entries by default; or, with `entry`, that entry in full. Session transcripts are private and never shown.",
      parameters: {
        type: "object",
        properties: {
          id: taskIdProperty,
          entry: {
            type: "string",
            description:
              "An entry's id (msg_…): return that entry in full instead of a page.",
          },
          ...taskLogProperties(true),
        },
        required: ["id"],
        additionalProperties: false,
      },
      readOnly: true,
      summarize: (args) =>
        [String(args.id ?? ""), textArg(args.entry) ?? textArg(args.query)]
          .filter(Boolean)
          .join(": "),
      execute: guarded(async (args) => {
        const id = textArg(args.id) ?? "";
        if (!(await membership(db, bot.id, id))) return refuse(notYours(id));
        input.state?.lookedAt.add(id);
        const noEntry = (entryId: string) =>
          `No entry ${JSON.stringify(entryId)} in the log of ${id}. Entry ids look like msg_… and start each index line.`;
        const entryId = textArg(args.entry);
        if (entryId) {
          const entry = await readTaskLogEntry(db, id, entryId);
          return entry
            ? ok(formatEntry(entry, redact))
            : refuse(noEntry(entryId));
        }
        return taskLogPageResult(db, id, args, {
          redact,
          tool: "read_task_log",
          args: { id },
          newestByDefault: true,
          noEntry,
        });
      }),
    },
  ];
}

/** The tools that act: create_task, send_to_task and stop_task. */
export function chatActTools(input: ChatActInput): {
  createTask: CollabTool;
  sendToTask: CollabTool;
  stopTask: CollabTool;
} {
  return {
    createTask: createTaskTool(input),
    sendToTask: sendToTaskTool(input),
    stopTask: stopTaskTool(input),
  };
}

/** Every tool of a reply to the user, in a fixed order. */
export function chatTools(input: ChatActInput): CollabTool[] {
  const act = chatActTools(input);
  return [
    act.createTask,
    ...chatReadTools(input),
    act.sendToTask,
    act.stopTask,
  ];
}

function createTaskTool(input: ChatActInput): CollabTool {
  const { ctx, write, bot, everyone, state } = input;
  const { refuse } = results(input.redact);
  const names = everyone.map((member) => member.name);
  return {
    name: "create_task",
    description:
      "Start a task that you coordinate, for work that needs commands or files. Call it once per request.",
    parameters: {
      type: "object",
      properties: {
        goal: {
          type: "string",
          description:
            "What the task must achieve, with any acceptance criteria.",
        },
        title: { type: "string", description: "A short title (optional)." },
        participants: {
          type: "array",
          items: { type: "string", enum: names },
          description:
            "Teammates who should help, by name. You are always included.",
        },
      },
      required: ["goal", "participants"],
      additionalProperties: false,
    },
    summarize: (args) =>
      String(args.title ?? args.goal ?? "a task").slice(0, 120),
    async execute(args) {
      const goal = typeof args.goal === "string" ? args.goal.trim() : "";
      if (!goal) return refuse("Give the task a goal.");
      const wanted = Array.isArray(args.participants)
        ? args.participants.map(String)
        : [];
      const chosen = wanted.map((name) =>
        everyone.find(
          (member) => member.name.toLowerCase() === name.trim().toLowerCase(),
        ),
      );
      const unknown = wanted.filter((_, index) => !chosen[index]);
      if (unknown.length > 0)
        return refuse(
          `No bot named ${unknown.join(", ")}. Choose from: ${names.join(", ")}.`,
        );
      for (const member of chosen) {
        if (!member) continue;
        try {
          ctx.models.resolve(member.model);
        } catch (error) {
          return refuse(`${member.name} cannot run: ${errorMessage(error)}`);
        }
      }
      return write(async (tx) => {
        // Lock the bot row, then count, so concurrent creations cannot both pass.
        await tx
          .select({ id: bots.id })
          .from(bots)
          .where(eq(bots.id, bot.id))
          .for("update");
        const [existing] = await tx
          .select()
          .from(tasks)
          .where(
            and(
              eq(tasks.createdByBotId, bot.id),
              eq(tasks.createdFromMessageId, state.triggerId),
            ),
          );
        if (existing) {
          // This reply already created its task (it ran before a hand-off or crash).
          state.linkedTaskId = existing.id;
          return {
            text: `Created task "${existing.title}" (${existing.id}). You coordinate it; it has started.`,
          };
        }
        const since = new Date(ctx.clock().getTime() - HOUR_MS);
        const [recent] = await tx
          .select({ value: count() })
          .from(tasks)
          .where(
            and(eq(tasks.createdByBotId, bot.id), gt(tasks.createdAt, since)),
          );
        if ((recent?.value ?? 0) >= ctx.config.tasksPerBotPerHour)
          return refuse(
            `You have created ${recent?.value} tasks in the last hour, the limit. Tell the user to wait or start the task themselves.`,
          );
        const { task } = await createTaskTx(tx, ctx, {
          goal,
          title:
            typeof args.title === "string"
              ? args.title.slice(0, 120)
              : undefined,
          coordinatorBotId: bot.id,
          participantBotIds: chosen.flatMap((member) =>
            member ? [member.id] : [],
          ),
          createdByBotId: bot.id,
          createdFromMessageId: state.triggerId,
        });
        state.linkedTaskId = task.id;
        return {
          text: `Created task "${task.title}" (${task.id}). You coordinate it; it has started.`,
        };
      });
    },
  };
}

function sendToTaskTool(input: ChatActInput): CollabTool {
  const { ctx, write, bot, state } = input;
  const { refuse } = results(input.redact);
  return {
    name: "send_to_task",
    description:
      "Pass the user's message on to one of your tasks; its coordinator picks it up. A waiting, completed or failed task continues, in the same workspace and with its history. A cancelled or stopping task cannot.",
    parameters: {
      type: "object",
      properties: {
        id: taskIdProperty,
        text: { type: "string", description: "What to tell the task." },
      },
      required: ["id", "text"],
      additionalProperties: false,
    },
    summarize: (args) => String(args.id ?? ""),
    async execute(args) {
      const taskId = textArg(args.id) ?? "";
      const text = typeof args.text === "string" ? args.text.trim() : "";
      if (!text) return refuse("The message is empty.");
      if (hasNul(taskId) || hasNul(text))
        return refuse("The message cannot contain a NUL character.");
      return write(async (tx) => {
        const locked = taskId ? await lockTask(tx, taskId) : undefined;
        const member = locked
          ? await membership(tx, bot.id, taskId)
          : undefined;
        if (!locked || !member) return refuse(notYours(taskId));
        const task = locked;
        const [relayed] = await tx
          .select({ id: taskMessages.id })
          .from(taskMessages)
          .where(
            and(
              eq(taskMessages.taskId, taskId),
              eq(taskMessages.relayedFromMessageId, state.triggerId),
            ),
          );
        if (relayed) {
          // Already relayed by this reply before a hand-off or crash.
          state.linkedTaskId = taskId;
          return { text: `Sent to the task "${task.title}".` };
        }
        let root: Awaited<ReturnType<typeof continueTask>>["root"];
        let continued = false;
        try {
          continued = task.status !== "queued" && task.status !== "running";
          root = (await continueTask(tx, ctx, task)).root;
        } catch (error) {
          if (error instanceof DomainError) return refuse(error.message);
          throw error;
        }
        const message = await postMessage(tx, ctx, {
          taskId,
          authorKind: "bot",
          authorBotId: bot.id,
          intent: "discussion",
          text,
          recipientBotIds: [task.coordinatorBotId],
          relayedFromMessageId: state.triggerId,
        });
        await deliver(
          tx,
          root,
          {
            kind: "steering",
            text: `Message from ${bot.name}, relayed from the user's direct chat:\n${text}`,
            sourceMessageId: message.id,
          },
          { wake: true, ctx },
        );
        state.linkedTaskId = taskId;
        return {
          text: continued
            ? `Sent to the task "${task.title}"; it was ${task.status} and continues now.`
            : `Sent to the task "${task.title}".`,
        };
      });
    },
  };
}

function stopTaskTool(input: ChatActInput): CollabTool {
  const { ctx, write, bot, state } = input;
  const { refuse } = results(input.redact);
  return {
    name: "stop_task",
    description:
      "Stop a task you coordinate, as the user's Stop button does: its work is interrupted and nothing new starts, and it cannot be continued afterwards. Only when the user asks.",
    parameters: {
      type: "object",
      properties: {
        id: taskIdProperty,
        reason: {
          type: "string",
          description: "Why, in a few words (optional).",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    summarize: (args) => String(args.id ?? ""),
    async execute(args) {
      const taskId = textArg(args.id) ?? "";
      const reason = textArg(args.reason)?.slice(0, 500) ?? null;
      if (hasNul(taskId) || (reason !== null && hasNul(reason)))
        return refuse("The arguments cannot contain a NUL character.");
      return write(async (tx) => {
        const locked = taskId ? await lockTask(tx, taskId) : undefined;
        const member = locked
          ? await membership(tx, bot.id, taskId)
          : undefined;
        if (!locked || !member) return refuse(notYours(taskId));
        if (!member.coordinator)
          return refuse(
            "Only a task's coordinator can stop it, and you only take part in this one. Tell the user they can stop it from the task.",
          );
        const was = locked;
        let task: TaskRow;
        try {
          task = await requestStopTx(tx, ctx, was, reason);
        } catch (error) {
          if (error instanceof DomainError) return refuse(error.message);
          throw error;
        }
        state.linkedTaskId = taskId;
        if (was.status === "cancelled")
          return { text: `The task "${task.title}" was already stopped.` };
        return {
          text:
            task.status === "cancelled"
              ? `Stopped the task "${task.title}".`
              : `Stopping the task "${task.title}": its running work is being interrupted.`,
        };
      });
    },
  };
}
