// Read-only lookup tools that every task session has: task_state, task_log,
// read_entry and read_report. They read the caller's own task through the
// task log service and write nothing. Their definitions are constants, the
// same for every session and run (tools lead the prompt cache): ids and names
// are checked inside each tool, never listed in a schema. What they return is
// redacted here, and capped and spilled like any tool output by the runtime.
import type { CollabTool, CollabToolResult } from "../ports";
import {
  formatEntry,
  formatSessionReport,
  formatTaskState,
  indexLine,
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

/** The lookup tools' names, in the order a session is offered them. */
export const LOOKUP_TOOLS = [
  "task_state",
  "task_log",
  "read_entry",
  "read_report",
] as const;

const textArg = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

function limitArg(value: unknown): number | undefined {
  const number = typeof value === "string" ? Number(value) : value;
  return typeof number === "number" && Number.isFinite(number)
    ? number
    : undefined;
}

const noEntry = (id: string) =>
  `No entry ${id} in this task's log. Entry ids come from \`task_log\`.`;

export function lookupTools(rc: RunContext): CollabTool[] {
  const db = rc.deps.ctx.db;
  const taskId = rc.task.id;
  const ok = (text: string): CollabToolResult => ({ text: rc.redact(text) });
  const refuse = (text: string): CollabToolResult => ({
    text: rc.redact(text),
    isError: true,
  });
  return [
    {
      name: "task_state",
      description:
        "This task's current state: its goal and goal version, its status (with the result or error once there is one), and every session on it with its id, bot, role, status and the first line of its brief.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      summarize: () => "task",
      async execute() {
        const state = await readTaskState(db, taskId);
        return state ? ok(formatTaskState(state)) : refuse("No such task.");
      },
    },
    {
      name: "task_log",
      description: `List or search this task's log, oldest first: the user's messages, briefs, reports and every teammate message, including those not addressed to you. Each line is one entry: its id, [kind], author (→ recipients) and a short preview. Open an entry in full with \`read_entry\`.`,
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
          after: {
            type: "string",
            description:
              "An entry id: list the entries after it, for the next page.",
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
      async execute(args) {
        const kind = textArg(args.kind);
        if (kind !== undefined && !isTaskLogKind(kind))
          return refuse(
            `Unknown kind ${kind}. Use one of: ${TASK_LOG_KINDS.join(", ")}.`,
          );
        const query = textArg(args.query);
        const after = textArg(args.after);
        const page = await listTaskLog(db, taskId, {
          kind,
          query,
          after,
          limit: limitArg(args.limit),
        });
        if (!page) return refuse(noEntry(after ?? ""));
        if (page.entries.length === 0)
          return ok(
            kind || query || after
              ? "No entries match."
              : "The task log is empty.",
          );
        const lines = page.entries.map((entry) => indexLine(entry));
        const last = page.entries.at(-1)?.id;
        if (page.more > 0)
          lines.push(
            `(${page.more} more after ${last}: call \`task_log\` again with after "${last}".)`,
          );
        return ok(lines.join("\n"));
      },
    },
    {
      name: "read_entry",
      description:
        "One entry of this task's log in full, by its id from `task_log`.",
      parameters: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "The entry's id, as `task_log` shows it.",
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
      summarize: (args) => String(args.id ?? ""),
      async execute(args) {
        const id = textArg(args.id);
        if (!id) return refuse("Give the entry's id.");
        const entry = await readTaskLogEntry(db, taskId, id);
        return entry ? ok(formatEntry(entry)) : refuse(noEntry(id));
      },
    },
    {
      name: "read_report",
      description:
        "A session's brief and its report (or result) in full: by session id, or by bot name for each of that bot's sessions on this task, oldest first. Other sessions' transcripts are private and never shown.",
      parameters: {
        type: "object",
        properties: {
          session: {
            type: "string",
            description: "A session id, as `task_state` shows it.",
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
      async execute(args) {
        const sessionId = textArg(args.session);
        if (sessionId) {
          const report = await readSessionReport(db, taskId, sessionId);
          return report
            ? ok(formatSessionReport(report))
            : refuse(
                `No session ${sessionId} on this task. Session ids come from \`task_state\`.`,
              );
        }
        const bot = textArg(args.bot);
        if (!bot) return refuse("Give a session id or a bot's name.");
        const found = await readBotReports(db, taskId, bot);
        if (!found) return refuse(`${bot} is not on this task.`);
        if (found.reports.length === 0)
          return ok(`${found.bot} has no session on this task yet.`);
        return ok(found.reports.map(formatSessionReport).join("\n\n"));
      },
    },
  ];
}
