// RESEARCH PROTOTYPES for issue #68, on branch research/context-management
// only. Never merge to main. Each behaviour is off unless its environment flag
// is set, so the default engine behaves exactly as on main.
//
//   JJ_EXP_TASK_TOOLS=1        read-only task_log, read_entry, read_report tools (E1 pull)
//   JJ_EXP_DIGEST=1            the engine appends a task digest to each brief (E1 push)
//   JJ_EXP_REDELEGATE=note     re-delegation to a bot with a finished session carries its previous brief and report (E2 C2)
//   JJ_EXP_REDELEGATE=resume   re-delegation reopens that bot's finished session (E2 C1)
//   JJ_EXP_NO_MESSAGE=1        no `message` tool (E3 notes and hub variants)
import { bots, type Executor, type SessionRow, sessions, taskMessages } from "@jj/db";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { CollabTool, CollabToolResult } from "../ports";
import type { RunContext } from "./run-context";

export const exp = {
  taskTools: () => process.env.JJ_EXP_TASK_TOOLS === "1",
  digest: () => process.env.JJ_EXP_DIGEST === "1",
  redelegate: () => process.env.JJ_EXP_REDELEGATE as "note" | "resume" | undefined,
  noMessage: () => process.env.JJ_EXP_NO_MESSAGE === "1",
};

const clip = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`;

async function names(exec: Executor) {
  const rows = await exec.select({ id: bots.id, name: bots.name }).from(bots);
  return new Map(rows.map((row) => [row.id, row.name]));
}

async function authorOf(
  row: { authorKind: string; authorBotId: string | null },
  map: Map<string, string>,
) {
  if (row.authorKind === "user") return "user";
  if (row.authorKind === "system") return "system";
  return map.get(row.authorBotId ?? "") ?? "bot";
}

/** E1 push: the user's messages and the results so far, clipped. */
export async function taskDigest(exec: Executor, taskId: string) {
  const rows = await exec
    .select()
    .from(taskMessages)
    .where(
      and(
        eq(taskMessages.taskId, taskId),
        inArray(taskMessages.intent, ["steering", "result"]),
      ),
    )
    .orderBy(asc(taskMessages.sequence));
  if (rows.length === 0) return "";
  const map = await names(exec);
  const lines: string[] = [];
  for (const row of rows)
    lines.push(
      `- ${row.intent === "steering" ? "User" : `Result from ${await authorOf(row, map)}`}: ${clip(row.text.replace(/\s+/g, " "), 600)}`,
    );
  return `\n\nTask context so far (added by the engine):\n${lines.join("\n")}`;
}

/** E2: the assignee's latest finished session under this parent, if any. */
export async function previousSession(
  exec: Executor,
  rc: RunContext,
  botId: string,
): Promise<SessionRow | undefined> {
  const [row] = await exec
    .select()
    .from(sessions)
    .where(
      and(
        eq(sessions.taskId, rc.task.id),
        eq(sessions.botId, botId),
        eq(sessions.parentSessionId, rc.session.id),
        inArray(sessions.status, ["completed", "failed"]),
      ),
    )
    .orderBy(desc(sessions.createdAt))
    .limit(1);
  return row;
}

export const handoffNote = (previous: SessionRow) =>
  `Your earlier work on this task (session ${previous.id}):\nYour brief then: ${clip(previous.brief, 1500)}\nYour report then: ${clip(previous.result ?? previous.error ?? "(none)", 2000)}\n\nNew assignment:\n`;

const KINDS = ["steering", "assignment", "result", "discussion"] as const;

/** E1 pull: read-only tools over the task's messages and sessions. */
export function taskContextTools(rc: RunContext): CollabTool[] {
  const db = rc.deps.ctx.db;
  const taskId = rc.task.id;
  const ok = (text: string): CollabToolResult => ({ text });
  return [
    {
      name: "task_log",
      description:
        "List or search this task's history: the user's messages (steering), briefs (assignment), results and discussion, oldest first. Each entry shows its number; read one in full with read_entry.",
      parameters: {
        type: "object",
        properties: {
          kind: {
            type: "string",
            enum: [...KINDS],
            description: "Only entries of this kind.",
          },
          query: {
            type: "string",
            description: "Only entries containing this text.",
          },
        },
        additionalProperties: false,
      },
      summarize: (args) => String(args.kind ?? args.query ?? "all"),
      async execute(args) {
        const rows = await db
          .select()
          .from(taskMessages)
          .where(eq(taskMessages.taskId, taskId))
          .orderBy(asc(taskMessages.sequence));
        const map = await names(db);
        const kind = typeof args.kind === "string" ? args.kind : undefined;
        const query =
          typeof args.query === "string" ? args.query.toLowerCase() : undefined;
        const lines: string[] = [];
        for (const row of rows) {
          if (kind && row.intent !== kind) continue;
          if (query && !row.text.toLowerCase().includes(query)) continue;
          lines.push(
            `#${row.sequence} [${row.intent}] ${await authorOf(row, map)}: ${clip(row.text.replace(/\s+/g, " "), 240)}`,
          );
        }
        return ok(
          lines.length === 0 ? "No entries." : lines.slice(-30).join("\n"),
        );
      },
    },
    {
      name: "read_entry",
      description: "The full text of one task_log entry, by its number.",
      parameters: {
        type: "object",
        properties: { number: { type: "integer" } },
        required: ["number"],
        additionalProperties: false,
      },
      summarize: (args) => `#${String(args.number)}`,
      async execute(args) {
        const [row] = await db
          .select()
          .from(taskMessages)
          .where(
            and(
              eq(taskMessages.taskId, taskId),
              eq(taskMessages.sequence, Number(args.number)),
            ),
          );
        if (!row) return { text: "No such entry.", isError: true };
        const map = await names(db);
        return ok(
          `#${row.sequence} [${row.intent}] ${await authorOf(row, map)}:\n${row.text}`,
        );
      },
    },
    {
      name: "read_report",
      description:
        "A teammate's work on this task: each of its sessions' brief, status and final report.",
      parameters: {
        type: "object",
        properties: {
          bot: { type: "string", description: "The teammate's name." },
        },
        required: ["bot"],
        additionalProperties: false,
      },
      summarize: (args) => String(args.bot ?? ""),
      async execute(args) {
        const wanted = String(args.bot ?? "").trim().toLowerCase();
        const [bot] = (await db.select().from(bots)).filter(
          (row) => row.name.toLowerCase() === wanted,
        );
        if (!bot) return { text: `No bot named ${String(args.bot)}.`, isError: true };
        const rows = await db
          .select()
          .from(sessions)
          .where(and(eq(sessions.taskId, taskId), eq(sessions.botId, bot.id)))
          .orderBy(asc(sessions.createdAt));
        if (rows.length === 0) return ok(`${bot.name} has no session on this task.`);
        return ok(
          rows
            .map(
              (row) =>
                `Session ${row.id} (${row.status})\nBrief: ${clip(row.brief || "(the task goal)", 1500)}\nReport: ${clip(row.result ?? row.error ?? "(not reported yet)", 3000)}`,
            )
            .join("\n\n"),
        );
      },
    },
  ];
}
