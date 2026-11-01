// System prompts for task sessions and direct chat. Kept short: the rules a
// model needs to collaborate, nothing it can infer. The roster is also in the
// tool schemas (delegate, message, send_to_task), which is what the scripted
// test model reads.

export interface PromptBot {
  name: string;
  role: string;
  instructions: string;
}

export interface RosterMember {
  name: string;
  role: string;
  self?: boolean;
}

export interface SessionPromptInput {
  bot: PromptBot;
  memory: string;
  role: "coordinator" | "worker";
  goal: string;
  goalVersion: number;
  roster: readonly RosterMember[];
  workspaceDir: string;
  /** The bot that delegated this work (workers). */
  requester?: string;
  /** False when delegation is not available (no teammates, or the depth limit). */
  canDelegate: boolean;
}

function persona(bot: PromptBot, memory: string): string[] {
  const lines = [
    `You are ${bot.name}${bot.role ? `, ${bot.role}` : ""}, a bot on a JJ Bot team.`,
  ];
  if (bot.instructions.trim())
    lines.push("", "## Your instructions", bot.instructions.trim());
  if (memory.trim())
    lines.push(
      "",
      "## Your memory",
      "Facts you have kept from earlier work. They are yours; teammates do not see them.",
      memory.trim(),
    );
  return lines;
}

export function formatRoster(roster: readonly RosterMember[]): string {
  return roster
    .map(
      (member) =>
        `- ${member.name}${member.role ? ` (${member.role})` : ""}${member.self ? " — you" : ""}`,
    )
    .join("\n");
}

export function sessionPrompt(input: SessionPromptInput): string {
  const lines = [
    ...persona(input.bot, input.memory),
    "",
    "## Task",
    `Goal (version ${input.goalVersion}):`,
    input.goal.trim(),
    "",
    "## Team",
    formatRoster(input.roster),
    "",
    "## Workspace",
    `Every bot on this task shares one workspace: ${input.workspaceDir}. Your coding tools run there. Teammates see your files at once, and the user can download them.`,
    "",
    "## How to work",
  ];
  const hasTeammates = input.roster.some((member) => !member.self);
  const messaging = hasTeammates
    ? ["- `message` tells a teammate something without starting new work."]
    : [];
  if (input.role === "coordinator") {
    lines.push(
      "You coordinate this task and deliver its result.",
      ...(input.canDelegate
        ? [
            "- Split the goal into bounded pieces and give each to a teammate with `delegate`: say what to produce, which files it owns, and what to report back.",
            "- Partition files: never give two bots the same file at once, and do not edit a file a teammate is working on.",
            "- After delegating, end your turn to wait. Each result arrives as a message; react to each as it comes: check it against the goal, follow up, or delegate again.",
          ]
        : ["- Do the work yourself with your coding tools."]),
      ...messaging,
      "- When the goal is met and every delegation has reported, call `complete_task` with the consolidated result for the user.",
      "- Ending your turn with nothing delegated and without `complete_task` means you are waiting for the user, so end with a clear question.",
      "- Only work done for the current goal version counts. When the goal changes, re-check finished work against the new goal before completing.",
    );
  } else {
    lines.push(
      `${input.requester ?? "The coordinator"} asked you to do one piece of this task; the brief is in the first message.`,
      "- Stay within your brief and the files it gives you. Do not edit files other bots own.",
      ...(input.canDelegate
        ? [
            "- If part of the brief needs a teammate, `delegate` it; its result comes back to you.",
          ]
        : []),
      ...messaging,
      `- When you are done, end your turn with a short report: what you did, the files you changed, and anything left open. That final message is sent to ${input.requester ?? "the coordinator"}.`,
      "- You cannot complete the task; only the coordinator can.",
    );
  }
  return lines.join("\n");
}

export interface ChatPromptInput {
  bot: PromptBot;
  memory: string;
  /** Other active bots, for task rosters. */
  team: readonly RosterMember[];
  activeTasks: readonly {
    id: string;
    title: string;
    status: string;
    coordinator: boolean;
  }[];
}

export function chatPrompt(input: ChatPromptInput): string {
  const tasks =
    input.activeTasks.length === 0
      ? "None."
      : input.activeTasks
          .map(
            (task) =>
              `- ${task.id}: ${task.title} (${task.status}${task.coordinator ? ", you coordinate" : ""})`,
          )
          .join("\n");
  return [
    ...persona(input.bot, input.memory),
    "",
    "This is a direct chat with the user. You have no workspace here and cannot run commands.",
    "",
    "## Your active tasks",
    tasks,
    "",
    "## Team",
    input.team.length > 0 ? formatRoster(input.team) : "Only you.",
    "",
    "## How to reply",
    "- Answer greetings, thanks, questions and status checks directly. Do not create a task for them.",
    "- When the user asks for work that needs commands or files, call `create_task` once with a clear goal and the teammates who should help. You coordinate the tasks you create.",
    "- If the message is about one of your active tasks, forward it with `send_to_task` instead of creating a new task.",
    "- If the request is unclear, ask one short question first.",
    "- Keep replies brief, and say what you did.",
  ].join("\n");
}
