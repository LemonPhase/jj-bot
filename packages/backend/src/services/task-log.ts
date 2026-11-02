// The task's shared record as its bots read it: the task state, the task log
// (every task message, stored once and in order) and each session's brief and
// report. Read-only and keyed by task id, independent of any tool, so every
// bot-facing reader of a task can share it (today the task sessions' lookup
// tools); every query is scoped to that one task. Texts come back as stored:
// a reader redacts them before formatting, since the formatters clip.
// Session transcripts are never read here: they stay private to their session.
import {
  type AuthorKind,
  bots,
  type Executor,
  type SessionRole,
  type SessionStatus,
  sessions,
  type TaskStatus,
  taskMessages,
  taskParticipants,
  tasks,
  type WaitingFor,
} from "@jj/db";
import { and, asc, eq, gt, ilike, inArray, sql } from "drizzle-orm";

/** What a task log entry is: a user message, a brief, a report or a message. */
export const TASK_LOG_KINDS = ["user", "brief", "report", "message"] as const;
export type TaskLogKind = (typeof TASK_LOG_KINDS)[number];

export const isTaskLogKind = (value: unknown): value is TaskLogKind =>
  TASK_LOG_KINDS.includes(value as TaskLogKind);

/**
 * An entry's kind, from the stored message. The user's messages are steering
 * and what a bot relayed from the user's direct chat; a brief is an
 * assignment; a report is a result (a worker's report or failure, the
 * coordinator's final result) or a system notice, which is always a failure;
 * everything else is a message. One SQL expression, so filtering and
 * labelling cannot disagree.
 */
const kindColumn = sql<TaskLogKind>`case
  when ${taskMessages.intent} = 'steering' or ${taskMessages.relayedFromMessageId} is not null then 'user'
  when ${taskMessages.intent} = 'assignment' then 'brief'
  when ${taskMessages.intent} = 'result' or ${taskMessages.authorKind} = 'system' then 'report'
  else 'message' end`;

/** Characters of an entry's text in its index line. */
export const PREVIEW_CHARS = 160;
/** Entries a task log page holds by default, and at most. */
export const TASK_LOG_PAGE = 50;
export const MAX_TASK_LOG_PAGE = 200;

export interface TaskLogEntry {
  /** The stored task message's id: stable, and unique across tasks. */
  id: string;
  kind: TaskLogKind;
  /** `user`, a bot's name, `user via <bot>` for a relayed chat message, or `system`. */
  author: string;
  /** The bots it was addressed to; empty when it went to everyone (or to the user). */
  to: string[];
  /** The session that posted it, when a session did. */
  sessionId: string | null;
  text: string;
  createdAt: Date;
}

export interface TaskLogFilter {
  kind?: TaskLogKind;
  /** Only entries whose text contains this, ignoring case. */
  query?: string;
  /** An entry id: only entries after it. */
  after?: string;
  /** At most this many entries (default TASK_LOG_PAGE, at most MAX_TASK_LOG_PAGE). */
  limit?: number;
}

export interface TaskLogPage {
  /** Oldest first. */
  entries: TaskLogEntry[];
  /** Matching entries after this page. */
  more: number;
}

/** `text` on one line, cut near `max` characters (never inside a surrogate pair). */
export function clipLine(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  return `${line
    .slice(0, max - 1)
    .replace(/[\uD800-\uDBFF]$/, "")
    .trimEnd()}…`;
}

/** The first line of a brief, cut near 80 characters. */
export const briefSummary = (brief: string): string =>
  clipLine(brief.trim().split(/\r?\n/)[0] ?? "", 80);

const escapeLike = (text: string) => text.replace(/[\\%_]/g, "\\$&");

async function botNames(
  exec: Executor,
  ids: Iterable<string | null>,
): Promise<Map<string, string>> {
  const wanted = [...new Set([...ids].filter((id): id is string => !!id))];
  if (wanted.length === 0) return new Map();
  const rows = await exec
    .select({ id: bots.id, name: bots.name })
    .from(bots)
    .where(inArray(bots.id, wanted));
  return new Map(rows.map((row) => [row.id, row.name]));
}

const entryColumns = {
  id: taskMessages.id,
  kind: kindColumn,
  authorKind: taskMessages.authorKind,
  authorBotId: taskMessages.authorBotId,
  relayedFromMessageId: taskMessages.relayedFromMessageId,
  recipientBotIds: taskMessages.recipientBotIds,
  sessionId: taskMessages.sessionId,
  text: taskMessages.text,
  createdAt: taskMessages.createdAt,
};

interface EntryRow {
  id: string;
  kind: TaskLogKind;
  authorKind: AuthorKind;
  authorBotId: string | null;
  relayedFromMessageId: string | null;
  recipientBotIds: string[];
  sessionId: string | null;
  text: string;
  createdAt: Date;
}

async function toEntries(
  exec: Executor,
  rows: EntryRow[],
): Promise<TaskLogEntry[]> {
  const names = await botNames(
    exec,
    rows.flatMap((row) => [row.authorBotId, ...row.recipientBotIds]),
  );
  const name = (id: string) => names.get(id) ?? id;
  return rows.map((row) => {
    let author: string = row.authorKind;
    if (row.authorKind === "bot") {
      const bot = name(row.authorBotId ?? "a bot");
      author = row.relayedFromMessageId ? `user via ${bot}` : bot;
    }
    return {
      id: row.id,
      kind: row.kind,
      author,
      to: row.recipientBotIds.map(name),
      sessionId: row.sessionId,
      text: row.text,
      createdAt: row.createdAt,
    };
  });
}

/**
 * A page of the task's log, oldest first, filtered by kind and text. Returns
 * undefined when `after` is not an entry of this task.
 */
export async function listTaskLog(
  exec: Executor,
  taskId: string,
  filter: TaskLogFilter = {},
): Promise<TaskLogPage | undefined> {
  let afterSequence: number | undefined;
  if (filter.after !== undefined) {
    const [row] = await exec
      .select({ sequence: taskMessages.sequence })
      .from(taskMessages)
      .where(
        and(eq(taskMessages.taskId, taskId), eq(taskMessages.id, filter.after)),
      );
    if (!row) return undefined;
    afterSequence = row.sequence;
  }
  const limit = Math.min(
    Math.max(Math.floor(filter.limit ?? TASK_LOG_PAGE), 1),
    MAX_TASK_LOG_PAGE,
  );
  const where = and(
    eq(taskMessages.taskId, taskId),
    filter.kind ? sql`${kindColumn} = ${filter.kind}` : undefined,
    filter.query
      ? ilike(taskMessages.text, `%${escapeLike(filter.query)}%`)
      : undefined,
    afterSequence === undefined
      ? undefined
      : gt(taskMessages.sequence, afterSequence),
  );
  // The window counts every match before the limit cuts the page.
  const rows = await exec
    .select({
      ...entryColumns,
      matches: sql<number>`count(*) over ()`.mapWith(Number),
    })
    .from(taskMessages)
    .where(where)
    .orderBy(asc(taskMessages.sequence))
    .limit(limit);
  return {
    entries: await toEntries(exec, rows),
    more: Math.max(0, (rows[0]?.matches ?? 0) - rows.length),
  };
}

/** One entry of the task's log in full; undefined when it is not this task's. */
export async function readTaskLogEntry(
  exec: Executor,
  taskId: string,
  entryId: string,
): Promise<TaskLogEntry | undefined> {
  const rows = await exec
    .select(entryColumns)
    .from(taskMessages)
    .where(and(eq(taskMessages.taskId, taskId), eq(taskMessages.id, entryId)));
  return (await toEntries(exec, rows))[0];
}

const header = (entry: TaskLogEntry) =>
  `${entry.id} [${entry.kind}] ${entry.author}${entry.to.length > 0 ? ` → ${entry.to.join(", ")}` : ""}`;

/**
 * An entry as one index line: id, kind, author (→ recipients) and a short
 * preview, such as `msg_… [brief] Ada → Grace: Write glossary-a.md …`.
 * Redact the entry first: the preview cuts its text.
 */
export const indexLine = (entry: TaskLogEntry, previewChars = PREVIEW_CHARS) =>
  `${header(entry)}: ${clipLine(entry.text, previewChars)}`;

/** An entry in full: its index header, then its whole text. */
export const formatEntry = (entry: TaskLogEntry) =>
  `${header(entry)}\n${entry.text}`;

export interface SessionSummary {
  id: string;
  bot: string;
  role: SessionRole;
  status: SessionStatus;
  waitingFor: WaitingFor | null;
  /** The bot whose session delegated this one; null for the coordinator. */
  requester: string | null;
  /** The goal version the session works to. */
  goalVersion: number;
}

export interface TaskState {
  id: string;
  title: string;
  goal: string;
  goalVersion: number;
  status: TaskStatus;
  result: string | null;
  error: string | null;
  /** Oldest first, each with the first line of its brief. */
  sessions: (SessionSummary & { brief: string })[];
}

export interface SessionReport extends SessionSummary {
  /** The brief as its requester wrote it; the coordinator's is the goal it started with. */
  brief: string;
  /** Its final reply: a worker's report, the coordinator's result. */
  report: string | null;
  error: string | null;
}

/** The task's sessions, oldest first, with bot and requester names. */
async function sessionRows(exec: Executor, taskId: string) {
  const rows = await exec
    .select({
      id: sessions.id,
      botId: sessions.botId,
      parentSessionId: sessions.parentSessionId,
      role: sessions.role,
      status: sessions.status,
      waitingFor: sessions.waitingFor,
      goalVersion: sessions.goalVersion,
      brief: sessions.brief,
      result: sessions.result,
      error: sessions.error,
    })
    .from(sessions)
    .where(eq(sessions.taskId, taskId))
    .orderBy(asc(sessions.createdAt), asc(sessions.id));
  const botOf = new Map(rows.map((row) => [row.id, row.botId]));
  const names = await botNames(
    exec,
    rows.map((row) => row.botId),
  );
  const name = (botId: string) => names.get(botId) ?? botId;
  return rows.map((row) => {
    const parentBot = row.parentSessionId
      ? botOf.get(row.parentSessionId)
      : undefined;
    return {
      row,
      summary: {
        id: row.id,
        bot: name(row.botId),
        role: row.role,
        status: row.status,
        waitingFor: row.waitingFor,
        requester: parentBot ? name(parentBot) : null,
        goalVersion: row.goalVersion,
      } satisfies SessionSummary,
    };
  });
}

/** The task's goal, status, outcome and sessions; undefined when there is no such task. */
export async function readTaskState(
  exec: Executor,
  taskId: string,
): Promise<TaskState | undefined> {
  const [task] = await exec.select().from(tasks).where(eq(tasks.id, taskId));
  if (!task) return undefined;
  return {
    id: task.id,
    title: task.title,
    goal: task.goal,
    goalVersion: task.goalVersion,
    status: task.status,
    result: task.result,
    error: task.error,
    sessions: (await sessionRows(exec, taskId)).map(({ row, summary }) => ({
      ...summary,
      brief: briefSummary(row.brief),
    })),
  };
}

const toReport = ({
  row,
  summary,
}: Awaited<ReturnType<typeof sessionRows>>[number]): SessionReport => ({
  ...summary,
  brief: row.brief,
  report: row.result,
  error: row.error,
});

/** One session of the task, with its brief and report in full; undefined when it is not this task's. */
export async function readSessionReport(
  exec: Executor,
  taskId: string,
  sessionId: string,
): Promise<SessionReport | undefined> {
  const found = (await sessionRows(exec, taskId)).find(
    ({ row }) => row.id === sessionId,
  );
  return found ? toReport(found) : undefined;
}

/**
 * A participant's sessions on the task, oldest first, by bot name (ignoring
 * case) or id. Undefined when no participant of the task matches.
 */
export async function readBotReports(
  exec: Executor,
  taskId: string,
  bot: string,
): Promise<{ bot: string; reports: SessionReport[] } | undefined> {
  const wanted = bot.trim().toLowerCase();
  const members = await exec
    .select({ id: bots.id, name: bots.name })
    .from(taskParticipants)
    .innerJoin(bots, eq(bots.id, taskParticipants.botId))
    .where(eq(taskParticipants.taskId, taskId));
  const member = members.find(
    (row) => row.name.toLowerCase() === wanted || row.id === bot.trim(),
  );
  if (!member) return undefined;
  const reports = (await sessionRows(exec, taskId))
    .filter(({ row }) => row.botId === member.id)
    .map(toReport);
  return { bot: member.name, reports };
}

const statusText = (session: SessionSummary) =>
  session.waitingFor
    ? `waiting for ${session.waitingFor === "user" ? "the user" : "its delegations"}`
    : session.status;

const sessionLabel = (session: SessionSummary) =>
  `${session.bot} (${session.role}${session.requester ? `, from ${session.requester}` : ""})`;

/** The task state as text: goal, status, outcome and one line per session. Redact the state first: it clips. */
export function formatTaskState(state: TaskState): string {
  const lines = [
    `Task ${state.id} "${state.title}": ${state.status}`,
    `Goal (version ${state.goalVersion}):`,
    state.goal.trim(),
  ];
  if (state.result !== null)
    lines.push(`Result: ${clipLine(state.result, 400)}`);
  if (state.error !== null) lines.push(`Error: ${clipLine(state.error, 400)}`);
  lines.push("", "Sessions, oldest first:");
  for (const session of state.sessions)
    lines.push(
      `- ${session.id} ${sessionLabel(session)}: ${statusText(session)}${session.role === "worker" ? `. Brief: ${session.brief}` : ""}`,
    );
  return lines.join("\n");
}

/** A session's brief and report in full. */
export function formatSessionReport(report: SessionReport): string {
  const outcome =
    report.report ??
    (report.error !== null
      ? `Failed: ${report.error}`
      : report.status === "cancelled"
        ? "(cancelled before it reported)"
        : `(not reported yet: ${statusText(report)})`);
  return [
    `Session ${report.id}: ${sessionLabel(report)}, ${statusText(report)}, goal version ${report.goalVersion}`,
    report.role === "coordinator"
      ? "Brief (the task's goal when it started):"
      : "Brief:",
    report.brief.trim() || "(no brief)",
    report.role === "coordinator" ? "Result:" : "Report:",
    outcome,
  ].join("\n");
}
