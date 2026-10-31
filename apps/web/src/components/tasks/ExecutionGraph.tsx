import type { Bot, ExecutionSession, TaskView } from "@jj/contracts";
import { colourHex } from "../../lib/appearance";
import { statusWord } from "../../lib/status";
import { orderedSessions, sessionOrdinal } from "../../lib/tasks";

const NODE_W = 128;
const NODE_H = 54;
const WIDTH = 460;
const CENTER_X = WIDTH / 2;
const TOP_Y = 56;
const LAYER_H = 120;
const NEUTRAL = "#8C8C85";

interface GraphNode {
  id: string;
  x: number;
  y: number;
  title: string;
  subtitle: string;
  status: string;
  color: string;
}

interface GraphEdge {
  key: string;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  variant: "" | "active";
}

const statusColor = (status: string) =>
  status === "completed"
    ? "#10B981"
    : status === "running"
      ? "#2563EB"
      : status === "waiting"
        ? "#D97706"
        : status === "failed"
          ? "#E11D48"
          : NEUTRAL;

/**
 * Pure layout of the session tree: one layer per delegation depth, children
 * ordered under their parents. Before any session exists, the coordinator is
 * shown as a single queued node.
 */
export function layoutTaskGraph(
  view: TaskView,
  getBot: (id: string) => Bot | undefined,
) {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const sessions = orderedSessions(view);
  const known = new Set(sessions.map((s) => s.id));
  const children = new Map<string | null, ExecutionSession[]>();
  for (const session of sessions) {
    const parent =
      session.parentSessionId && known.has(session.parentSessionId)
        ? session.parentSessionId
        : null;
    children.set(parent, [...(children.get(parent) ?? []), session]);
  }

  const layers: ExecutionSession[][] = [];
  const visit = (session: ExecutionSession, depth: number) => {
    (layers[depth] ??= []).push(session);
    for (const child of children.get(session.id) ?? []) visit(child, depth + 1);
  };
  for (const root of children.get(null) ?? []) visit(root, 0);

  if (layers.length === 0) {
    const coordinator = getBot(view.task.coordinatorBotId);
    nodes.push({
      id: `coord-${view.task.coordinatorBotId}`,
      x: CENTER_X,
      y: TOP_Y,
      title: coordinator?.name ?? "Coordinator",
      subtitle: `coordinator · ${statusWord(view.task.status)}`,
      status: view.task.status,
      color: coordinator ? colourHex(coordinator.appearance.colour) : NEUTRAL,
    });
  }

  const position = new Map<string, { x: number; y: number }>();
  layers.forEach((layer, depth) => {
    const spacing = Math.min(142, 390 / layer.length);
    const startX = CENTER_X - ((layer.length - 1) * spacing) / 2;
    layer.forEach((session, index) => {
      const bot = getBot(session.botId);
      const x = startX + index * spacing;
      const y = TOP_Y + depth * LAYER_H;
      position.set(session.id, { x, y });
      nodes.push({
        id: session.id,
        x,
        y,
        title: `${sessionOrdinal(view, session.id)} · ${bot?.name ?? "Bot"}`,
        subtitle: `${session.role} · ${statusWord(session.status)}`,
        status: session.status,
        color: bot ? colourHex(bot.appearance.colour) : NEUTRAL,
      });
      const parent = session.parentSessionId
        ? position.get(session.parentSessionId)
        : undefined;
      if (parent)
        edges.push({
          key: `edge-${session.id}`,
          fromX: parent.x,
          fromY: parent.y + NODE_H / 2,
          toX: x,
          toY: y - NODE_H / 2,
          variant: session.status === "running" ? "active" : "",
        });
    });
  });

  const height = TOP_Y + Math.max(layers.length - 1, 0) * LAYER_H + NODE_H;
  return { nodes, edges, height: Math.max(height + 20, 160) };
}

export function ExecutionGraph({
  view,
  getBot,
  selectedNodeId,
  onSelectNode,
}: {
  view: TaskView;
  getBot: (id: string) => Bot | undefined;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}) {
  const { nodes, edges, height } = layoutTaskGraph(view, getBot);

  return (
    <div className="graph-canvas-wrap">
      <svg
        className="graph-svg"
        viewBox={`0 0 ${WIDTH} ${height}`}
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`Execution graph for ${view.task.title}`}
      >
        {edges.map((e) => {
          const midY = (e.fromY + e.toY) / 2;
          return (
            <path
              key={e.key}
              className={`graph-edge ${e.variant}`}
              d={`M ${e.fromX} ${e.fromY} C ${e.fromX} ${midY}, ${e.toX} ${midY}, ${e.toX} ${e.toY}`}
            />
          );
        })}
        {nodes.map((n) => {
          const rx = n.x - NODE_W / 2;
          const ry = n.y - NODE_H / 2;
          return (
            <g
              key={n.id}
              className={`graph-node ${selectedNodeId === n.id ? "selected" : ""}`}
              role="button"
              tabIndex={0}
              aria-label={`${n.title}, ${n.subtitle}`}
              onClick={() => onSelectNode(n.id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ")
                  onSelectNode(n.id);
              }}
            >
              <rect
                className="node-card-bg"
                x={rx}
                y={ry}
                width={NODE_W}
                height={NODE_H}
                rx={11}
              />
              <circle cx={rx + 16} cy={n.y - 7} r={4.5} fill={n.color} />
              <text
                x={rx + 26}
                y={n.y - 3}
                fontSize="11.5"
                fontWeight="600"
                className="node-title"
              >
                {n.title}
              </text>
              <circle
                cx={rx + 16}
                cy={n.y + 12}
                r={3.2}
                fill={statusColor(n.status)}
              />
              <text
                x={rx + 24}
                y={n.y + 15}
                fontSize="10"
                className="node-subtitle"
              >
                {n.subtitle}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
