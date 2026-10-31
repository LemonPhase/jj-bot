import type { Bot, TaskSummary } from "@jj/contracts";
import { type Mood, moodForStatus, type StatusTone } from "../../lib/status";

/** What the bot list shows under a bot's name: mood, square tone and a line of text. */
export interface BotActivity {
  mood: Mood;
  tone: StatusTone;
  text: string;
}

const isActive = (task: TaskSummary) =>
  task.status === "queued" || task.status === "running";

const about = (lead: string, tasks: readonly TaskSummary[]) =>
  tasks.length === 1
    ? `${lead} ${tasks[0]?.title}`
    : `${lead} ${tasks.length} tasks`;

/**
 * The bot list status line (SPEC §13.2), from the bot's server-derived
 * presence and the task list. Mood and square follow presence (brief decision
 * 1: working while the bot has a queued or running session). The text names
 * the work where the task list shows it:
 *   coordinating an active task   "Coordinating · {title}" (or "· N tasks")
 *   in an active task otherwise   "Working on {title}" (or "N tasks")
 *   coordinating a waiting task   "Waiting for you · {title}" (an idle bot)
 * and falls back to "Working" / "Idle". Finished tasks are not shown here.
 */
export function botActivity(
  bot: Pick<Bot, "id" | "presence">,
  tasks: readonly TaskSummary[],
): BotActivity {
  const mood = moodForStatus(bot.presence);
  if (bot.presence === "working") {
    const mine = tasks.filter(
      (task) => isActive(task) && task.participantBotIds.includes(bot.id),
    );
    const coordinating = mine.filter(
      (task) => task.coordinatorBotId === bot.id,
    );
    const text = coordinating.length
      ? about("Coordinating ·", coordinating)
      : mine.length
        ? about("Working on", mine)
        : "Working";
    return { mood, tone: "running", text };
  }
  const waiting = tasks.filter(
    (task) =>
      task.status === "waiting" &&
      !task.cancelRequestedAt &&
      task.coordinatorBotId === bot.id,
  );
  return {
    mood,
    tone: "idle",
    text: waiting.length ? about("Waiting for you ·", waiting) : "Idle",
  };
}
