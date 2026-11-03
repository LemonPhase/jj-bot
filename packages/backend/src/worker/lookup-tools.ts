// Read-only lookup tools that every task session has: task_state, task_log,
// read_entry and read_report. They read the caller's own task through the
// task log service, format it with the service's formatters (which redact
// before they clip) and write nothing. Their definitions are constants, the
// same for every session and run (tools lead the prompt cache): ids and names
// are checked inside each tool, never listed in a schema. The runtime caps
// and spills the result like any tool output. Direct chat's task tools
// reuse the helpers below on a task the bot takes part in.
import type { Executor } from "@jj/db";
import type { Logger } from "../context";
import type { CollabTool, CollabToolResult } from "../ports";
import {
  formatEntry,
  formatSessionReport,
  formatTaskLogPage,
  formatTaskState,
  hasNul,
  isTaskLogKind,
  listTaskLog,
  MAX_TASK_LOG_PAGE,
  type Redact,
  readBotReports,
  readSessionReport,
  readTaskLogEntry,
  readTaskState,
  TASK_LOG_KINDS,
  TASK_LOG_PAGE,
  type TaskLogFilter,
} from "../services/task-log";
import type { RunContext } from "./run-context";
import { textArg } from "./tool-args";

/** The lookup tools' names, in the order a session is offered them. */
export const LOOKUP_TOOLS = [
  "task_state",
  "task_log",
  "read_entry",
  "read_report",
] as const;

function limitArg(value: unknown): number | undefined {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number)
    ? number
    : undefined;
}

const noEntry = (id: string) =>
  `No entry ${JSON.stringify(id)} in this task's log. Entry ids look like msg_… and start each \`task_log\` line.`;

/** Tool results whose text is redacted. */
export function results(redact: Redact) {
  return {
    ok: (text: string): CollabToolResult => ({ text: redact(text) }),
    refuse: (text: string): CollabToolResult => ({
      text: redact(text),
      isError: true,
    }),
  };
}

/**
 * Wraps a lookup tool: text arguments with a NUL are refused (nothing stored
 * holds one), and a failed read is a clean tool error, never the database's
 * own message.
 */
export function guardedLookup(
  redact: Redact,
  logger: Logger,
  details: Record<string, unknown>,
  run: (args: Record<string, unknown>) => Promise<CollabToolResult>,
): CollabTool["execute"] {
  const { refuse } = results(redact);
  return async (args) => {
    const field = Object.entries(args).find(
      ([, value]) => typeof value === "string" && hasNul(value),
    )?.[0];
    if (field) return refuse(`\`${field}\` cannot contain a NUL character.`);
    try {
      return await run(args);
    } catch (error) {
      logger.warn("A task lookup failed.", {
        ...details,
        error: redact(error instanceof Error ? error.message : String(error)),
      });
      return refuse("The lookup failed; try again.");
    }
  };
}

/** Schema properties of a task log page: the filters, cursors and limit. */
export function taskLogProperties(newestByDefault: boolean) {
  return {
    kind: {
      type: "string",
      enum: [...TASK_LOG_KINDS],
      description:
        "Only entries of this kind: user (the user's messages), brief (assignments), report (results and failures), message (messages between bots, and the coordinator's replies to the user).",
    },
    query: {
      type: "string",
      description: "Only entries whose text contains this, ignoring case.",
    },
    newest: {
      type: "boolean",
      description: newestByDefault
        ? "List the newest entries (the default; still shown oldest first). False lists from the oldest."
        : "List the newest entries instead of the oldest (still shown oldest first).",
    },
    after: {
      type: "string",
      description: "An entry id: list the entries after it (next page).",
    },
    before: {
      type: "string",
      description: "An entry id: list the entries before it (previous page).",
    },
    limit: {
      type: "integer",
      description: `At most this many entries (default ${TASK_LOG_PAGE}, at most ${MAX_TASK_LOG_PAGE}).`,
    },
  };
}

export interface TaskLogPageOptions {
  redact: Redact;
  /** The tool the page's hints name. */
  tool: string;
  /** Arguments the hints repeat, such as a task id. */
  args?: Record<string, string>;
  /** Without `newest`, list the newest entries unless `after` is given. */
  newestByDefault?: boolean;
  /** The refusal for a cursor that is not an entry of the log. */
  noEntry: (id: string) => string;
}

const isFalse = (value: unknown) => value === false || value === "false";

/** A page of a task's log, by the arguments of `task_log`, as a tool result. */
export async function taskLogPageResult(
  db: Executor,
  taskId: string,
  args: Record<string, unknown>,
  options: TaskLogPageOptions,
): Promise<CollabToolResult> {
  const { ok, refuse } = results(options.redact);
  const kind = textArg(args.kind);
  if (kind !== undefined && !isTaskLogKind(kind))
    return refuse(
      `Unknown kind ${kind}. Use one of: ${TASK_LOG_KINDS.join(", ")}.`,
    );
  const after = textArg(args.after);
  const filter: TaskLogFilter = {
    kind,
    // Searched as written: spaces in a query can matter.
    query:
      typeof args.query === "string" && args.query.trim()
        ? args.query
        : undefined,
    newest:
      args.newest === true ||
      args.newest === "true" ||
      (options.newestByDefault === true &&
        after === undefined &&
        !isFalse(args.newest)),
    after,
    before: textArg(args.before),
    limit: limitArg(args.limit),
  };
  const page = await listTaskLog(db, taskId, filter);
  if (!page)
    return refuse(
      filter.after && filter.before
        ? "No entries between those cursors: `after` and `before` must both be entries of this task's log, `after` the older one."
        : options.noEntry((filter.after ?? filter.before) as string),
    );
  return ok(
    formatTaskLogPage(page, filter, {
      redact: options.redact,
      tool: options.tool,
      args: options.args,
    }),
  );
}

export function lookupTools(rc: RunContext): CollabTool[] {
  const { db, logger } = rc.deps.ctx;
  const taskId = rc.task.id;
  const redact = (text: string) => rc.redact(text);
  const { ok, refuse } = results(redact);
  const guarded = (
    run: (args: Record<string, unknown>) => Promise<CollabToolResult>,
  ) => guardedLookup(redact, logger, { taskId, sessionId: rc.session.id }, run);
  return [
    {
      name: "task_state",
      description:
        "This task's current state: its goal and goal version, its status (with the result or error once there is one), and every session on it with its id, bot, role, status and the first line of its brief. Not for waiting on delegations: their results arrive as messages.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      summarize: () => "task",
      execute: guarded(async () => {
        const state = await readTaskState(db, taskId);
        return state
          ? ok(formatTaskState(state, redact))
          : refuse("No such task.");
      }),
    },
    {
      name: "task_log",
      description:
        "List or search this task's log, shown oldest first: the user's messages, briefs, reports and every teammate message, including those not addressed to you. Each line is one entry: its id (msg_…), [kind], author (→ recipients) and a short preview. Open an entry in full with `read_entry`.",
      parameters: {
        type: "object",
        properties: taskLogProperties(false),
        additionalProperties: false,
      },
      summarize: (args) =>
        [textArg(args.kind), textArg(args.query)].filter(Boolean).join(": ") ||
        "all",
      execute: guarded((args) =>
        taskLogPageResult(db, taskId, args, {
          redact,
          tool: "task_log",
          noEntry,
        }),
      ),
    },
    {
      name: "read_entry",
      description:
        "One entry of this task's log in full, by its id: the msg_… that starts its `task_log` line.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The entry's id (msg_…), as `task_log` shows it.",
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
      summarize: (args) => String(args.id ?? ""),
      execute: guarded(async (args) => {
        const id = textArg(args.id);
        if (!id) return refuse("Give the entry's id (msg_…) from `task_log`.");
        const entry = await readTaskLogEntry(db, taskId, id);
        return entry ? ok(formatEntry(entry, redact)) : refuse(noEntry(id));
      }),
    },
    {
      name: "read_report",
      description:
        "A session's brief and its report (or result) in full: by session id (sess_…), or by bot name for each of that bot's sessions on this task, oldest first. Other sessions' transcripts are private and never shown.",
      parameters: {
        type: "object",
        properties: {
          session: {
            type: "string",
            description: "A session id (sess_…), as `task_state` shows it.",
          },
          bot: {
            type: "string",
            description:
              "A bot's name, for all of its sessions on this task. Ignored when `session` is given.",
          },
        },
        additionalProperties: false,
      },
      summarize: (args) => String(textArg(args.session) ?? args.bot ?? ""),
      execute: guarded(async (args) => {
        const sessionId = textArg(args.session);
        if (sessionId) {
          const report = await readSessionReport(db, taskId, sessionId);
          return report
            ? ok(formatSessionReport(report, redact))
            : refuse(
                `No session ${JSON.stringify(sessionId)} on this task. Session ids look like sess_… and come from \`task_state\`.`,
              );
        }
        const bot = textArg(args.bot);
        if (!bot) return refuse("Give a session id or a bot's name.");
        const found = await readBotReports(db, taskId, bot);
        if (!found) return refuse(`${bot} is not on this task.`);
        if (found.reports.length === 0)
          return ok(`${found.bot} has no session on this task yet.`);
        return ok(
          found.reports
            .map((report) => formatSessionReport(report, redact))
            .join("\n\n"),
        );
      }),
    },
  ];
}
