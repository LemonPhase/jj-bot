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
  /**
   * A worker's brief, as its requester wrote it. It is part of the prompt,
   * which is rebuilt every run, so context compaction never touches it.
   */
  brief?: string;
  /** False when delegation is not available (no teammates, or the depth limit). */
  canDelegate: boolean;
  /** True on a recovery run: the session resumes after its worker stopped. */
  resumed?: boolean;
}

/** Heading of the section that holds a worker's brief (the scripted model reads it too). */
export const BRIEF_HEADING = "## Your brief";

/** The inbox item that starts a delegated session: its brief is in the prompt. */
export const briefPointer = (requester: string) =>
  `Assignment from ${requester}: your brief is in the "Your brief" section of your system prompt. Start now.`;

/**
 * Prepended to a coordinator's new input when that input sets aside a
 * completion it recorded earlier in the run (see takeInbox).
 */
export const COMPLETION_SET_ASIDE =
  "Your `complete_task` call was set aside because new input arrived after it (below). Check it, and when the work is done and verified, call `complete_task` again with the consolidated result.";

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
            "- Split the goal into bounded pieces and give each to a teammate with `delegate`: say what to produce, the files it owns, and what to report back.",
            "- Files: every brief names the files that worker owns, and a file has one owner at a time. Workers edit only the files in their brief and may read any other. Files several pieces need (such as package.json or a shared README) are yours: edit them after the results arrive.",
            "- Delegate each piece once. Never delegate work that is already assigned (each `delegate` result and each result you receive lists your open delegations); wait for its result, or `message` that teammate.",
            "- After delegating, end your turn to wait. Each result arrives as a message; react to each as it comes: check it against the goal, follow up, or delegate again.",
          ]
        : ["- Do the work yourself with your coding tools."]),
      ...messaging,
      "- When the work is done and verified (every delegation has reported and you have checked the result against the goal), call `complete_task` with the consolidated result.",
      "- End a turn with nothing delegated and without `complete_task` only when you genuinely need the user's input, and say exactly what you need.",
      "- Only work done for the current goal version counts. When the goal changes, re-check finished work against the new goal before completing.",
      ...(input.resumed
        ? [
            "- This run resumes after an interruption (a restart). Check what has reported and what is still open, then carry on; once the work is done and verified, finish with `complete_task`.",
          ]
        : []),
    );
  } else {
    lines.push(
      `${input.requester ?? "The coordinator"} asked you to do one piece of this task, described in your brief below.`,
      "- Edit only the files your brief names; you may read any file. If another file needs a change, say so in your report instead of editing it.",
      ...(input.canDelegate
        ? [
            "- If part of the brief needs a teammate, `delegate` it with the files it needs from your brief; its result comes back to you.",
          ]
        : []),
      ...messaging,
      `- When you are done, end your turn with a short report: what you did, the files you changed, and anything left open. That final message is sent to ${input.requester ?? "the coordinator"}.`,
      "- You cannot complete the task; only the coordinator can.",
      ...(input.resumed
        ? [
            "- This run resumes after an interruption (a restart). Check what is already done, then finish the brief and end with your report.",
          ]
        : []),
    );
    // Last, so the brief's own text (headings included) cannot cut it short.
    lines.push(
      "",
      `${BRIEF_HEADING} (from ${input.requester ?? "the coordinator"})`,
      input.brief?.trim() || "(no brief)",
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
