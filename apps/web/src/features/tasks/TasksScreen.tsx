import { lazy, Suspense, useState } from "react";
import { Button, EmptyState, Spinner } from "../../components/ui";
import { rootSession } from "../../lib/tasks";
import { useWorkspace } from "../../state/WorkspaceContext";
import { useShell } from "../shell/ShellContext";
import { ExecutionGraph } from "./ExecutionGraph";
import { NodeInspector } from "./NodeInspector";
import { TaskChat } from "./TaskChat";
import "./legacy-tasks.css";

type GraphView = "graph" | "office";

// Three.js is large; only download it when someone opens the office.
const TaskOffice = lazy(() =>
  import("../office/TaskOffice").then((m) => ({ default: m.TaskOffice })),
);

/**
 * `#/tasks/:taskId`. The pre-redesign task chat, graph and office, restyled
 * only by the new tokens; the Tasks rebuild (SPEC §5.2–5.5) replaces it. The
 * task list lives in the sidebar.
 */
export function TasksScreen() {
  const { openNewTask } = useShell();
  const {
    tasks,
    selectedTaskId,
    getTask,
    taskViews,
    getBot,
    selectedNodeId,
    selectNode,
    advanceDemoTask,
  } = useWorkspace();
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState<GraphView>("graph");
  const task = selectedTaskId ? getTask(selectedTaskId) : undefined;
  const taskView = selectedTaskId ? taskViews[selectedTaskId] : undefined;
  // Default to the coordinator's session until the user picks a node.
  const nodeId =
    selectedNodeId ?? (taskView ? (rootSession(taskView)?.id ?? null) : null);
  const finished =
    task?.status === "completed" ||
    task?.status === "failed" ||
    task?.status === "cancelled";
  const wide = expanded || view === "office";

  return (
    <section
      className={`legacy-tasks ${wide ? "graph-expanded" : ""}`}
      aria-label="Tasks"
    >
      {task && !taskView ? (
        <main className="screen screen--center">
          <Spinner label="Loading task…" showLabel />
        </main>
      ) : task && taskView ? (
        <>
          <TaskChat view={taskView} />
          <aside
            className={`graph-column ${view === "office" ? "office-mode" : ""}`}
            aria-label={view === "office" ? "Task office" : "Execution graph"}
          >
            <header className="pane-header">
              <div className="pane-header-left">
                <div className="view-switch" role="tablist">
                  {(["graph", "office"] as const).map((v) => (
                    <button
                      key={v}
                      type="button"
                      role="tab"
                      aria-selected={view === v}
                      className={view === v ? "active" : ""}
                      onClick={() => setView(v)}
                    >
                      {v === "graph" ? "Execution Graph" : "Office"}
                    </button>
                  ))}
                </div>
              </div>
              <div className="header-actions">
                {advanceDemoTask && !finished && (
                  <button
                    type="button"
                    className="action-btn"
                    title="Demo only: run the next scripted step now"
                    onClick={() => void advanceDemoTask(task.id)}
                  >
                    Demo step ↻
                  </button>
                )}
                {view === "graph" && (
                  <button
                    type="button"
                    className="action-btn"
                    onClick={() => setExpanded((on) => !on)}
                  >
                    {expanded ? "Split" : "Expand"}
                  </button>
                )}
              </div>
            </header>
            {view === "office" ? (
              <Suspense
                fallback={<div className="loading-state">Loading office…</div>}
              >
                <TaskOffice key={task.id} view={taskView} getBot={getBot} />
              </Suspense>
            ) : (
              <>
                <ExecutionGraph
                  view={taskView}
                  getBot={getBot}
                  selectedNodeId={nodeId}
                  onSelectNode={selectNode}
                />
                <NodeInspector
                  view={taskView}
                  selectedNodeId={nodeId}
                  getBot={getBot}
                />
              </>
            )}
          </aside>
        </>
      ) : (
        <main className="screen screen--center">
          <EmptyState
            align="center"
            message={
              tasks.length === 0 || !selectedTaskId
                ? "No tasks yet. Start one to bring bots together."
                : "This task does not exist."
            }
            action={
              <Button variant="primary" onClick={() => openNewTask()}>
                New task
              </Button>
            }
          />
        </main>
      )}
    </section>
  );
}
