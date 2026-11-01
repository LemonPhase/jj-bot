// Collaboration tools for task sessions: delegate, message and complete_task.
// The roster is in the schemas (an enum of teammate names), which is what the
// scripted test model reads. Refusals are tool errors the model can adapt to,
// never exceptions.
import { isFinishedStatus } from "@jj/contracts";
import { bots, type Executor, type SessionRow, sessions } from "@jj/db";
import { and, asc, count, desc, eq, inArray, ne } from "drizzle-orm";
import type { CollabTool, CollabToolResult } from "../ports";
import { deliver, postMessage } from "../services/messages";
import {
  getSession,
  insertSession,
  lockTask,
  openChildren,
  updateSession,
} from "../services/sessions";
import {
  exp,
  handoffNote,
  previousSession,
  taskContextTools,
  taskDigest,
} from "./experiments";
import type { CompletionRequest } from "./outcomes";
import type { RosterMember } from "./prompts";
import { attributionOf, type RunContext, writeRun } from "./run-context";

export interface Teammate extends RosterMember {
  botId: string;
}

const refuse = (text: string): CollabToolResult => ({ text, isError: true });

/** Sessions that can still read their inbox. */
const ACTIVE: ("running" | "waiting" | "queued")[] = [
  "running",
  "waiting",
  "queued",
];

const describeTeam = (team: readonly Teammate[]) =>
  team
    .map((member) => `- ${member.name}${member.role ? `: ${member.role}` : ""}`)
    .join("\n");

function findTeammate(team: readonly Teammate[], value: unknown) {
  if (typeof value !== "string") return undefined;
  const wanted = value.trim().toLowerCase();
  return team.find(
    (member) =>
      member.name.toLowerCase() === wanted || member.botId === value.trim(),
  );
}

const textArg = (value: unknown) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** The first line of a brief, cut near 80 characters. */
function briefSummary(brief: string): string {
  const line = (brief.trim().split(/\r?\n/)[0] ?? "").replace(/\s+/g, " ");
  return line.length <= 80 ? line : `${line.slice(0, 79).trimEnd()}…`;
}

/**
 * A session's delegations that have not reported yet: bot, brief summary and
 * status. It goes in tool results and result deliveries, never in a tool
 * description, which must stay byte-identical for the prompt cache.
 */
export async function openDelegationsText(
  exec: Executor,
  session: SessionRow,
): Promise<string> {
  const open = await openChildren(exec, session);
  if (open.length === 0) return "Your open delegations: none.";
  const rows = await exec
    .select({ id: bots.id, name: bots.name })
    .from(bots)
    .where(inArray(bots.id, [...new Set(open.map((child) => child.botId))]));
  const names = new Map(rows.map((row) => [row.id, row.name]));
  return [
    "Your open delegations (assigned, not yet reported):",
    ...open.map(
      (child) =>
        `- ${names.get(child.botId) ?? child.botId}: ${briefSummary(child.brief)} (${child.status})`,
    ),
  ].join("\n");
}

function delegateTool(rc: RunContext, team: readonly Teammate[]): CollabTool {
  const { ctx } = rc.deps;
  return {
    name: "delegate",
    description: `Give a bounded piece of the task to a teammate. It runs in its own session in the shared workspace, and its result comes back to you as a message. Name the files the teammate owns in the brief. Never delegate work that is already assigned: while a delegation is open, wait for its result, or \`message\` that teammate. This tool's result, and each result you receive, lists your open delegations.\nTeammates:\n${describeTeam(team)}`,
    parameters: {
      type: "object",
      properties: {
        bot: {
          type: "string",
          enum: team.map((member) => member.name),
          description: "The teammate to give the work to.",
        },
        brief: {
          type: "string",
          description:
            "What to do, the files it owns (it edits only those), and what to report back.",
        },
      },
      required: ["bot", "brief"],
      additionalProperties: false,
    },
    summarize: (args) =>
      String(findTeammate(team, args.bot)?.name ?? args.bot ?? ""),
    async execute(args) {
      const assignee = findTeammate(team, args.bot);
      if (!assignee)
        return refuse(
          `${String(args.bot)} is not on this task. Delegate to one of: ${team.map((member) => member.name).join(", ")}.`,
        );
      const written = textArg(args.brief);
      if (!written) return refuse("Give the teammate a brief.");
      // A delegation after complete_task would hold the completion back and
      // then drop it silently: refuse it instead.
      if (rc.session.completionRequested)
        return refuse(
          "You already called complete_task: the task completes when this turn ends, so no new work can start. If more work is needed, delegate it before you complete.",
        );
      // The tool gets what the model wrote; what it stores (the session's
      // brief, the chat message, the assignee's inbox) is redacted.
      const brief = rc.redact(written);
      return writeRun(rc, async (tx) => {
        const task = await lockTask(tx, rc.task.id);
        if (!task || task.cancelRequestedAt || isFinishedStatus(task.status))
          return refuse("The task is stopping; no new work can start.");
        if (rc.session.depth + 1 > ctx.config.maxDelegationDepth)
          return refuse(
            `Delegation is limited to depth ${ctx.config.maxDelegationDepth}; do this part yourself.`,
          );
        const duplicate = (await openChildren(tx, rc.session)).find(
          (child) => child.botId === assignee.botId && child.brief === brief,
        );
        if (duplicate)
          return refuse(
            `${assignee.name} already has this exact brief open (session ${duplicate.id}, ${duplicate.status}). Do not delegate it again; wait for its result.`,
          );
        const [existing] = await tx
          .select({ value: count() })
          .from(sessions)
          .where(eq(sessions.taskId, task.id));
        if ((existing?.value ?? 0) >= ctx.config.maxSessionsPerTask)
          return refuse(
            `This task already has ${ctx.config.maxSessionsPerTask} sessions, the limit. Use the results you have or do the work yourself.`,
          );
        const attribution = attributionOf(rc);
        // Research prototypes (#68), off unless their flags are set.
        const mode = exp.redelegate();
        const previous = mode
          ? await previousSession(tx, rc, assignee.botId)
          : undefined;
        const digest = exp.digest() ? await taskDigest(tx, task.id) : "";
        if (previous && mode === "resume") {
          const reopened = await updateSession(
            tx,
            ctx,
            previous,
            {
              status: "queued",
              result: null,
              error: null,
              goalVersion: task.goalVersion,
            },
            attribution,
          );
          const message = await postMessage(
            tx,
            ctx,
            {
              taskId: task.id,
              authorKind: "bot",
              authorBotId: rc.bot.id,
              sessionId: rc.session.id,
              intent: "assignment",
              text: brief,
              recipientBotIds: [assignee.botId],
            },
            attribution,
          );
          await deliver(
            tx,
            reopened,
            {
              kind: "brief",
              text: `New assignment from ${rc.bot.name} (this continues your earlier session):\n${brief}${digest}`,
              sourceMessageId: message.id,
            },
            { wake: true, ctx },
          );
          return {
            text: `Delegated to ${assignee.name} (session ${reopened.id}, reopened).\n${await openDelegationsText(tx, rc.session)}\nEach result arrives as a message. Do not delegate work that is already assigned; end your turn to wait when you have nothing else to do meanwhile.`,
          };
        }
        const prefix = previous && mode === "note" ? handoffNote(previous) : "";
        const child = await insertSession(
          tx,
          ctx,
          {
            taskId: task.id,
            botId: assignee.botId,
            parentSessionId: rc.session.id,
            role: "worker",
            brief,
            goalVersion: task.goalVersion,
            depth: rc.session.depth + 1,
            status: "queued",
          },
          attribution,
        );
        const message = await postMessage(
          tx,
          ctx,
          {
            taskId: task.id,
            authorKind: "bot",
            authorBotId: rc.bot.id,
            sessionId: rc.session.id,
            intent: "assignment",
            text: brief,
            recipientBotIds: [assignee.botId],
          },
          attribution,
        );
        await deliver(
          tx,
          child,
          {
            kind: "brief",
            text: `Assignment from ${rc.bot.name}:\n${prefix}${brief}${digest}`,
            sourceMessageId: message.id,
          },
          { wake: true, ctx },
        );
        return {
          text: `Delegated to ${assignee.name} (session ${child.id}).\n${await openDelegationsText(tx, rc.session)}\nEach result arrives as a message. Do not delegate work that is already assigned; end your turn to wait when you have nothing else to do meanwhile.`,
        };
      });
    },
  };
}

function messageTool(rc: RunContext, team: readonly Teammate[]): CollabTool {
  const { ctx } = rc.deps;
  return {
    name: "message",
    description: `Post a message to the task chat. Addressed to a teammate, it is delivered to that teammate's active session; with no \`to\`, to every other active session on the task. Recipients read it at their next turn; it never starts new work. Teammates:\n${describeTeam(team)}`,
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The message." },
        to: {
          type: "string",
          enum: team.map((member) => member.name),
          description:
            "The teammate it is for; omit to send it to every other active session on the task.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
    summarize: (args) =>
      String(findTeammate(team, args.to)?.name ?? "the team"),
    async execute(args) {
      const written = textArg(args.text);
      if (!written) return refuse("The message is empty.");
      const text = rc.redact(written);
      const to =
        args.to === undefined ? undefined : findTeammate(team, args.to);
      if (args.to !== undefined && !to)
        return refuse(`${String(args.to)} is not on this task.`);
      return writeRun(rc, async (tx) => {
        await lockTask(tx, rc.task.id);
        const message = await postMessage(
          tx,
          ctx,
          {
            taskId: rc.task.id,
            authorKind: "bot",
            authorBotId: rc.bot.id,
            sessionId: rc.session.id,
            intent: "discussion",
            text,
            recipientBotIds: to ? [to.botId] : [],
          },
          attributionOf(rc),
        );
        if (!to) {
          // A broadcast reaches every other active session as a notification.
          const targets = await tx
            .select()
            .from(sessions)
            .where(
              and(
                eq(sessions.taskId, rc.task.id),
                ne(sessions.id, rc.session.id),
                inArray(sessions.status, ACTIVE),
              ),
            )
            .orderBy(asc(sessions.createdAt), asc(sessions.id));
          for (const target of targets)
            await deliver(
              tx,
              target,
              {
                kind: "message",
                text: `Message from ${rc.bot.name} to everyone:\n${text}`,
                sourceMessageId: message.id,
              },
              { wake: false, ctx },
            );
          return {
            text:
              targets.length > 0
                ? `Posted, and sent to ${targets.length} active session(s) on the task.`
                : "Posted to the task chat. No other session on the task is active, so no bot receives it.",
          };
        }
        const [target] = await tx
          .select()
          .from(sessions)
          .where(
            and(
              eq(sessions.taskId, rc.task.id),
              eq(sessions.botId, to.botId),
              inArray(sessions.status, ACTIVE),
            ),
          )
          .orderBy(desc(sessions.createdAt))
          .limit(1);
        if (!target)
          return {
            text: `Posted to the task chat, but ${to.name} has no active session on this task, so it does not receive the message. Delegate to ${to.name} if it should act on it.`,
          };
        await deliver(
          tx,
          target,
          {
            kind: "message",
            text: `Message from ${rc.bot.name}:\n${text}`,
            sourceMessageId: message.id,
          },
          { wake: false, ctx },
        );
        return { text: `Sent to ${to.name}.` };
      });
    },
  };
}

function completeTaskTool(rc: RunContext): CollabTool {
  return {
    name: "complete_task",
    description:
      "Finish the task with the consolidated result for the user. Only when the goal is met, every delegation has reported, and you have checked the work against the current goal.",
    parameters: {
      type: "object",
      properties: {
        result: {
          type: "string",
          description:
            "The final result: what was done, where the files are, anything left open.",
        },
      },
      required: ["result"],
      additionalProperties: false,
    },
    async execute(args) {
      const written = textArg(args.result);
      if (!written) return refuse("Give the result.");
      const result = rc.redact(written);
      return writeRun(rc, async (tx) => {
        const task = await lockTask(tx, rc.task.id);
        const session = await getSession(tx, rc.session.id);
        if (!task || !session) return refuse("The task no longer exists.");
        rc.task = task;
        rc.session = session;
        if (task.cancelRequestedAt || isFinishedStatus(task.status))
          return refuse("The task is stopping; it cannot be completed.");
        if (session.goalVersion < task.goalVersion)
          return refuse(
            `The goal changed to version ${task.goalVersion}:\n${task.goal}\nRe-check the work against the new goal before completing.`,
          );
        const open = await openChildren(tx, session);
        if (open.length > 0)
          return refuse(
            `${open.length} delegation(s) have not reported yet. End your turn to wait for their results, then complete.`,
          );
        const request: CompletionRequest = {
          result,
          goalVersion: task.goalVersion,
        };
        await tx
          .update(sessions)
          .set({ completionRequested: { ...request } })
          .where(eq(sessions.id, session.id));
        rc.session = { ...session, completionRequested: { ...request } };
        return {
          text: "The result is recorded; the task completes when this turn ends.",
          endRun: true,
        };
      });
    },
  };
}

/**
 * The collaboration tools for a run. Their names, descriptions and schemas
 * depend only on the session and its task's roster, so every run of a
 * session sends identical definitions (tools lead the prompt cache prefix).
 * `delegate` is omitted when nobody can be delegated to.
 */
export function sessionTools(
  rc: RunContext,
  team: readonly Teammate[],
): CollabTool[] {
  const tools: CollabTool[] = [];
  if (
    team.length > 0 &&
    rc.session.depth < rc.deps.ctx.config.maxDelegationDepth
  )
    tools.push(delegateTool(rc, team));
  if (team.length > 0 && !exp.noMessage()) tools.push(messageTool(rc, team));
  if (rc.session.parentSessionId === null) tools.push(completeTaskTool(rc));
  if (exp.taskTools()) tools.push(...taskContextTools(rc));
  return tools;
}
