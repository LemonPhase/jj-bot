import type { Bot, TaskView } from "@jj/contracts";
import { statusWord, taskStatusWord, waitingTooltip } from "../../lib/status";
import { sessionLine, sessionOrdinal, sessionTools } from "../../lib/tasks";
import { StatusDot } from "../common/StatusDot";

export function NodeInspector({
  view,
  selectedNodeId,
  getBot,
}: {
  view: TaskView;
  selectedNodeId: string | null;
  getBot: (id: string) => Bot | undefined;
}) {
  const session = view.sessions.find((s) => s.id === selectedNodeId);

  if (session) {
    const bot = getBot(session.botId);
    const tools = sessionTools(view, session.id);
    return (
      <div className="node-inspector">
        <div className="node-inspector-top">
          <div className="node-inspector-title">
            <StatusDot status={session.status} />
            <span>
              {sessionOrdinal(view, session.id)} · {bot?.name ?? "Bot"}
            </span>
          </div>
          <span className="mono-muted" title={waitingTooltip(session)}>
            {statusWord(session.status)}
          </span>
        </div>
        <div className="node-inspector-body">
          <div className="node-brief">{session.brief}</div>
          {tools.length > 0 && (
            <div className="node-tools">Tools: {tools.join(" → ")}</div>
          )}
          <div className="node-evidence">
            <strong>{session.result ? "Result:" : "Now:"}</strong>{" "}
            {session.result ?? sessionLine(session)}
          </div>
        </div>
      </div>
    );
  }

  const { task } = view;
  return (
    <div className="node-inspector">
      <div className="node-inspector-top">
        <div className="node-inspector-title">
          <StatusDot status={task.status} />
          <span>Goal (v{task.goalVersion})</span>
        </div>
        <span className="mono-muted">{taskStatusWord(task)}</span>
      </div>
      <div className="node-inspector-body">
        <div className="node-brief">{task.goal}</div>
        {task.result && (
          <div className="node-evidence">
            <strong>Result:</strong> {task.result}
          </div>
        )}
        {task.error && (
          <div className="node-evidence">
            <strong>Error:</strong> {task.error}
          </div>
        )}
      </div>
    </div>
  );
}
