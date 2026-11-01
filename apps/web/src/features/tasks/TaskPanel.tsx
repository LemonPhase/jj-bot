import type { TaskView } from "@jj/contracts";
import { useId } from "react";
import { cx, TabPanel, Tabs } from "../../components/ui";
import { useWorkspace } from "../../state/WorkspaceContext";
import { TaskOffice } from "../office/TaskOffice";
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

/**
 * The right panel (SPEC §5.2–5.5): a Progress | Graph | Office tab list over
 * the chosen tab panel. Progress and Graph share the selected session, so
 * picking a step shows it in the graph. The tab list keeps one place in the
 * DOM (so arrowing between tabs keeps focus); in the Office, CSS lays it
 * over the start of the office's header row, beside its 2D/3D switch.
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
  const baseId = useId();
  const panelId = (value: PanelTab) => `${baseId}-${value}`;
  const known =
    selectedNodeId !== null &&
    (selectedNodeId === TASK_NODE ||
      view.sessions.some((session) => session.id === selectedNodeId));
  const picked = known ? selectedNodeId : null;
  const tabs = (
    <Tabs
      label="Task view"
      value={tab}
      onChange={onTab}
      items={TABS}
      panelId={panelId}
    />
  );

  return (
    <aside
      className={cx("ui-panel", "task-panel", `task-panel--${tab}`)}
      aria-label={LANDMARKS[tab]}
    >
      {tabs}
      <TabPanel id={panelId(tab)} className="task-panel__body">
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
          <TaskOffice key={view.task.id} view={view} getBot={getBot} />
        )}
      </TabPanel>
    </aside>
  );
}
