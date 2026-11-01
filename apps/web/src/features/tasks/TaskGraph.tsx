import type { Bot, TaskView } from "@jj/contracts";
import type { CSSProperties } from "react";
import { Avatar, cx, StatusTag } from "../../components/ui";
import { type Mood, moodForStatus, statusTone } from "../../lib/status";
import { sessionOrdinal } from "../../lib/tasks";
import { useWorkspace } from "../../state/WorkspaceContext";
import {
  botName,
  briefLine,
  type SessionNode,
  sessionToolCalls,
  sessionTree,
  TASK_NODE,
  toolCount,
  treeShape,
} from "./taskModel";

/** Each branch is at least this wide per leaf below it (node plus gutter), in px. */
const LEAF_PX = 152;

/** Sizes a branch by the leaves under it, so wide subtrees get room and nothing overlaps. */
const leafWidth = (leaves: number) =>
  ({
    "--leaves": String(Math.max(1, leaves)),
    "--leaf-px": `${LEAF_PX}px`,
  }) as CSSProperties;

/**
 * The execution graph (SPEC §5.3): the coordinator, its root session, then
 * every delegation as a branch of a tree built from `parentSessionId`. Any
 * depth and width: each level is a row of equal branches joined by elbows in
 * the child's status colour, and a tree wider than the panel scrolls
 * sideways. Nodes are buttons; picking one fills the inspector below.
 */
export function TaskGraph({
  view,
  selected,
  onSelect,
}: {
  view: TaskView;
  selected: string;
  onSelect: (nodeId: string) => void;
}) {
  const { getBot } = useWorkspace();
  const { task } = view;
  const roots = sessionTree(view);
  const coordinator = getBot(task.coordinatorBotId);
  const coordinatorMood: Mood =
    task.status === "running" ? "working" : moodForStatus(task);

  return (
    <div className="graph-canvas">
      <div className="graph-tree" style={leafWidth(treeShape(roots).leaves)}>
        <button
          type="button"
          className="graph-node graph-node--pill graph-node--coordinator"
          aria-pressed={selected === TASK_NODE}
          onClick={() => onSelect(TASK_NODE)}
        >
          <Avatar
            appearance={coordinator?.appearance}
            name={botName(coordinator)}
            mood={coordinatorMood}
            size={24}
            decorative
          />
          <span className="graph-node__text">
            <span className="graph-node__title graph-node__title--lead">
              {botName(coordinator)}
            </span>
            <span className="graph-node__meta">
              coordinator · goal v{task.goalVersion}
            </span>
          </span>
        </button>
        {roots.length > 0 ? (
          <GraphLevel
            view={view}
            nodes={roots}
            label="Sessions"
            root
            selected={selected}
            onSelect={onSelect}
            getBot={getBot}
          />
        ) : (
          <p className="graph-empty">No sessions yet</p>
        )}
      </div>
    </div>
  );
}

function GraphLevel({
  view,
  nodes,
  label,
  root = false,
  selected,
  onSelect,
  getBot,
}: {
  view: TaskView;
  nodes: readonly SessionNode[];
  label: string;
  root?: boolean;
  selected: string;
  onSelect: (nodeId: string) => void;
  getBot: (botId: string) => Bot | undefined;
}) {
  return (
    <ul
      className={cx("graph-level", root && "graph-level--root")}
      aria-label={label}
    >
      {nodes.map((node) => {
        const bot = getBot(node.session.botId);
        // Root links are solid and neutral; delegations take the child's colour.
        const edge = root
          ? "var(--graph-edge)"
          : `var(--status-${statusTone(node.session)})`;
        return (
          <li
            key={node.session.id}
            className="graph-branch"
            style={
              {
                ...leafWidth(treeShape([node]).leaves),
                "--edge": edge,
              } as CSSProperties
            }
          >
            <GraphNode
              view={view}
              node={node}
              bot={bot}
              selected={selected === node.session.id}
              onSelect={onSelect}
            />
            {node.children.length > 0 && (
              <GraphLevel
                view={view}
                nodes={node.children}
                label={`Delegated by ${botName(bot)}`}
                selected={selected}
                onSelect={onSelect}
                getBot={getBot}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function GraphNode({
  view,
  node,
  bot,
  selected,
  onSelect,
}: {
  view: TaskView;
  node: SessionNode;
  bot: Bot | undefined;
  selected: boolean;
  onSelect: (nodeId: string) => void;
}) {
  const { session } = node;
  const ordinal = sessionOrdinal(view, session.id);
  const sprite = (
    <Avatar
      appearance={bot?.appearance}
      name={botName(bot)}
      mood={moodForStatus(session)}
      size={24}
      decorative
    />
  );
  // Root sessions are compact pills, as in the design; delegations are cards.
  if (node.depth === 0)
    return (
      <button
        type="button"
        className="graph-node graph-node--pill"
        aria-pressed={selected}
        onClick={() => onSelect(session.id)}
      >
        {sprite}
        <span className="graph-node__text">
          <span className="graph-node__title clamp1" title={session.brief}>
            {ordinal} · {briefLine(session.brief, 48)}
          </span>
          <StatusTag size="sm" status={session} detail={botName(bot)} />
        </span>
      </button>
    );
  const outcome = session.error
    ? `Error · ${session.error}`
    : session.result
      ? `Result · ${session.result}`
      : null;
  return (
    <button
      type="button"
      className="graph-node graph-node--card"
      aria-pressed={selected}
      onClick={() => onSelect(session.id)}
    >
      <span className="graph-node__head">
        {sprite}
        <StatusTag size="sm" status={session} />
      </span>
      <span className="graph-node__title clamp2" title={session.brief}>
        {ordinal} · {briefLine(session.brief, 90)}
      </span>
      <span className="graph-node__meta clamp1">
        {botName(bot)} · {toolCount(sessionToolCalls(view, session.id))}
      </span>
      {outcome && <span className="graph-node__outcome clamp2">{outcome}</span>}
    </button>
  );
}
