// Read models: the task view (the snapshot a task stream resumes from), task
// summaries and event pages. A view is read in one repeatable-read
// transaction, so its records, usage and cursor describe the same moment.
import {
  addUsage,
  emptyUsage,
  TASK_VIEW_EVENT_LIMIT,
  type TaskEvent,
  type TaskEventPage,
  type TaskSummary,
  type TaskView,
  type Usage,
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
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import type { EngineContext } from "../context";
import { notFound } from "../errors";
import {
  toArtifact,
  toMessage,
  toSession,
  toTask,
  toTaskEvent,
} from "../records";

const usageOf = (row: UsageRow): Usage => ({
  modelCalls: 1,
  inputTokens: row.inputTokens,
  outputTokens: row.outputTokens,
  cacheReadTokens: row.cacheReadTokens,
  cacheWriteTokens: row.cacheWriteTokens,
  costUsd: row.costUsd,
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
      const latest = await tx
        .select()
        .from(taskEvents)
        .where(eq(taskEvents.taskId, taskId))
        .orderBy(desc(taskEvents.sequence))
        .limit(TASK_VIEW_EVENT_LIMIT);
      const events = latest.reverse().map(toTaskEvent).map(withoutOutput);

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

/** Task summaries, newest first. */
export async function taskSummaries(
  exec: Executor,
  filter?: { taskIds: string[] },
): Promise<TaskSummary[]> {
  const taskRows: TaskRow[] = await (filter
    ? exec.select().from(tasks).where(inArray(tasks.id, filter.taskIds))
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
  return taskRows.map((row) => {
    const own = sessionRows.filter((session) => session.taskId === row.id);
    return {
      ...toTask(
        row,
        participants
          .filter((participant) => participant.taskId === row.id)
          .map((participant) => participant.botId),
      ),
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
    };
  });
}
