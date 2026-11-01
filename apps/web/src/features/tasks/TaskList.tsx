import type { Bot, TaskSummary, TaskView } from "@jj/contracts";
import { memo } from "react";
import {
  Avatar,
  Button,
  EmptyState,
  ListItem,
  StatusTag,
} from "../../components/ui";
import { type Mood, moodForStatus } from "../../lib/status";
import { useWorkspace } from "../../state/WorkspaceContext";
import { tabStopIndex, useListKeyboard } from "../shell/listNavigation";
import { useShell } from "../shell/ShellContext";
import { navigate } from "../shell/useRoute";
import "./tasks.css";

/**
 * A participant's mood in a task: its latest session's when the task's view
 * is loaded (the open task), else the coordinator follows the task and the
 * others rest.
 */
function participantMood(
  task: TaskSummary,
  view: TaskView | undefined,
  botId: string,
): Mood {
  const session = view?.sessions
    .filter((s) => s.botId === botId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  if (session) return moodForStatus(session);
  return botId === task.coordinatorBotId ? moodForStatus(task) : "idle";
}

/** Sprites shown per row, as designed; more participants read "+N". */
const MAX_SPRITES = 3;

/** The sidebar task list (SPEC §3): title, status · version, participant sprites. */
export function TaskList({ labelledBy }: { labelledBy: string }) {
  const { tasks, loading, loadError, selectedTaskId, taskViews, getBot } =
    useWorkspace();
  const { openNewTask } = useShell();
  const onKeyDown = useListKeyboard();

  if (loading) return <p className="shell-list__note">Loading…</p>;
  if (loadError) return <p className="shell-list__note">Not loaded.</p>;
  if (tasks.length === 0)
    return (
      <EmptyState
        message="No tasks yet."
        action={
          <Button variant="primary" onClick={() => openNewTask()}>
            New task
          </Button>
        }
      />
    );

  const stop = tabStopIndex(
    tasks.findIndex((task) => task.id === selectedTaskId),
    tasks.length,
  );
  return (
    <ul className="ui-list" aria-labelledby={labelledBy} onKeyDown={onKeyDown}>
      {tasks.map((task, index) => (
        <TaskRow
          key={task.id}
          task={task}
          view={taskViews[task.id]}
          getBot={getBot}
          selected={task.id === selectedTaskId}
          tabStop={index === stop}
        />
      ))}
    </ul>
  );
}

/** One task row; memoised, so a streamed event re-renders only its own task's row. */
const TaskRow = memo(function TaskRow({
  task,
  view,
  getBot,
  selected,
  tabStop,
}: {
  task: TaskSummary;
  view: TaskView | undefined;
  getBot: (botId: string) => Bot | undefined;
  selected: boolean;
  tabStop: boolean;
}) {
  const participants = task.participantBotIds.flatMap((botId) => {
    const bot = getBot(botId);
    return bot ? [bot] : [];
  });
  return (
    <li>
      <ListItem
        data-list-item=""
        layout="stack"
        tabIndex={tabStop ? 0 : -1}
        selected={selected}
        aria-current={selected ? "page" : undefined}
        muted={task.status === "completed"}
        onClick={() => navigate({ name: "tasks", taskId: task.id })}
        title={task.title}
        subtitle={<StatusTag status={task} detail={`v${task.goalVersion}`} />}
        trailing={
          <span
            className="task-list__bots"
            role="img"
            aria-label={participants.map((bot) => bot.name).join(", ")}
          >
            {participants.slice(0, MAX_SPRITES).map((bot) => (
              <Avatar
                key={bot.id}
                appearance={bot.appearance}
                name={bot.name}
                mood={participantMood(task, view, bot.id)}
                size={24}
                decorative
              />
            ))}
            {participants.length > MAX_SPRITES && (
              <span className="task-list__more">
                +{participants.length - MAX_SPRITES}
              </span>
            )}
          </span>
        }
      />
    </li>
  );
});
