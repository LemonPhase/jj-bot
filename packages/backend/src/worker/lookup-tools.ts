// Read-only lookup tools that every task session has: task_state, task_log,
// read_entry and read_report. They read the caller's own task through the
// task log service, format it with the service's formatters (which redact
// before they clip) and write nothing. Their definitions are constants, the
// same for every session and run (tools lead the prompt cache): ids and names
// are checked inside each tool, never listed in a schema. The runtime caps
// and spills the result like any tool output.
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
  readBotReports,
  readSessionReport,
  readTaskLogEntry,
  readTaskState,
  TASK_LOG_KINDS,
  TASK_LOG_PAGE,
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

export function lookupTools(rc: RunContext): CollabTool[] {
  const { db, logger } = rc.deps.ctx;
  const taskId = rc.task.id;
  const redact = (text: string) => rc.redact(text);
  const ok = (text: string): CollabToolResult => ({ text: redact(text) });
  const refuse = (text: string): CollabToolResult => ({
    text: redact(text),
    isError: true,
  });
  /** Text arguments with a NUL are refused: nothing stored holds one. */
  const nul = (args: Record<string, unknown>) =>
    Object.entries(args).find(
      ([, value]) => typeof value === "string" && hasNul(value),
    )?.[0];
  /** A failed read is a clean tool error, never the database's own message. */
  const guarded =
    (
      run: (args: Record<string, unknown>) => Promise<CollabToolResult>,
    ): CollabTool["execute"] =>
    async (args) => {
      const field = nul(args);
      if (field) return refuse(`\`${field}\` cannot contain a NUL character.`);
      try {
        return await run(args);
      } catch (error) {
        logger.warn("A task lookup failed.", {
          taskId,
          sessionId: rc.session.id,
          error: redact(error instanceof Error ? error.message : String(error)),
        });
        return refuse("The lookup failed; try again.");
      }
    };
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
        properties: {
          kind: {
            type: "string",
            enum: [...TASK_LOG_KINDS],
            description:
              "Only entries of this kind: user (the user's messages), brief (assignments), report (results and failures), message (messages between bots, and the coordinator's replies to the user).",
          },
          query: {
            type: "string",
            description:
              "Only entries whose text contains this, ignoring case.",
          },
          newest: {
            type: "boolean",
            description:
              "List the newest entries instead of the oldest (still shown oldest first).",
          },
          after: {
            type: "string",
            description: "An entry id: list the entries after it (next page).",
          },
          before: {
            type: "string",
            description:
              "An entry id: list the entries before it (previous page).",
          },
          limit: {
            type: "integer",
            description: `At most this many entries (default ${TASK_LOG_PAGE}, at most ${MAX_TASK_LOG_PAGE}).`,
          },
        },
        additionalProperties: false,
      },
      summarize: (args) =>
        [textArg(args.kind), textArg(args.query)].filter(Boolean).join(": ") ||
        "all",
      execute: guarded(async (args) => {
        const kind = textArg(args.kind);
        if (kind !== undefined && !isTaskLogKind(kind))
          return refuse(
            `Unknown kind ${kind}. Use one of: ${TASK_LOG_KINDS.join(", ")}.`,
          );
        const filter = {
          kind,
          // Searched as written: spaces in a query can matter.
          query:
            typeof args.query === "string" && args.query.trim()
              ? args.query
              : undefined,
          newest: args.newest === true || args.newest === "true",
          after: textArg(args.after),
          before: textArg(args.before),
          limit: limitArg(args.limit),
        };
        const page = await listTaskLog(db, taskId, filter);
        if (!page)
          return refuse(noEntry((filter.after ?? filter.before) as string));
        return ok(
          formatTaskLogPage(page, filter, { redact, tool: "task_log" }),
        );
      }),
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
