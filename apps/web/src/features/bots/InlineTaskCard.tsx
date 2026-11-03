import type { TaskSummary } from "@jj/contracts";
import { Icon, StatusSquare } from "../../components/ui";
import { statusTitle, statusTone, statusWord } from "../../lib/status";
import { useWorkspace } from "../../state/WorkspaceContext";
import { taskHref } from "../shell/router";

/** Characters of a result or error the card shows; CSS clamps it to two lines. */
const EXCERPT_CHARS = 240;

/**
 * The outcome line of a finished task, from the summary the workspace keeps
 * current: its result once completed, its error once failed. Null for a task
 * still at work, waiting or stopped.
 */
export function taskExcerpt(
  task: Pick<TaskSummary, "status" | "result" | "error">,
): { label: "Result" | "Error"; text: string } | null {
  const outcome =
    task.status === "completed"
      ? { label: "Result" as const, text: task.result }
      : task.status === "failed"
        ? { label: "Error" as const, text: task.error }
        : null;
  const text = outcome?.text?.replace(/\s+/g, " ").trim();
  if (!outcome || !text) return null;
  return {
    label: outcome.label,
    text:
      text.length > EXCERPT_CHARS
        ? `${text.slice(0, EXCERPT_CHARS - 1).trimEnd()}…`
        : text,
  };
}

/**
 * The task a bot message is about (SPEC §4 inline task card): a link to
 * `#/tasks/:id` with the task's status square, title and status word, and
 * for a finished task the start of its result or error. It reads the live
 * task summary, so it shows the task's current status, not its status when
 * the message was written. Verification is off in Contracts 1.0, so the meta
 * shows the goal version where the design shows checks.
 */
export function InlineTaskCard({ taskId }: { taskId: string }) {
  const { getTask } = useWorkspace();
  const task = getTask(taskId);
  const excerpt = task ? taskExcerpt(task) : null;
  return (
    <a className="chat-task-card" href={taskHref(taskId)}>
      <span className="visually-hidden">Task: </span>
      {task ? (
        <span className="chat-task-card__body">
          <span className="chat-task-card__head">
            <StatusSquare tone={statusTone(task)} />
            <span className="chat-task-card__title clamp1">{task.title}</span>
            <span className="chat-task-card__meta" title={statusTitle(task)}>
              {statusWord(task)} · v{task.goalVersion}
            </span>
          </span>
          {excerpt && (
            <span className="chat-task-card__excerpt clamp2">
              {excerpt.label} · {excerpt.text}
            </span>
          )}
        </span>
      ) : (
        <span className="chat-task-card__title clamp1">Open the task</span>
      )}
      <Icon name="arrow-right" size={15} className="chat-task-card__arrow" />
    </a>
  );
}
