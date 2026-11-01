/** UI-only data derived from a `TaskView`. */
import type { ExecutionSession, TaskSummary, TaskView } from "@jj/contracts";

const byCreation = (a: ExecutionSession, b: ExecutionSession) =>
  a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);

/** The list entry for a task, kept in step with its open view. */
export const summaryFromView = (view: TaskView): TaskSummary => ({
  ...view.task,
  activeSessionCount: view.sessions.filter(
    (s) => s.status === "queued" || s.status === "running",
  ).length,
  sessionCount: view.sessions.length,
  usage: view.usage.total,
});

/** Sessions in the order they were created. */
export const orderedSessions = (view: TaskView): ExecutionSession[] =>
  [...view.sessions].sort(byCreation);

/** "s-2": the session's position in creation order. */
export const sessionOrdinal = (view: TaskView, sessionId: string): string =>
  `s-${orderedSessions(view).findIndex((s) => s.id === sessionId) + 1}`;

const clip = (text: string, limit = 280) =>
  text.length > limit ? `${text.slice(0, limit - 1)}…` : text;

/** One line on what a session is doing or produced. */
export function sessionLine(session: ExecutionSession): string {
  if (session.activity) return session.activity.text;
  if (session.status === "completed" && session.result)
    return clip(session.result);
  if (session.status === "failed" && session.error)
    return clip(`Error: ${session.error}`);
  if (session.status === "queued") return "Queued";
  if (session.status === "cancelled") return "Stopped";
  return "No activity yet";
}
