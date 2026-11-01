import type { Bot, ExecutionSession, TaskView } from "@jj/contracts";
import { type CSSProperties, Fragment } from "react";
import { Avatar, cx, StatusTag } from "../../components/ui";
import { type Mood, moodForStatus } from "../../lib/status";
import { sessionOrdinal } from "../../lib/tasks";
import { useWorkspace } from "../../state/WorkspaceContext";
import { ActivityText } from "./ActivityText";
import {
  botName,
  briefLine,
  flattenTree,
  formatToolCall,
  type SessionNode,
  sessionToolCalls,
  sessionTree,
} from "./taskModel";

/**
 * The step list (SPEC §5.2): the coordinator, then every session in tree
 * order on one rail. Siblings that run side by side sit under "IN PARALLEL";
 * deeper delegations indent. The picked session (or, when none is, the
 * newest running one) opens into a card with its brief, tools and latest
 * activity or result. Verification is not shown: no task has a plan in 1.0.
 */
export function ProgressSteps({
  view,
  picked,
  onPick,
}: {
  view: TaskView;
  picked: string | null;
  onPick: (sessionId: string) => void;
}) {
  const { getBot } = useWorkspace();
  const { task } = view;
  const roots = sessionTree(view);
  const nodes = flattenTree(roots);
  const groupStarts = parallelGroupStarts(roots);
  const open =
    nodes.find((node) => node.session.id === picked)?.session.id ??
    nodes.filter((node) => node.session.status === "running").at(-1)?.session
      .id ??
    null;
  const coordinator = getBot(task.coordinatorBotId);
  const coordinatorMood: Mood =
    task.status === "running" ? "working" : moodForStatus(task);

  return (
    <ol className="progress" aria-label="Steps">
      <li className="progress__step">
        <SpriteTile bot={coordinator} mood={coordinatorMood} />
        <div className="progress__text">
          <span className="progress__title progress__title--lead">
            {botName(coordinator)}
          </span>
          <span className="progress__meta">
            coordinator · goal v{task.goalVersion}
          </span>
        </div>
      </li>
      {nodes.length === 0 && (
        <li className="progress__empty">No sessions yet</li>
      )}
      {nodes.map((node) => {
        const { session } = node;
        const bot = getBot(session.botId);
        const parallel = groupStarts.has(session.id);
        return (
          <Fragment key={session.id}>
            {parallel && (
              <li
                className="progress__group"
                aria-hidden="true"
                style={indent(node)}
              >
                In parallel
              </li>
            )}
            <li className="progress__step">
              <SpriteTile bot={bot} mood={moodForStatus(session)} />
              <div className="progress__body" style={indent(node)}>
                {open === session.id ? (
                  <StepCard
                    view={view}
                    session={session}
                    bot={bot}
                    selected={picked === session.id}
                    onPick={onPick}
                  />
                ) : (
                  <button
                    type="button"
                    className="progress__item"
                    aria-pressed={picked === session.id}
                    onClick={() => onPick(session.id)}
                  >
                    <StepTitle view={view} session={session} bot={bot} />
                  </button>
                )}
              </div>
            </li>
          </Fragment>
        );
      })}
    </ol>
  );
}

/** The first child of every sibling group of two or more, roots included. */
function parallelGroupStarts(roots: readonly SessionNode[]): Set<string> {
  const starts = new Set<string>();
  const visit = (siblings: readonly SessionNode[]) => {
    const first = siblings[0];
    if (first && siblings.length >= 2) starts.add(first.session.id);
    for (const node of siblings) visit(node.children);
  };
  visit(roots);
  return starts;
}

/** Depth 1 lines up with the root, as in the design; deeper levels step in. */
const indent = (node: SessionNode) =>
  ({ "--step-indent": String(Math.max(0, node.depth - 1)) }) as CSSProperties;

function SpriteTile({ bot, mood }: { bot: Bot | undefined; mood: Mood }) {
  return (
    <span className="progress__tile">
      <Avatar
        appearance={bot?.appearance}
        name={botName(bot)}
        mood={mood}
        size={24}
        decorative
      />
    </span>
  );
}

function StepTitle({
  view,
  session,
  bot,
}: {
  view: TaskView;
  session: ExecutionSession;
  bot: Bot | undefined;
}) {
  return (
    <span className="progress__text">
      <span className="progress__title clamp1" title={session.brief}>
        {sessionOrdinal(view, session.id)} · {briefLine(session.brief, 60)}
      </span>
      <StatusTag status={session} detail={botName(bot)} />
    </span>
  );
}

/** The open step: title and status, brief, tool line and what it is doing or produced. */
function StepCard({
  view,
  session,
  bot,
  selected,
  onPick,
}: {
  view: TaskView;
  session: ExecutionSession;
  bot: Bot | undefined;
  selected: boolean;
  onPick: (sessionId: string) => void;
}) {
  const tools = sessionToolCalls(view, session.id);
  const line = session.activity
    ? { label: "Now", text: session.activity.text }
    : session.error
      ? { label: "Error", text: session.error }
      : session.result
        ? { label: "Result", text: session.result }
        : null;
  return (
    <button
      type="button"
      className={cx("progress__card", selected && "progress__card--selected")}
      aria-pressed={selected}
      onClick={() => onPick(session.id)}
    >
      <StepTitle view={view} session={session} bot={bot} />
      <span className="progress__brief clamp3">{session.brief}</span>
      {tools.calls.length > 0 && (
        <span className="progress__tools clamp2">
          {tools.partial && "… → "}
          {tools.calls.map(formatToolCall).join(" → ")}
        </span>
      )}
      {line && (
        <span className="progress__evidence clamp2">
          {line.label} · <ActivityText text={line.text} />
        </span>
      )}
    </button>
  );
}
