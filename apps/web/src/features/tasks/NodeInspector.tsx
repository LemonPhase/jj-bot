import type { ExecutionSession, TaskView } from "@jj/contracts";
import type { ReactNode } from "react";
import { Card, StatusTag } from "../../components/ui";
import { useWorkspace } from "../../state/WorkspaceContext";
import { ActivityText } from "./ActivityText";
import { ArtifactRows } from "./ArtifactList";
import { usageDetail, usageLine } from "./format";
import { botName, formatToolCall, TASK_NODE, type ToolCall } from "./taskModel";
import { useOrdinals, useSessionTools } from "./useTaskModel";

/**
 * The graph's inspector (SPEC §5.3 "Selected session"): the picked session's
 * brief, activity, result or error, the tools it used (from the view's
 * events, marked partial when older events are not loaded), its usage and
 * files. The coordinator node inspects the task itself.
 */
export function NodeInspector({
  view,
  selected,
}: {
  view: TaskView;
  selected: string;
}) {
  const session =
    selected === TASK_NODE
      ? undefined
      : view.sessions.find((candidate) => candidate.id === selected);
  return session ? (
    <SessionInspector view={view} session={session} />
  ) : (
    <TaskInspector view={view} />
  );
}

function SessionInspector({
  view,
  session,
}: {
  view: TaskView;
  session: ExecutionSession;
}) {
  const { getBot } = useWorkspace();
  const bot = getBot(session.botId);
  const tools = useSessionTools(view)(session.id);
  const ordinal = useOrdinals(view).get(session.id) ?? "s-?";
  const usage = view.usage.bySession[session.id];
  const files = view.artifacts.filter((a) => a.sessionId === session.id);
  return (
    <Card as="section" aria-label="Selected session" className="inspector">
      <div className="inspector__head">
        <span className="inspector__title">
          {ordinal} · {botName(bot)}
          <span className="inspector__role"> · {session.role}</span>
        </span>
        <StatusTag status={session} />
      </div>
      <p className="inspector__brief">{session.brief}</p>
      {session.activity && (
        <Line label="Now">
          <ActivityText text={session.activity.text} />
        </Line>
      )}
      {session.result && <Line label="Result">{session.result}</Line>}
      {session.error && (
        <Line label="Error" failed>
          {session.error}
        </Line>
      )}
      <Line label="Tools">
        {tools.calls.length ? (
          <span className="inspector__tools">
            {tools.calls.map(toolText).join(" → ")}
          </span>
        ) : tools.partial ? (
          "None in the loaded events"
        ) : (
          "None yet"
        )}
        {tools.partial && (
          <span className="inspector__note">
            {" "}
            · partial: earlier events are not loaded
          </span>
        )}
      </Line>
      <Line label="Usage">
        {usage ? (
          <span title={usageDetail(usage)}>{usageLine(usage)}</span>
        ) : (
          "No model calls yet"
        )}
      </Line>
      {files.length > 0 && (
        <div className="inspector__files">
          <span className="inspector__label">Files</span>
          <ArtifactRows view={view} artifacts={files} />
        </div>
      )}
    </Card>
  );
}

function TaskInspector({ view }: { view: TaskView }) {
  const { task, usage, sessions } = view;
  return (
    <Card as="section" aria-label="Selected: the task" className="inspector">
      <div className="inspector__head">
        <span className="inspector__title">
          Goal
          <span className="inspector__role"> · v{task.goalVersion}</span>
        </span>
        <StatusTag status={task} />
      </div>
      <p className="inspector__brief">{task.goal}</p>
      {task.result && <Line label="Result">{task.result}</Line>}
      {task.error && (
        <Line label="Error" failed>
          {task.error}
        </Line>
      )}
      {task.cancelReason && <Line label="Stopped">{task.cancelReason}</Line>}
      <Line label="Sessions">
        {sessions.length === 0 ? "None yet" : String(sessions.length)}
      </Line>
      <Line label="Usage">
        <span title={usageDetail(usage.total)}>{usageLine(usage.total)}</span>
      </Line>
      {view.artifacts.length > 0 && (
        <div className="inspector__files">
          <span className="inspector__label">Files</span>
          <ArtifactRows view={view} artifacts={view.artifacts} />
        </div>
      )}
    </Card>
  );
}

/** "bash(npm test)", with "failed" or the exit code when it did not succeed. */
const toolText = (call: ToolCall) => {
  const text = formatToolCall(call);
  if (call.state === "running") return `${text} …`;
  if (call.state === "failed")
    return `${text} failed${call.exitCode !== null ? ` (exit ${call.exitCode})` : ""}`;
  return text;
};

/** "Label · text": the label in ink, the text muted; a failure's label in red. */
function Line({
  label,
  failed = false,
  children,
}: {
  label: string;
  failed?: boolean;
  children: ReactNode;
}) {
  return (
    <p className="inspector__line">
      <span
        className={
          failed
            ? "inspector__label inspector__label--failed"
            : "inspector__label"
        }
      >
        {label}
      </span>
      <span className="inspector__value">{children}</span>
    </p>
  );
}
