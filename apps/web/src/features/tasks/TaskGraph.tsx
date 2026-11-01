import type { Bot, ExecutionSession, TaskView } from "@jj/contracts";
import {
  type CSSProperties,
  memo,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import { Avatar, cx, StatusTag } from "../../components/ui";
import { type Mood, moodForStatus, statusTone } from "../../lib/status";
import { useWorkspace } from "../../state/WorkspaceContext";
import {
  botName,
  briefLine,
  type GraphSlot,
  graphLayout,
  type SessionNode,
  type SessionTools,
  TASK_NODE,
  toolCount,
} from "./taskModel";
import { useOrdinals, useSessionTools, useSessionTree } from "./useTaskModel";

/**
 * The execution graph (SPEC §5.3): the coordinator, its root session, then
 * every delegation as a branch of a tree built from `parentSessionId`. Any
 * depth and width: `graphLayout` gives each branch a column sized by the
 * leaves under it, and each level is a row of those columns joined by elbows
 * in the child's status colour. The tree is centred when it fits the panel
 * and scrolls both ways inside it when not; the view opens on the
 * coordinator and keeps it in place as the tree grows. Nodes are buttons;
 * picking one fills the inspector below.
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
  const roots = useSessionTree(view);
  const layout = useMemo(() => graphLayout(roots), [roots]);
  const ordinals = useOrdinals(view);
  const toolsOf = useSessionTools(view);
  const coordinator = getBot(task.coordinatorBotId);
  const coordinatorMood: Mood =
    task.status === "running" ? "working" : moodForStatus(task);

  const canvasRef = useRef<HTMLDivElement>(null);
  const coordinatorRef = useRef<HTMLButtonElement>(null);
  const anchor = useRef<{ taskId: string; rootX: number } | null>(null);
  // Opens with the coordinator centred in view; when the tree's width
  // changes, the coordinator stays where it was on screen.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const root = coordinatorRef.current;
    if (!canvas || !root) return;
    const rootX = root.offsetLeft + root.offsetWidth / 2;
    const previous = anchor.current;
    const onScreen =
      previous?.taskId === task.id
        ? previous.rootX - canvas.scrollLeft
        : canvas.clientWidth / 2;
    canvas.scrollLeft = Math.max(0, rootX - onScreen);
    anchor.current = { taskId: task.id, rootX };
  }, [task.id, layout.width]);

  return (
    <div className="graph-canvas" ref={canvasRef}>
      <div
        className="graph-tree"
        style={{ "--tree-px": `${layout.width}px` } as CSSProperties}
      >
        <button
          ref={coordinatorRef}
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
            nodes={roots}
            label="Sessions"
            root
            slots={layout.slots}
            selected={selected}
            onSelect={onSelect}
            getBot={getBot}
            ordinals={ordinals}
            toolsOf={toolsOf}
          />
        ) : (
          <p className="graph-empty">No sessions yet</p>
        )}
      </div>
    </div>
  );
}

function GraphLevel({
  nodes,
  label,
  root = false,
  slots,
  selected,
  onSelect,
  getBot,
  ordinals,
  toolsOf,
}: {
  nodes: readonly SessionNode[];
  label: string;
  root?: boolean;
  slots: ReadonlyMap<string, GraphSlot>;
  selected: string;
  onSelect: (nodeId: string) => void;
  getBot: (botId: string) => Bot | undefined;
  ordinals: ReadonlyMap<string, string>;
  toolsOf: (sessionId: string) => SessionTools;
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
                "--slot-px": `${slots.get(node.session.id)?.width ?? 0}px`,
                "--edge": edge,
              } as CSSProperties
            }
          >
            <GraphNode
              session={node.session}
              depth={node.depth}
              bot={bot}
              ordinal={ordinals.get(node.session.id) ?? "s-?"}
              tools={toolsOf(node.session.id)}
              selected={selected === node.session.id}
              onSelect={onSelect}
            />
            {node.children.length > 0 && (
              <GraphLevel
                nodes={node.children}
                label={`Delegated by ${botName(bot)}`}
                slots={slots}
                selected={selected}
                onSelect={onSelect}
                getBot={getBot}
                ordinals={ordinals}
                toolsOf={toolsOf}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** A session node; memoised, so an event re-renders only the nodes it changed. */
const GraphNode = memo(function GraphNode({
  session,
  depth,
  bot,
  ordinal,
  tools,
  selected,
  onSelect,
}: {
  session: ExecutionSession;
  depth: number;
  bot: Bot | undefined;
  ordinal: string;
  tools: SessionTools;
  selected: boolean;
  onSelect: (nodeId: string) => void;
}) {
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
  if (depth === 0)
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
        {botName(bot)} · {toolCount(tools)}
      </span>
      {outcome && <span className="graph-node__outcome clamp2">{outcome}</span>}
    </button>
  );
});
