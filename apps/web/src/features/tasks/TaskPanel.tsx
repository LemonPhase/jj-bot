import type { TaskView } from "@jj/contracts";
import { lazy, Suspense } from "react";
import { cx, Spinner, Tabs } from "../../components/ui";
import { useWorkspace } from "../../state/WorkspaceContext";
import { ArtifactList } from "./ArtifactList";
import { NodeInspector } from "./NodeInspector";
import { ProgressSteps } from "./ProgressSteps";
import { TaskGraph } from "./TaskGraph";
import { defaultSelection, TASK_NODE } from "./taskModel";

export type PanelTab = "progress" | "graph" | "office";

const TABS = [
  { value: "progress", label: "Progress" },
  { value: "graph", label: "Graph" },
  { value: "office", label: "Office" },
] as const;

const LANDMARKS: Record<PanelTab, string> = {
  progress: "Progress",
  graph: "Execution graph",
  office: "Office",
};

// Three.js is large; only download it when someone opens the office.
const TaskOffice = lazy(() =>
  import("../office/TaskOffice").then((m) => ({ default: m.TaskOffice })),
);

/**
 * The right panel (SPEC §5.2–5.5): Progress | Graph | Office. Progress and
 * Graph share the selected session, so picking a step shows it in the graph.
 */
export function TaskPanel({
  view,
  tab,
  onTab,
}: {
  view: TaskView;
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
}) {
  const { getBot, selectedNodeId, selectNode } = useWorkspace();
  const known =
    selectedNodeId !== null &&
    (selectedNodeId === TASK_NODE ||
      view.sessions.some((session) => session.id === selectedNodeId));
  const picked = known ? selectedNodeId : null;

  return (
    <aside
      className={cx("ui-panel", "task-panel", `task-panel--${tab}`)}
      aria-label={LANDMARKS[tab]}
    >
      <Tabs label="View" value={tab} onChange={onTab} items={TABS} />
      {tab === "progress" && (
        <>
          <ProgressSteps view={view} picked={picked} onPick={selectNode} />
          <ArtifactList view={view} />
        </>
      )}
      {tab === "graph" && (
        <>
          <TaskGraph
            view={view}
            selected={picked ?? defaultSelection(view)}
            onSelect={selectNode}
          />
          <NodeInspector
            view={view}
            selected={picked ?? defaultSelection(view)}
          />
        </>
      )}
      {tab === "office" && (
        <div className="task-office">
          <Suspense
            fallback={<Spinner label="Loading the office…" showLabel />}
          >
            <TaskOffice key={view.task.id} view={view} getBot={getBot} />
          </Suspense>
        </div>
      )}
    </aside>
  );
}
