import { lazy, Suspense, useState } from "react";
import { useWorkspace } from "../../state/WorkspaceContext";
import { ExecutionGraph } from "./ExecutionGraph";
import { NodeInspector } from "./NodeInspector";
import { TaskChat } from "./TaskChat";
import { TaskList } from "./TaskList";

type GraphView = "graph" | "office";

// Three.js is large; only download it when someone opens the office.
const TaskOffice = lazy(() =>
  import("./office/TaskOffice").then((m) => ({ default: m.TaskOffice })),
);

export function TasksView({ onNewTask }: { onNewTask: () => void }) {
  const {
    selectedTaskId,
    getTask,
    getBot,
    selectedNodeId,
    selectNode,
    advanceDemoTask,
  } = useWorkspace();
  const [expanded, setExpanded] = useState(false);
  const [view, setView] = useState<GraphView>("graph");
  const task = selectedTaskId ? getTask(selectedTaskId) : undefined;
  const wide = expanded || view === "office";

  return (
    <section
      className={`view-pane tasks-layout active ${wide ? "graph-expanded" : ""}`}
      aria-label="Tasks"
    >
      <TaskList onNewTask={onNewTask} />
      {task ? (
        <>
          <TaskChat task={task} />
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
                {advanceDemoTask && (
                  <button
                    type="button"
                    className="action-btn"
                    title="Demo only: advance sessions one step"
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
                <TaskOffice key={task.id} task={task} getBot={getBot} />
              </Suspense>
            ) : (
              <>
                <ExecutionGraph
                  task={task}
                  getBot={getBot}
                  selectedNodeId={selectedNodeId}
                  onSelectNode={selectNode}
                />
                <NodeInspector
                  task={task}
                  selectedNodeId={selectedNodeId}
                  getBot={getBot}
                />
              </>
            )}
          </aside>
        </>
      ) : (
        <main className="chat-column empty-state">
          <p>No task selected. Create one to bring bots together.</p>
        </main>
      )}
    </section>
  );
}
