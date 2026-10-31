// Collaboration tools for task sessions: delegate, message and complete_task.
// The roster is in the schemas (an enum of teammate names), which is what the
// scripted test model reads. Refusals are tool errors the model can adapt to,
// never exceptions.
import { isFinishedStatus } from "@jj/contracts";
import { sessions } from "@jj/db";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { deliver, postMessage } from "../services/messages";
import {
  insertSession,
  lockTask,
  openChildren,
  getSession,
} from "../services/sessions";
import type { CollabTool, CollabToolResult } from "../ports";
import type { CompletionRequest } from "./outcomes";
import type { RosterMember } from "./prompts";
import { attributionOf, type RunContext, writeRun } from "./run-context";

export interface Teammate extends RosterMember {
  botId: string;
}

const refuse = (text: string): CollabToolResult => ({ text, isError: true });

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

function delegateTool(rc: RunContext, team: readonly Teammate[]): CollabTool {
  const { ctx } = rc.deps;
  return {
    name: "delegate",
    description: `Give a bounded piece of the task to a teammate. It runs in its own session in the shared workspace, and its result comes back to you as a message. Teammates:\n${describeTeam(team)}`,
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
            "What to do, which files it owns, and what to report back.",
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
      const brief = textArg(args.brief);
      if (!brief) return refuse("Give the teammate a brief.");
      return writeRun(rc, async (tx) => {
        const task = await lockTask(tx, rc.task.id);
        if (!task || task.cancelRequestedAt || isFinishedStatus(task.status))
          return refuse("The task is stopping; no new work can start.");
        if (rc.session.depth + 1 > ctx.config.maxDelegationDepth)
          return refuse(
            `Delegation is limited to depth ${ctx.config.maxDelegationDepth}; do this part yourself.`,
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
            text: `Assignment from ${rc.bot.name}:\n${brief}`,
            sourceMessageId: message.id,
          },
          { wake: true, ctx },
        );
        return {
          text: `Delegated to ${assignee.name} (session ${child.id}). Its result will arrive as a message; end your turn when you have nothing else to do meanwhile.`,
        };
      });
    },
  };
}

function messageTool(rc: RunContext, team: readonly Teammate[]): CollabTool {
  const { ctx } = rc.deps;
  return {
    name: "message",
    description: `Post a message to the task chat, optionally addressed to one teammate. It is delivered to that teammate's running or waiting session and never starts new work. Teammates:\n${describeTeam(team)}`,
    parameters: {
      type: "object",
      properties: {
        text: { type: "string", description: "The message." },
        to: {
          type: "string",
          enum: team.map((member) => member.name),
          description: "The teammate it is for; omit to address everyone.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
    summarize: (args) =>
      String(findTeammate(team, args.to)?.name ?? "the team"),
    async execute(args) {
      const text = textArg(args.text);
      if (!text) return refuse("The message is empty.");
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
        if (!to) return { text: "Posted to the task chat." };
        const [target] = await tx
          .select()
          .from(sessions)
          .where(
            and(
              eq(sessions.taskId, rc.task.id),
              eq(sessions.botId, to.botId),
              inArray(sessions.status, ["running", "waiting", "queued"]),
            ),
          )
          .orderBy(desc(sessions.createdAt))
          .limit(1);
        if (!target)
          return {
            text: `Posted. ${to.name} has no active session on this task, so it will see the message in the task history.`,
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
      const result = textArg(args.result);
      if (!result) return refuse("Give the result.");
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

/** The collaboration tools for one run. `delegate` is omitted when nobody can be delegated to. */
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
  if (team.length > 0) tools.push(messageTool(rc, team));
  if (rc.session.parentSessionId === null) tools.push(completeTaskTool(rc));
  return tools;
}
