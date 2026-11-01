import type { TaskSummary, TaskView } from "@jj/contracts";
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

/** The sidebar task list (SPEC §3): title, status · version, participant sprites. */
export function TaskList({ labelledBy }: { labelledBy: string }) {
  const { tasks, loading, selectedTaskId, taskViews, getBot } = useWorkspace();
  const { openNewTask } = useShell();
  const onKeyDown = useListKeyboard();

  if (loading) return <p className="shell-list__note">Loading…</p>;
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
      {tasks.map((task, index) => {
        const participants = task.participantBotIds.flatMap((botId) => {
          const bot = getBot(botId);
          return bot ? [bot] : [];
        });
        return (
          <li key={task.id}>
            <ListItem
              data-list-item=""
              layout="stack"
              tabIndex={index === stop ? 0 : -1}
              selected={task.id === selectedTaskId}
              aria-current={task.id === selectedTaskId ? "page" : undefined}
              muted={task.status === "completed"}
              onClick={() => navigate({ name: "tasks", taskId: task.id })}
              title={task.title}
              subtitle={
                <StatusTag status={task} detail={`v${task.goalVersion}`} />
              }
              trailing={
                <span
                  className="task-list__bots"
                  role="img"
                  aria-label={participants.map((bot) => bot.name).join(", ")}
                >
                  {participants.map((bot) => (
                    <Avatar
                      key={bot.id}
                      appearance={bot.appearance}
                      name={bot.name}
                      mood={participantMood(task, taskViews[task.id], bot.id)}
                      size={24}
                      decorative
                    />
                  ))}
                </span>
              }
            />
          </li>
        );
      })}
    </ul>
  );
}
