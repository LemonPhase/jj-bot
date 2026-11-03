// Read models: the task view (the snapshot a task stream resumes from), task
// summaries and event pages. A view is read in one repeatable-read
// transaction, so its records, usage and cursor describe the same moment.
import {
  addUsage,
  emptyUsage,
  questionExcerpt,
  TASK_VIEW_EVENT_LIMIT,
  type TaskEvent,
  type TaskEventPage,
  type TaskSummary,
  type TaskView,
  type Usage,
  verificationSummary,
} from "@jj/contracts";
import {
  artifacts,
  type Executor,
  sessions,
  type TaskRow,
  taskEvents,
  taskMessages,
  taskParticipants,
  tasks,
  type UsageRow,
  usage,
} from "@jj/db";
import { and, asc, desc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import type { EngineContext } from "../context";
import { notFound } from "../errors";
import {
  toArtifact,
  toMessage,
  toSession,
  toTask,
  toTaskEvent,
} from "../records";
import { pendingApprovals, taskApprovals, toApproval } from "./approvals";
import { latestChecks, latestOutcomes } from "./verification";

const usageOf = (row: UsageRow): Usage => ({
  modelCalls: 1,
  inputTokens: row.inputTokens,
  outputTokens: row.outputTokens,
  cacheReadTokens: row.cacheReadTokens,
  cacheWriteTokens: row.cacheWriteTokens,
  costUsd: row.costUsd,
  unpricedCalls: row.priced ? 0 : 1,
});

/** Artifact columns without the content bytes. */
export const artifactColumns = {
  id: artifacts.id,
  taskId: artifacts.taskId,
  sessionId: artifacts.sessionId,
  runId: artifacts.runId,
  kind: artifacts.kind,
  path: artifacts.path,
  name: artifacts.name,
  contentType: artifacts.contentType,
  sizeBytes: artifacts.sizeBytes,
  sha256: artifacts.sha256,
  createdAt: artifacts.createdAt,
};

/** Snapshot events drop `tool.finished` output previews. */
function withoutOutput(event: TaskEvent): TaskEvent {
  if (event.type !== "tool.finished" || event.payload.output === undefined)
    return event;
  const { output: _output, ...payload } = event.payload;
  return { ...event, payload };
}

/** `GET /api/tasks/:id`. */
export async function taskView(
  ctx: EngineContext,
  taskId: string,
): Promise<TaskView> {
  return ctx.db.transaction(
    async (tx) => {
      const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId));
      if (!task) throw notFound("Task", taskId);
      const participants = await tx
        .select({ botId: taskParticipants.botId })
        .from(taskParticipants)
        .where(eq(taskParticipants.taskId, taskId));
      const sessionRows = await tx
        .select()
        .from(sessions)
        .where(eq(sessions.taskId, taskId))
        .orderBy(asc(sessions.createdAt), asc(sessions.id));
      const messageRows = await tx
        .select()
        .from(taskMessages)
        .where(eq(taskMessages.taskId, taskId))
        .orderBy(asc(taskMessages.sequence));
      const artifactRows = await tx
        .select(artifactColumns)
        .from(artifacts)
        .where(eq(artifacts.taskId, taskId))
        .orderBy(asc(artifacts.createdAt), asc(artifacts.id));
      const usageRows = await tx
        .select()
        .from(usage)
        .where(eq(usage.taskId, taskId))
        .orderBy(asc(usage.createdAt), asc(usage.id));
      const approvalRows = await taskApprovals(tx, taskId);
      const latest = await tx
        .select()
        .from(taskEvents)
        .where(eq(taskEvents.taskId, taskId))
        .orderBy(desc(taskEvents.sequence))
        .limit(TASK_VIEW_EVENT_LIMIT);
      const events = latest.reverse().map(toTaskEvent).map(withoutOutput);
      const checks = (await latestChecks(tx, [taskId])).get(taskId) ?? [];

      let total = emptyUsage();
      const bySession: Record<string, Usage> = {};
      for (const row of usageRows) {
        const added = usageOf(row);
        total = addUsage(total, added);
        if (row.sessionId)
          bySession[row.sessionId] = addUsage(
            bySession[row.sessionId] ?? emptyUsage(),
            added,
          );
      }
      const firstSequence = events[0]?.sequence ?? 1;
      return {
        task: toTask(
          task,
          participants.map((row) => row.botId),
        ),
        sessions: sessionRows.map(toSession),
        messages: messageRows.map(toMessage),
        artifacts: artifactRows.map(toArtifact),
        approvals: approvalRows.map(toApproval),
        verificationChecks: checks,
        usage: { total, bySession },
        events,
        firstSequence,
        hasEarlier: firstSequence > 1,
        cursor: task.eventSeq,
      };
    },
    { isolationLevel: "repeatable read" },
  );
}

/** `GET /api/tasks/:id/events?after=`: events with full previews. */
export async function eventPage(
  ctx: EngineContext,
  taskId: string,
  options: { after?: number; limit?: number } = {},
): Promise<TaskEventPage> {
  const after = Math.max(0, Math.floor(options.after ?? 0));
  const limit = Math.min(
    Math.max(1, Math.floor(options.limit ?? TASK_VIEW_EVENT_LIMIT)),
    TASK_VIEW_EVENT_LIMIT,
  );
  const [task] = await ctx.db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.id, taskId));
  if (!task) throw notFound("Task", taskId);
  const rows = await ctx.db
    .select()
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), gt(taskEvents.sequence, after)))
    .orderBy(asc(taskEvents.sequence))
    .limit(limit + 1);
  const page = rows.slice(0, limit);
  return {
    events: page.map(toTaskEvent),
    cursor: page.at(-1)?.sequence ?? after,
    hasMore: rows.length > limit,
  };
}

/**
 * The question of each waiting task: its coordinator's last message to the
 * user (a discussion message its root session posted with no recipients, as
 * the contract's `isCoordinatorToUser` says), redacted, then clipped.
 */
async function waitingQuestions(
  exec: Executor,
  taskIds: string[],
  redact: (text: string) => string,
): Promise<Map<string, string>> {
  if (taskIds.length === 0) return new Map();
  const rows = await exec
    .selectDistinctOn([taskMessages.taskId], {
      taskId: taskMessages.taskId,
      text: taskMessages.text,
    })
    .from(taskMessages)
    .innerJoin(tasks, eq(tasks.id, taskMessages.taskId))
    .innerJoin(
      sessions,
      and(
        eq(sessions.id, taskMessages.sessionId),
        isNull(sessions.parentSessionId),
      ),
    )
    .where(
      and(
        inArray(taskMessages.taskId, taskIds),
        eq(taskMessages.authorKind, "bot"),
        eq(taskMessages.authorBotId, tasks.coordinatorBotId),
        eq(taskMessages.intent, "discussion"),
        sql`jsonb_array_length(${taskMessages.recipientBotIds}) = 0`,
      ),
    )
    .orderBy(taskMessages.taskId, desc(taskMessages.sequence));
  const questions = new Map<string, string>();
  for (const row of rows) {
    const question = questionExcerpt(redact(row.text));
    if (question) questions.set(row.taskId, question);
  }
  return questions;
}

/**
 * Task summaries, newest first. A waiting task carries its question, with
 * the server's secrets replaced by `redact`.
 */
export async function taskSummaries(
  exec: Executor,
  options: {
    taskIds?: string[];
    redact?: (text: string) => string;
  } = {},
): Promise<TaskSummary[]> {
  const taskRows: TaskRow[] = await (options.taskIds
    ? exec.select().from(tasks).where(inArray(tasks.id, options.taskIds))
    : exec.select().from(tasks)
  ).orderBy(desc(tasks.createdAt), desc(tasks.id));
  if (taskRows.length === 0) return [];
  const ids = taskRows.map((row) => row.id);
  const participants = await exec
    .select()
    .from(taskParticipants)
    .where(inArray(taskParticipants.taskId, ids));
  const sessionRows = await exec
    .select({ taskId: sessions.taskId, status: sessions.status })
    .from(sessions)
    .where(inArray(sessions.taskId, ids));
  const usageRows = await exec
    .select()
    .from(usage)
    .where(inArray(usage.taskId, ids))
    .orderBy(asc(usage.createdAt), asc(usage.id));
  const questions = await waitingQuestions(
    exec,
    taskRows.filter((row) => row.status === "waiting").map((row) => row.id),
    options.redact ?? ((text) => text),
  );
  const pending = await pendingApprovals(exec, ids);
  const outcomes = await latestOutcomes(
    exec,
    taskRows.filter((row) => row.verificationPlan),
  );
  return taskRows.map((row) => {
    const own = sessionRows.filter((session) => session.taskId === row.id);
    const question = questions.get(row.id);
    const task = toTask(
      row,
      participants
        .filter((participant) => participant.taskId === row.id)
        .map((participant) => participant.botId),
    );
    const verification = verificationSummary(task, outcomes.get(row.id) ?? []);
    return {
      ...task,
      sessionCount: own.length,
      activeSessionCount: own.filter(
        (session) =>
          session.status === "queued" ||
          session.status === "running" ||
          session.status === "waiting",
      ).length,
      usage: usageRows
        .filter((entry) => entry.taskId === row.id)
        .map(usageOf)
        .reduce(addUsage, emptyUsage()),
      ...(question ? { question } : {}),
      pendingApprovals: pending
        .filter((approval) => approval.taskId === row.id)
        .map((approval) => {
          const { id, sessionId, botId, tool, summary, createdAt } =
            toApproval(approval);
          return { id, sessionId, botId, tool, summary, createdAt };
        }),
      ...(verification ? { verification } : {}),
    };
  });
}
