import type { BotProfile, TaskView } from "../../api/types";

const NODE_W = 128;
const NODE_H = 54;
const CENTER_X = 230;
const COORD_Y = 56;
const SESSION_Y = 188;
const GATE_Y = 322;

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
  variant: "" | "active" | "verifying";
}

const statusColor = (status: string) =>
  status === "completed"
    ? "#10B981"
    : status === "running"
      ? "#2563EB"
      : status === "verifying" || status === "waiting"
        ? "#D97706"
        : status === "failed"
          ? "#E11D48"
          : "#8C8C85";

const edgeVariant = (status: string): GraphEdge["variant"] =>
  status === "running" ? "active" : status === "verifying" ? "verifying" : "";

/** Pure layout so it can be reused or tested without rendering. */
export function layoutTaskGraph(
  task: TaskView,
  getBot: (id: string) => BotProfile | undefined,
) {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const coordinator = getBot(task.coordinatorBotId);

  nodes.push({
    id: `coord-${task.coordinatorBotId}`,
    x: CENTER_X,
    y: COORD_Y,
    title: coordinator?.name ?? "Coordinator",
    subtitle: `Coordinator · v${task.goalVersion}`,
    status: task.status,
    color: coordinator?.color ?? "#8C8C85",
  });

  const count = Math.max(task.sessions.length, 1);
  const spacing = Math.min(142, 390 / count);
  const startX = CENTER_X - ((count - 1) * spacing) / 2;

  task.sessions.forEach((session, index) => {
    const bot = getBot(session.botId);
    const x = startX + index * spacing;
    nodes.push({
      id: session.id,
      x,
      y: SESSION_Y,
      title: session.label,
      subtitle: `${bot?.name ?? "Bot"} · ${session.status}`,
      status: session.status,
      color: bot?.color ?? "#8C8C85",
    });
    const variant = edgeVariant(session.status);
    edges.push(
      {
        key: `in-${session.id}`,
        fromX: CENTER_X,
        fromY: COORD_Y + NODE_H / 2,
        toX: x,
        toY: SESSION_Y - NODE_H / 2,
        variant,
      },
      {
        key: `out-${session.id}`,
        fromX: x,
        fromY: SESSION_Y + NODE_H / 2,
        toX: CENTER_X,
        toY: GATE_Y - NODE_H / 2,
        variant,
      },
    );
  });

  const passed = task.checks.filter((c) => c.outcome === "passed").length;
  const allPassed = task.checks.length > 0 && passed === task.checks.length;
  nodes.push({
    id: "gate",
    x: CENTER_X,
    y: GATE_Y,
    title: "Verification Gate",
    subtitle: `${passed}/${task.checks.length} checks passed`,
    status: allPassed
      ? "completed"
      : task.status === "running"
        ? "verifying"
        : task.status,
    color: allPassed ? "#10B981" : "#7C3AED",
  });

  return { nodes, edges };
}

export function ExecutionGraph({
  task,
  getBot,
  selectedNodeId,
  onSelectNode,
}: {
  task: TaskView;
  getBot: (id: string) => BotProfile | undefined;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
}) {
  const { nodes, edges } = layoutTaskGraph(task, getBot);

  return (
    <div className="graph-canvas-wrap">
      <svg
        className="graph-svg"
        viewBox="0 0 460 390"
        preserveAspectRatio="xMidYMid meet"
        role="img"
        aria-label={`Execution graph for ${task.goal}`}
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
