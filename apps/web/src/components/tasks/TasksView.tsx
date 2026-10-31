import { useState } from "react";
import { useWorkspace } from "../../state/WorkspaceContext";
import { ExecutionGraph } from "./ExecutionGraph";
import { NodeInspector } from "./NodeInspector";
import { TaskChat } from "./TaskChat";
import { TaskList } from "./TaskList";

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
  const task = selectedTaskId ? getTask(selectedTaskId) : undefined;

  return (
    <section
      className={`view-pane tasks-layout active ${expanded ? "graph-expanded" : ""}`}
      aria-label="Tasks"
    >
      <TaskList onNewTask={onNewTask} />
      {task ? (
        <>
          <TaskChat task={task} />
          <aside className="graph-column" aria-label="Execution graph">
            <header className="pane-header">
              <div className="pane-header-left">
                <div className="pane-title">Execution Graph</div>
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
                <button
                  type="button"
                  className="action-btn"
                  onClick={() => setExpanded((on) => !on)}
                >
                  {expanded ? "Split" : "Expand"}
                </button>
              </div>
            </header>
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
