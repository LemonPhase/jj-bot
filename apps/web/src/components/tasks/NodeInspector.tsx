import type { BotProfile, TaskView } from "../../api/types";
import { StatusDot } from "../common/StatusDot";

export function NodeInspector({
  task,
  selectedNodeId,
  getBot,
}: {
  task: TaskView;
  selectedNodeId: string | null;
  getBot: (id: string) => BotProfile | undefined;
}) {
  const session = task.sessions.find((s) => s.id === selectedNodeId);

  if (session) {
    const bot = getBot(session.botId);
    return (
      <div className="node-inspector">
        <div className="node-inspector-top">
          <div className="node-inspector-title">
            <StatusDot status={session.status} />
            <span>
              {session.label} · {bot?.name ?? "Bot"}
            </span>
          </div>
          <span className="mono-muted">{session.status}</span>
        </div>
        <div className="node-inspector-body">
          <div className="node-brief">{session.brief}</div>
          {session.tools.length > 0 && (
            <div className="node-tools">Tools: {session.tools.join(" → ")}</div>
          )}
          <div className="node-evidence">
            <strong>Evidence:</strong> {session.evidence}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="node-inspector">
      <div className="node-inspector-top">
        <div className="node-inspector-title">
          <span>Verification Criteria (v{task.goalVersion})</span>
        </div>
        <span className="muted-small">{task.checks.length} checks</span>
      </div>
      <div className="check-pill-list">
        {task.checks.map((check) => (
          <div key={check.id} className="check-item">
            <div className="check-item-head">
              <span>{check.description}</span>
              <span className={`check-outcome ${check.outcome}`}>
                {check.outcome}
              </span>
            </div>
            <div className="check-evidence">{check.evidence}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
