/**
 * UI-only data the Tasks screen derives from a `TaskView`: the session tree
 * (the execution graph), tool calls per session, the chat timeline, live
 * activity lines and mentions. Pure, so every rule here is unit tested.
 */
import {
  type Bot,
  type ExecutionSession,
  isFinishedStatus,
  type Task,
  type TaskEvent,
  type TaskMessage,
  type TaskView,
} from "@jj/contracts";
import { type Mood, moodForStatus, statusTitle } from "../../lib/status";
import { orderedSessions } from "../../lib/tasks";

// ── Session tree ────────────────────────────────────────────────────────────

export interface SessionNode {
  session: ExecutionSession;
  /** Delegations it made, in creation order. */
  children: SessionNode[];
  /** 0 for a root session (no parent in this view). */
  depth: number;
}

/**
 * The execution graph: sessions nested under the session that delegated to
 * them (`parentSessionId`), any depth and width, siblings in creation order.
 * A session whose parent is not in the view is shown as a root, so nothing is
 * ever hidden; a parent cycle (never valid) cannot loop.
 */
export function sessionTree(view: TaskView): SessionNode[] {
  const sessions = orderedSessions(view);
  const known = new Set(sessions.map((session) => session.id));
  const childrenOf = new Map<string | null, ExecutionSession[]>();
  for (const session of sessions) {
    const parent =
      session.parentSessionId &&
      session.parentSessionId !== session.id &&
      known.has(session.parentSessionId)
        ? session.parentSessionId
        : null;
    childrenOf.set(parent, [...(childrenOf.get(parent) ?? []), session]);
  }
  const placed = new Set<string>();
  const build = (session: ExecutionSession, depth: number): SessionNode => {
    placed.add(session.id);
    const children = (childrenOf.get(session.id) ?? [])
      .filter((child) => !placed.has(child.id))
      .map((child) => build(child, depth + 1));
    return { session, children, depth };
  };
  const roots = (childrenOf.get(null) ?? []).map((root) => build(root, 0));
  // Sessions only reachable through a cycle become roots too.
  for (const session of sessions)
    if (!placed.has(session.id)) roots.push(build(session, 0));
  return roots;
}

/** Every node, depth first in display order. */
export function flattenTree(roots: readonly SessionNode[]): SessionNode[] {
  return roots.flatMap((node) => [node, ...flattenTree(node.children)]);
}

/** Levels below the coordinator and the widest level, for layout decisions. */
export function treeShape(roots: readonly SessionNode[]): {
  depth: number;
  width: number;
  leaves: number;
} {
  const widths: number[] = [];
  let leaves = 0;
  for (const node of flattenTree(roots)) {
    widths[node.depth] = (widths[node.depth] ?? 0) + 1;
    if (node.children.length === 0) leaves += 1;
  }
  return { depth: widths.length, width: Math.max(0, ...widths), leaves };
}

// ── Labels ──────────────────────────────────────────────────────────────────

/** The first line of a brief, cut to `limit` characters at a word. */
export function briefLine(brief: string, limit = 72): string {
  const line =
    brief
      .trim()
      .split(/\r?\n/)
      .find((part) => part.trim())
      ?.trim() ?? "";
  if (line.length <= limit) return line;
  const cut = line.slice(0, limit - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/**
 * What the task header shows. A title the server derived from the goal (the
 * goal itself, or its first words and "…") gives way to the whole goal, as
 * in the design; a title that says something else stays, with the current
 * goal under it.
 */
export function headingFor(task: Pick<Task, "title" | "goal">): {
  heading: string;
  goal: string | null;
} {
  const title = task.title.trim();
  const goal = task.goal.trim();
  const stem = title.endsWith("…") ? title.slice(0, -1).trimEnd() : null;
  const derived = title === goal || (stem !== null && goal.startsWith(stem));
  return derived ? { heading: goal, goal: null } : { heading: title, goal };
}

/** "s-2" for every session: its position in creation order (as the office shows it). */
export function ordinalsOf(
  view: Pick<TaskView, "sessions">,
): Map<string, string> {
  return new Map(
    orderedSessions(view as TaskView).map((session, index) => [
      session.id,
      `s-${index + 1}`,
    ]),
  );
}

/** The bot's name, or a neutral stand-in for a bot that is gone. */
export const botName = (bot: Bot | undefined): string =>
  bot?.name ?? "Unknown bot";

/** "Participants: Juno (coordinator), Moss, Vesper". */
export function participantsLabel(
  task: Pick<Task, "participantBotIds" | "coordinatorBotId">,
  getBot: (botId: string) => Bot | undefined,
): string {
  const names = task.participantBotIds.map((botId) => {
    const name = botName(getBot(botId));
    return botId === task.coordinatorBotId ? `${name} (coordinator)` : name;
  });
  return `Participants: ${names.join(", ")}`;
}

/**
 * A participant's mood in this task: its latest session's. Before it has one,
 * the coordinator follows the task (working while it runs) and others rest.
 */
export function participantMood(view: TaskView, botId: string): Mood {
  const session = orderedSessions(view)
    .filter((s) => s.botId === botId)
    .at(-1);
  if (session) return moodForStatus(session);
  return botId === view.task.coordinatorBotId
    ? moodForStatus(view.task)
    : "idle";
}

// ── Tool calls ──────────────────────────────────────────────────────────────

export interface ToolCall {
  id: string;
  tool: string;
  /** The command for bash, the path for file tools, the bot name for delegate. */
  summary: string;
  state: "running" | "ok" | "failed";
  exitCode: number | null;
}

export interface SessionTools {
  calls: ToolCall[];
  /**
   * The view holds only the latest events (`hasEarlier`) and this session
   * started before them, so earlier calls are missing from `calls`.
   */
  partial: boolean;
}

/**
 * The tool calls every session made, from the view's events in one pass,
 * oldest first per session.
 */
export function toolCallsBySession(
  view: Pick<TaskView, "events" | "hasEarlier">,
  /** The previous result: unchanged entries are reused, so memoised rows can skip. */
  previous?: ReadonlyMap<string, SessionTools>,
): Map<string, SessionTools> {
  const calls = new Map<string, Map<string, ToolCall>>();
  const created = new Set<string>();
  for (const event of view.events) {
    const { sessionId } = event;
    if (sessionId === null) continue;
    if (event.type === "session.created") {
      created.add(sessionId);
      continue;
    }
    if (event.type !== "tool.started" && event.type !== "tool.finished")
      continue;
    const mine = calls.get(sessionId) ?? new Map<string, ToolCall>();
    calls.set(sessionId, mine);
    const { toolCallId, tool, summary } = event.payload;
    mine.set(
      toolCallId,
      event.type === "tool.started"
        ? { id: toolCallId, tool, summary, state: "running", exitCode: null }
        : {
            id: toolCallId,
            tool,
            summary,
            state: event.payload.ok ? "ok" : "failed",
            exitCode: event.payload.exitCode ?? null,
          },
    );
  }
  const result = new Map<string, SessionTools>();
  for (const sessionId of new Set([...calls.keys(), ...created])) {
    const next: SessionTools = {
      calls: [...(calls.get(sessionId)?.values() ?? [])],
      partial: view.hasEarlier && !created.has(sessionId),
    };
    const before = previous?.get(sessionId);
    result.set(sessionId, before && sameTools(before, next) ? before : next);
  }
  return result;
}

const sameTools = (a: SessionTools, b: SessionTools) =>
  a.partial === b.partial &&
  a.calls.length === b.calls.length &&
  a.calls.every((call, index) => {
    const other = b.calls[index];
    return (
      other !== undefined &&
      call.id === other.id &&
      call.state === other.state &&
      call.exitCode === other.exitCode &&
      call.summary === other.summary
    );
  });

/** The tool calls a session made, from the view's events, oldest first. */
export function sessionToolCalls(
  view: Pick<TaskView, "events" | "hasEarlier">,
  sessionId: string,
): SessionTools {
  return (
    toolCallsBySession(view).get(sessionId) ?? {
      calls: [],
      partial: view.hasEarlier,
    }
  );
}

/** "bash(npm test)", or the bare tool name when it has no summary. */
export const formatToolCall = (call: Pick<ToolCall, "tool" | "summary">) =>
  call.summary.trim() ? `${call.tool}(${call.summary.trim()})` : call.tool;

/** "2 tools", "1 tool", or "2+ tools" when earlier calls are not loaded. */
export function toolCount({ calls, partial }: SessionTools): string {
  const count = calls.length;
  return `${count}${partial ? "+" : ""} tool${count === 1 && !partial ? "" : "s"}`;
}

// ── Live activity ───────────────────────────────────────────────────────────

export interface ActivityLine {
  session: ExecutionSession;
  /** "Running `npm test`", "Waiting for you", "Queued"… */
  text: string;
  /** Running now: the row bobs and shows the typing dots. */
  working: boolean;
}

/**
 * One line per session still in play (queued, running or waiting), from its
 * `activity`: what each bot is doing right now. Coordinator first, then in
 * creation order. Empty once the task is finished or stopped.
 */
export function activityLines(view: TaskView): ActivityLine[] {
  if (isFinishedStatus(view.task.status)) return [];
  return orderedSessions(view)
    .filter((session) => !isFinishedStatus(session.status))
    .sort(
      (a, b) =>
        Number(b.role === "coordinator") - Number(a.role === "coordinator"),
    )
    .map((session) => {
      const working = session.status === "running";
      const text =
        session.activity?.text ??
        (working
          ? "Working…"
          : session.status === "queued"
            ? "Queued"
            : capitalise(statusTitle(session) ?? "waiting"));
      return { session, text, working };
    });
}

/**
 * What to announce when sessions change: only transitions into waiting or a
 * finished status ("Moss finished", "Juno is waiting for you"), never each
 * "Thinking…" or "Running…" line. `previous` holds the last statuses seen.
 */
export function statusAnnouncements(
  previous: ReadonlyMap<string, ExecutionSession["status"]>,
  sessions: readonly ExecutionSession[],
  nameOf: (botId: string) => string,
): string[] {
  const said: string[] = [];
  for (const session of sessions) {
    const before = previous.get(session.id);
    if (before === undefined || before === session.status) continue;
    const name = nameOf(session.botId);
    switch (session.status) {
      case "waiting":
        said.push(
          session.waitingFor === "user"
            ? `${name} is waiting for you`
            : session.waitingFor === "delegations"
              ? `${name} is waiting on delegated work`
              : `${name} is waiting`,
        );
        break;
      case "completed":
        said.push(`${name} finished`);
        break;
      case "failed":
        said.push(`${name} failed`);
        break;
      case "cancelled":
        said.push(`${name} stopped`);
        break;
    }
  }
  return said;
}

const capitalise = (text: string) =>
  text ? `${text[0]?.toUpperCase()}${text.slice(1)}` : text;

export interface TextSegment {
  text: string;
  /** Inside backticks: shown in mono (the command in "Running `npm test`"). */
  code: boolean;
}

/** Splits an activity line on backticks; an unpaired backtick stays text. */
export function codeSegments(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const pattern = /`([^`]+)`/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last)
      segments.push({ text: text.slice(last, match.index), code: false });
    segments.push({ text: match[1] ?? "", code: true });
    last = match.index + match[0].length;
  }
  if (last < text.length)
    segments.push({ text: text.slice(last), code: false });
  return segments;
}

// ── Mentions ────────────────────────────────────────────────────────────────

export interface MentionSegment {
  text: string;
  /** Set when the text is an @mention of this bot. */
  bot?: Bot;
}

const escapeRegExp = (text: string) =>
  text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A splitter of message text into plain runs and `@Name` mentions of the
 * given bots (longest names first, case-insensitive, not inside a longer
 * word). Build it once per bot list; it compiles one pattern.
 */
export function createMentionMatcher(
  bots: readonly Bot[],
): (text: string) => MentionSegment[] {
  const named = bots
    .filter((bot) => bot.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
  if (named.length === 0) return (text) => [{ text }];
  const byName = new Map(named.map((bot) => [bot.name.toLowerCase(), bot]));
  const pattern = new RegExp(
    `@(${named.map((bot) => escapeRegExp(bot.name)).join("|")})(?![\\p{L}\\p{N}_])`,
    "giu",
  );
  return (text) => {
    const segments: MentionSegment[] = [];
    let last = 0;
    for (const match of text.matchAll(pattern)) {
      const bot = byName.get((match[1] ?? "").toLowerCase());
      if (!bot) continue;
      if (match.index > last)
        segments.push({ text: text.slice(last, match.index) });
      segments.push({ text: match[0], bot });
      last = match.index + match[0].length;
    }
    if (last < text.length) segments.push({ text: text.slice(last) });
    return segments;
  };
}

/** One-off form of `createMentionMatcher`. */
export const mentionSegments = (
  text: string,
  bots: readonly Bot[],
): MentionSegment[] => createMentionMatcher(bots)(text);

// ── Chat timeline ───────────────────────────────────────────────────────────

export type TimelineEntry =
  | {
      kind: "message";
      message: TaskMessage;
      /** The goal version this message set, when it replaced the goal. */
      goalVersion: number | null;
    }
  | { kind: "notice"; id: string; text: string };

const noticeText = (event: TaskEvent): string | null => {
  switch (event.type) {
    case "task.goal_changed":
      return `Goal updated to v${event.payload.goalVersion}`;
    case "task.reopened":
      return "Task continued";
    case "cancellation.requested":
      return "Stop requested";
    case "task.finished":
      return event.payload.status === "completed"
        ? "Task done"
        : event.payload.status === "failed"
          ? "Task failed"
          : "Task stopped";
    default:
      return null;
  }
};

/**
 * The group chat: messages in order, with notices for goal changes, stop
 * requests and the finish placed where they happened. Notices come from the
 * view's retained events, so very old ones may be missing; messages never are.
 * The user message posted after a `task.goal_changed` is marked as the new goal.
 */
export function taskTimeline(view: TaskView): TimelineEntry[] {
  const postedAt = new Map<string, number>();
  const goalSetBy = new Map<string, number>();
  const notices: { sequence: number; entry: TimelineEntry }[] = [];
  // The server posts the user's message after `task.goal_changed` (and the
  // task reopening) in the same transaction, so the next user message is the
  // one that set the goal.
  let changedTo: number | null = null;
  for (const event of view.events) {
    if (event.type === "task.goal_changed")
      changedTo = event.payload.goalVersion;
    if (event.type === "message.posted") {
      postedAt.set(event.payload.message.id, event.sequence);
      if (event.payload.message.authorKind === "user" && changedTo !== null) {
        goalSetBy.set(event.payload.message.id, changedTo);
        changedTo = null;
      }
    }
    const text = noticeText(event);
    if (text)
      notices.push({
        sequence: event.sequence,
        entry: { kind: "notice", id: event.id, text },
      });
  }

  const entries: TimelineEntry[] = [];
  let next = 0;
  const messages = [...view.messages].sort((a, b) => a.sequence - b.sequence);
  for (const message of messages) {
    const at = postedAt.get(message.id);
    if (at !== undefined)
      while (next < notices.length && (notices[next]?.sequence ?? 0) < at)
        entries.push((notices[next++] as (typeof notices)[number]).entry);
    entries.push({
      kind: "message",
      message,
      goalVersion: goalSetBy.get(message.id) ?? null,
    });
  }
  for (; next < notices.length; next += 1)
    entries.push((notices[next] as (typeof notices)[number]).entry);
  return entries;
}

// ── Selection ───────────────────────────────────────────────────────────────

/** The graph's coordinator node: selecting it inspects the task itself. */
export const TASK_NODE = "task";

/**
 * What the inspector shows when nothing is picked: the newest running
 * delegated session, else the newest running one, else the root session,
 * else the task.
 */
export function defaultSelection(view: TaskView): string {
  const sessions = orderedSessions(view);
  const running = sessions.filter((s) => s.status === "running");
  const pick =
    running.filter((s) => s.parentSessionId !== null).at(-1) ??
    running.at(-1) ??
    sessions.find((s) => s.parentSessionId === null);
  return pick?.id ?? TASK_NODE;
}
