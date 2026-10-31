import { statusWord } from "../../lib/status";
import { useWorkspace } from "../../state/WorkspaceContext";
import { StatusDot } from "../common/StatusDot";

export function InlineTaskCard({ taskId }: { taskId: string }) {
  const { getTask, jumpToTask } = useWorkspace();
  const task = getTask(taskId);
  if (!task) return null;

  return (
    <button
      type="button"
      className="inline-task-card"
      onClick={() => jumpToTask(task.id)}
    >
      <div className="inline-task-info">
        <div className="inline-task-label">
          <StatusDot status={task.status} />
          Task · {statusWord(task)}
        </div>
        <div className="inline-task-title">{task.title}</div>
      </div>
      <span className="row-arrow">→</span>
    </button>
  );
}
