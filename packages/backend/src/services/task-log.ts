// The task's shared record as its bots read it: the task state, the task log
// (every task message, stored once and in order) and each session's brief and
// report. Read-only and keyed by task id, independent of any tool, so every
// bot-facing reader of a task can share it (today the task sessions' lookup
// tools); every query is scoped to that one task. Records come back as
// stored. The formatters take a redactor and redact before they clip, so no
// caller can show part of a secret a preview cut through.
// Session transcripts are never read here: they stay private to their session.
import {
  type AuthorKind,
  bots,
  type Executor,
  type MessageIntent,
  type SessionRole,
  type SessionStatus,
  sessions,
  type TaskStatus,
  taskMessages,
  taskParticipants,
  tasks,
  type WaitingFor,
} from "@jj/db";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  ilike,
  inArray,
  lt,
  type SQL,
  sql,
} from "drizzle-orm";
import { pendingApprovals } from "./approvals";

/** What a task log entry is: a user message, a brief, a report or a message. */
export const TASK_LOG_KINDS = ["user", "brief", "report", "message"] as const;
export type TaskLogKind = (typeof TASK_LOG_KINDS)[number];

export const isTaskLogKind = (value: unknown): value is TaskLogKind =>
  TASK_LOG_KINDS.includes(value as TaskLogKind);

/** Replaces the server's secrets in a text. */
export type Redact = (text: string) => string;

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
  /** The stored task message's id (`msg_…`): stable, and unique across tasks. */
  id: string;
  kind: TaskLogKind;
  /** `user`, a bot's name, `user via <bot>` for a relayed chat message, or `system`. */
  author: string;
  /** The bots it was addressed to. */
  to: string[];
  /** A broadcast: a bot's message to every other active session of the task. */
  everyone: boolean;
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
  /** An entry id: only entries before it. */
  before?: string;
  /**
   * Take the page from the newest end: the latest `limit` entries (shown
   * oldest first). Implied by `before` without `after`.
   */
  newest?: boolean;
  /** At most this many entries (default TASK_LOG_PAGE, at most MAX_TASK_LOG_PAGE). */
  limit?: number;
}

export interface TaskLogPage {
  /** Oldest first. */
  entries: TaskLogEntry[];
  /** Matching entries before this page. */
  earlier: number;
  /** Matching entries after this page. */
  later: number;
}

/** No stored id or text holds a NUL, and the databases refuse one in a query. */
export const hasNul = (text: string) => text.includes("\u0000");

/**
 * `text` on one line, cut near `max` characters (never inside a surrogate
 * pair). Every break a model may read as one, NEL (U+0085) included, which
 * `\s` does not match, becomes a space.
 */
export function clipLine(text: string, max: number): string {
  const line = text.replace(/[\s\u0085]+/g, " ").trim();
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
  sequence: taskMessages.sequence,
  kind: kindColumn.as("kind"),
  intent: taskMessages.intent,
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
  intent: MessageIntent;
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
      everyone: row.intent === "notification" && row.authorKind === "bot",
      sessionId: row.sessionId,
      text: row.text,
      createdAt: row.createdAt,
    };
  });
}

/** The sequence of a task's entry; undefined when the id is not this task's. */
async function entrySequence(exec: Executor, taskId: string, id: string) {
  if (hasNul(id)) return undefined;
  const [row] = await exec
    .select({ sequence: taskMessages.sequence })
    .from(taskMessages)
    .where(and(eq(taskMessages.taskId, taskId), eq(taskMessages.id, id)));
  return row?.sequence;
}

/**
 * A page of the task's log, oldest first, filtered by kind and text: from the
 * oldest entry, after or before a cursor, or the newest. Returns undefined
 * when the cursors name no window of this task's log: `after` or `before` is
 * not one of its entries, or `after` is not older than `before`.
 */
export async function listTaskLog(
  exec: Executor,
  taskId: string,
  filter: TaskLogFilter = {},
): Promise<TaskLogPage | undefined> {
  const cursor = async (id: string | undefined) =>
    id === undefined ? null : ((await entrySequence(exec, taskId, id)) ?? -1);
  const after = await cursor(filter.after);
  const before = await cursor(filter.before);
  if (after === -1 || before === -1) return undefined;
  // Crossed cursors would count the entries between them twice.
  if (after !== null && before !== null && after >= before) return undefined;
  const limit = Math.min(
    Math.max(Math.floor(filter.limit ?? TASK_LOG_PAGE), 1),
    MAX_TASK_LOG_PAGE,
  );
  // A text with a NUL can match nothing that is stored.
  if (filter.query !== undefined && hasNul(filter.query))
    return { entries: [], earlier: 0, later: 0 };
  // Every match, numbered: the window counts and positions are taken before
  // the cursor and the limit cut the page, so they place it in the whole.
  const matches = exec
    .select({
      ...entryColumns,
      total: sql<number>`count(*) over ()`.as("total"),
      position:
        sql<number>`row_number() over (order by ${taskMessages.sequence})`.as(
          "position",
        ),
    })
    .from(taskMessages)
    .where(
      and(
        eq(taskMessages.taskId, taskId),
        filter.kind ? sql`${kindColumn} = ${filter.kind}` : undefined,
        filter.query
          ? ilike(taskMessages.text, `%${escapeLike(filter.query)}%`)
          : undefined,
      ),
    )
    .as("matches");
  const window: (SQL | undefined)[] = [
    after === null ? undefined : gt(matches.sequence, after),
    before === null ? undefined : lt(matches.sequence, before),
  ];
  const fromEnd = filter.newest === true || (before !== null && after === null);
  const rows = await exec
    .select()
    .from(matches)
    .where(and(...window))
    .orderBy(fromEnd ? desc(matches.sequence) : asc(matches.sequence))
    .limit(limit);
  if (fromEnd) rows.reverse();
  const first = rows[0];
  const last = rows.at(-1);
  if (first && last) {
    const total = Number(last.total);
    return {
      entries: await toEntries(exec, rows),
      earlier: Number(first.position) - 1,
      later: total - Number(last.position),
    };
  }
  // An empty page: the matches sit on either side of the cursors.
  const [counts] = await exec
    .select({
      earlier: sql<number>`count(*) filter (where ${after === null ? sql`false` : sql`${matches.sequence} <= ${after}`})`,
      later: sql<number>`count(*) filter (where ${before === null ? sql`false` : sql`${matches.sequence} >= ${before}`})`,
    })
    .from(matches);
  return {
    entries: [],
    earlier: Number(counts?.earlier ?? 0),
    later: Number(counts?.later ?? 0),
  };
}

/** One entry of the task's log in full; undefined when it is not this task's. */
export async function readTaskLogEntry(
  exec: Executor,
  taskId: string,
  entryId: string,
): Promise<TaskLogEntry | undefined> {
  if (hasNul(entryId)) return undefined;
  const rows = await exec
    .select(entryColumns)
    .from(taskMessages)
    .where(and(eq(taskMessages.taskId, taskId), eq(taskMessages.id, entryId)));
  return (await toEntries(exec, rows))[0];
}

/** An entry's id, kind and author (→ recipients), as its index line starts. */
export const entryHeader = (entry: TaskLogEntry, redact: Redact) =>
  redact(
    `${entry.id} [${entry.kind}] ${entry.author}${
      entry.everyone
        ? " → everyone"
        : entry.to.length > 0
          ? ` → ${entry.to.join(", ")}`
          : ""
    }`,
  );

/**
 * An entry as one index line: id, kind, author (→ recipients) and a short
 * preview, such as `msg_… [brief] Ada → Grace: Write glossary-a.md …`.
 */
export const indexLine = (
  entry: TaskLogEntry,
  redact: Redact,
  previewChars = PREVIEW_CHARS,
) =>
  `${entryHeader(entry, redact)}: ${clipLine(redact(entry.text), previewChars)}`;

/** An entry in full: its index header, then its whole text. */
export const formatEntry = (entry: TaskLogEntry, redact: Redact) =>
  `${entryHeader(entry, redact)}\n${redact(entry.text)}`;

export interface TaskLogPageFormat {
  redact: Redact;
  /** The tool a next or previous page is read with, named in the hints. */
  tool: string;
  /** Arguments the hints repeat before the cursor, such as a task id. */
  args?: Record<string, string>;
}

/**
 * A page as text: its index lines, with a hint for the entries before and
 * after it that repeats the filters, or why the page is empty.
 */
export function formatTaskLogPage(
  page: TaskLogPage,
  filter: TaskLogFilter,
  format: TaskLogPageFormat,
): string {
  const first = page.entries[0];
  const last = page.entries.at(-1);
  if (!first || !last) {
    const filtered =
      filter.kind || filter.query || filter.after || filter.before;
    return filtered ? "No entries match." : "The task log is empty.";
  }
  const hint = (cursor: "after" | "before", id: string) => {
    const args = [
      ...Object.entries(format.args ?? {}).map(
        ([key, value]) => `${key} ${JSON.stringify(value)}`,
      ),
      `${cursor} ${JSON.stringify(id)}`,
      ...(filter.kind ? [`kind ${JSON.stringify(filter.kind)}`] : []),
      ...(filter.query ? [`query ${JSON.stringify(filter.query)}`] : []),
      ...(filter.limit !== undefined ? [`limit ${filter.limit}`] : []),
    ];
    return `call \`${format.tool}\` again with ${args.join(", ")}`;
  };
  const lines = page.entries.map((entry) => indexLine(entry, format.redact));
  if (page.earlier > 0)
    lines.unshift(
      `(${page.earlier} earlier before ${first.id}: ${hint("before", first.id)}.)`,
    );
  if (page.later > 0)
    lines.push(
      `(${page.later} more after ${last.id}: ${hint("after", last.id)}.)`,
    );
  return format.redact(lines.join("\n"));
}

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
  /** While it waits for the user's approval: the held call, on one line. */
  approval?: string;
}

export interface SessionReport extends SessionSummary {
  /** The brief as its requester wrote it; the coordinator's is the goal it started with. */
  brief: string;
  /** Its final reply: a worker's report, the coordinator's result. */
  report: string | null;
  error: string | null;
}

export interface TaskState {
  id: string;
  title: string;
  goal: string;
  goalVersion: number;
  status: TaskStatus;
  result: string | null;
  error: string | null;
  /** Oldest first, each with its brief in full (the formatter shows its first line). */
  sessions: (SessionSummary & { brief: string })[];
}

/** The task's sessions, oldest first, with bot and requester names. */
async function sessionReports(
  exec: Executor,
  taskId: string,
): Promise<(SessionReport & { botId: string })[]> {
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
  const held = new Map(
    (await pendingApprovals(exec, [taskId])).map((row) => [
      row.sessionId,
      `${row.tool}: ${row.summary}`,
    ]),
  );
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
      id: row.id,
      botId: row.botId,
      bot: name(row.botId),
      role: row.role,
      status: row.status,
      waitingFor: row.waitingFor,
      requester: parentBot ? name(parentBot) : null,
      goalVersion: row.goalVersion,
      ...(held.has(row.id) ? { approval: held.get(row.id) } : {}),
      brief: row.brief,
      report: row.result,
      error: row.error,
    };
  });
}

const withoutBotId = ({
  botId: _,
  ...report
}: SessionReport & { botId: string }): SessionReport => report;

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
    sessions: (await sessionReports(exec, taskId)).map(
      ({ report: _, error: __, botId: ___, ...session }) => session,
    ),
  };
}

/** One session of the task, with its brief and report in full; undefined when it is not this task's. */
export async function readSessionReport(
  exec: Executor,
  taskId: string,
  sessionId: string,
): Promise<SessionReport | undefined> {
  const found = (await sessionReports(exec, taskId)).find(
    (report) => report.id === sessionId,
  );
  return found ? withoutBotId(found) : undefined;
}

/**
 * The latest of a bot's sessions under one parent session that has reported,
 * by completing or failing, with its brief and report in full; undefined when
 * it has none. A cancelled session never reported, so it does not count.
 */
export async function readLatestReport(
  exec: Executor,
  taskId: string,
  under: { parentSessionId: string; botId: string },
): Promise<SessionReport | undefined> {
  const [latest] = await exec
    .select({ id: sessions.id })
    .from(sessions)
    .where(
      and(
        eq(sessions.taskId, taskId),
        eq(sessions.parentSessionId, under.parentSessionId),
        eq(sessions.botId, under.botId),
        inArray(sessions.status, ["completed", "failed"]),
      ),
    )
    .orderBy(desc(sessions.createdAt), desc(sessions.id))
    .limit(1);
  return latest ? readSessionReport(exec, taskId, latest.id) : undefined;
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
  const reports = (await sessionReports(exec, taskId))
    .filter((report) => report.botId === member.id)
    .map(withoutBotId);
  return { bot: member.name, reports };
}

const WAITING_FOR_TEXT = {
  user: "the user",
  delegations: "its delegations",
  approval: "the user's approval",
} as const;

const statusText = (session: SessionSummary) =>
  session.waitingFor
    ? `waiting for ${WAITING_FOR_TEXT[session.waitingFor]}${session.approval ? ` of ${clipLine(session.approval, 200)}` : ""}`
    : session.status;

const sessionLabel = (session: SessionSummary) =>
  `${session.bot} (${session.role}${session.requester ? `, from ${session.requester}` : ""})`;

/** The task state as text: goal, status, outcome and one line per session. */
export function formatTaskState(state: TaskState, redact: Redact): string {
  const lines = [
    `Task ${state.id} "${state.title}": ${state.status}`,
    `Goal (version ${state.goalVersion}):`,
    state.goal.trim(),
  ];
  if (state.result !== null)
    lines.push(`Result: ${clipLine(redact(state.result), 400)}`);
  if (state.error !== null)
    lines.push(`Error: ${clipLine(redact(state.error), 400)}`);
  lines.push("", "Sessions, oldest first:");
  for (const session of state.sessions)
    lines.push(
      `- ${session.id} ${sessionLabel(session)}: ${statusText(session)}${session.role === "worker" ? `. Brief: ${briefSummary(redact(session.brief))}` : ""}`,
    );
  return redact(lines.join("\n"));
}

/** A session's brief and report in full. */
export function formatSessionReport(
  report: SessionReport,
  redact: Redact,
): string {
  const outcome =
    report.report ??
    (report.error !== null
      ? `Failed: ${report.error}`
      : report.status === "cancelled"
        ? "(cancelled before it reported)"
        : `(not reported yet: ${statusText(report)})`);
  return redact(
    [
      `Session ${report.id}: ${sessionLabel(report)}, ${statusText(report)}, goal version ${report.goalVersion}`,
      report.role === "coordinator"
        ? "Brief (the task's goal when it started):"
        : "Brief:",
      report.brief.trim() || "(no brief)",
      report.role === "coordinator" ? "Result:" : "Report:",
      outcome,
    ].join("\n"),
  );
}
