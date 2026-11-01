import { Icon, StatusSquare } from "../../components/ui";
import { statusTone, statusWord } from "../../lib/status";
import { useWorkspace } from "../../state/WorkspaceContext";
import { taskHref } from "../shell/router";

/**
 * The task a bot reply created or forwarded to (SPEC §4 inline task card): a
 * link to `#/tasks/:id` with the task's status square, title and status word.
 * Verification is off in Contracts 1.0, so the meta shows the goal version
 * where the design shows checks.
 */
export function InlineTaskCard({ taskId }: { taskId: string }) {
  const { getTask } = useWorkspace();
  const task = getTask(taskId);
  return (
    <a className="chat-task-card" href={taskHref(taskId)}>
      <span className="visually-hidden">Task: </span>
      {task ? (
        <>
          <StatusSquare tone={statusTone(task)} />
          <span className="chat-task-card__title clamp1">{task.title}</span>
          <span className="chat-task-card__meta">
            {statusWord(task)} · v{task.goalVersion}
          </span>
        </>
      ) : (
        <span className="chat-task-card__title clamp1">Open the task</span>
      )}
      <Icon name="arrow-right" size={15} className="chat-task-card__arrow" />
    </a>
  );
}
