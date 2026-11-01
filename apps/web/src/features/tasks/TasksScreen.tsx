import type { TaskView } from "@jj/contracts";
import { useState } from "react";
import {
  Button,
  buttonClass,
  cx,
  EmptyState,
  ErrorBanner,
  Spinner,
} from "../../components/ui";
import { type TaskProblem, useWorkspace } from "../../state/WorkspaceContext";
import { taskHref } from "../shell/router";
import { useShell } from "../shell/ShellContext";
import { TaskChat } from "./TaskChat";
import { TaskHeader } from "./TaskHeader";
import { type PanelTab, TaskPanel } from "./TaskPanel";
import "./tasks.css";

/**
 * `#/tasks/:taskId` (SPEC §5.2–5.5): the task's header and group chat, with
 * the Progress | Graph | Office panel on the right. The task list lives in the
 * sidebar. Loading, failure and empty states are handled here, before any
 * task chrome is drawn.
 */
export function TasksScreen() {
  const { tasks, selectedTaskId, taskViews, taskProblem, retryTask } =
    useWorkspace();
  const { openNewTask } = useShell();
  // Kept across tasks, so switching tasks keeps the panel the reader chose.
  const [tab, setTab] = useState<PanelTab>("progress");

  if (!selectedTaskId) {
    if (tasks.length === 0)
      return (
        <main className="screen screen--center">
          <EmptyState
            align="center"
            message="No tasks yet. Start one to bring bots together."
            action={
              <Button variant="primary" onClick={() => openNewTask()}>
                New task
              </Button>
            }
          />
        </main>
      );
    // No id yet: the shell is about to open the first task.
    return <main className="screen" />;
  }

  const view = taskViews[selectedTaskId];
  const problem =
    taskProblem?.taskId === selectedTaskId ? taskProblem : undefined;
  if (view)
    return (
      <TaskScreen
        key={selectedTaskId}
        view={view}
        problem={problem}
        onRetry={retryTask}
        tab={tab}
        onTab={setTab}
      />
    );
  if (problem) return <TaskLoadFailure problem={problem} onRetry={retryTask} />;
  return (
    <main className="screen screen--center">
      <Spinner label="Loading task…" showLabel />
    </main>
  );
}

function TaskScreen({
  view,
  problem,
  onRetry,
  tab,
  onTab,
}: {
  view: TaskView;
  problem?: TaskProblem;
  onRetry: () => void;
  tab: PanelTab;
  onTab: (tab: PanelTab) => void;
}) {
  return (
    <div className={cx("task-screen", `task-screen--${tab}`)}>
      <main className="task-main" aria-label={`Task: ${view.task.title}`}>
        <TaskHeader view={view} />
        {problem && (
          <div className="task-main__notice">
            <ErrorBanner
              word={problem.terminal ? "Not updating" : "Reconnecting"}
            >
              {problem.error.message}{" "}
              <button type="button" className="text-link" onClick={onRetry}>
                Retry now
              </button>
            </ErrorBanner>
          </div>
        )}
        <TaskChat view={view} />
      </main>
      <TaskPanel view={view} tab={tab} onTab={onTab} />
    </div>
  );
}

/** The task could not be loaded: say why, and offer what can help. */
function TaskLoadFailure({
  problem,
  onRetry,
}: {
  problem: TaskProblem;
  onRetry: () => void;
}) {
  const { tasks } = useWorkspace();
  const { openNewTask } = useShell();
  const { error } = problem;
  if (error.code === "NOT_FOUND") {
    // The list is newest first.
    const first = tasks.find((task) => task.id !== problem.taskId);
    return (
      <main className="screen screen--center">
        <EmptyState
          align="center"
          message="This task does not exist or was deleted."
          action={
            first ? (
              <a
                className={buttonClass({ variant: "primary" })}
                href={taskHref(first.id)}
              >
                Open the latest task
              </a>
            ) : (
              <Button variant="primary" onClick={() => openNewTask()}>
                New task
              </Button>
            )
          }
        />
      </main>
    );
  }
  return (
    <main className="screen screen--center">
      <div className="task-failure">
        <ErrorBanner
          word={
            error.code === "UNAUTHORIZED" ? "Not authorised" : "Couldn't load"
          }
        >
          {error.message}
        </ErrorBanner>
        <p className="task-failure__note">
          {problem.terminal
            ? error.code === "UNAUTHORIZED"
              ? "The API refused the request. Open the app with ?token=<API_TOKEN> to use a token."
              : "Retrying will not help until the cause is fixed."
            : "Retrying automatically."}
        </p>
        <Button onClick={onRetry}>Retry now</Button>
      </div>
    </main>
  );
}
