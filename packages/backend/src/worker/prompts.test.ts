import { describe, expect, it } from "vitest";
import { chatPrompt, sessionPrompt } from "./prompts";

const roster = [
  { name: "Ada", role: "Lead", self: true },
  { name: "Bob", role: "Researcher" },
  { name: "Cy", role: "" },
];

const coordinator = sessionPrompt({
  bot: { name: "Ada", role: "Lead", instructions: "Be brief." },
  memory: "The client prefers Markdown.",
  role: "coordinator",
  goal: "Write a report",
  goalVersion: 3,
  roster,
  workspaceDir: "/workspace",
  canDelegate: true,
});

const worker = sessionPrompt({
  bot: { name: "Bob", role: "Researcher", instructions: "" },
  memory: "",
  role: "worker",
  goal: "Write a report",
  goalVersion: 3,
  roster: roster.map((member) => ({ ...member, self: member.name === "Bob" })),
  workspaceDir: "/workspace",
  requester: "Ada",
  canDelegate: false,
});

const resumedCoordinator = sessionPrompt({
  bot: { name: "Ada", role: "Lead", instructions: "" },
  memory: "",
  role: "coordinator",
  goal: "Write a report",
  goalVersion: 1,
  roster,
  workspaceDir: "/workspace",
  canDelegate: true,
  resumed: true,
});

const chat = chatPrompt({
  bot: { name: "Ada", role: "Lead", instructions: "Be brief." },
  memory: "The client prefers Markdown.",
  team: [{ name: "Bob", role: "Researcher" }],
  activeTasks: [
    { id: "task_1", title: "Report", status: "running", coordinator: true },
  ],
});

describe("prompts", () => {
  it("give the coordinator its persona, goal version, roster and completion rules", () => {
    expect(coordinator).toMatch(/^You are Ada, Lead, a bot on a JJ Bot team\./);
    for (const rule of [
      "Be brief.",
      "The client prefers Markdown.",
      "Goal (version 3):\nWrite a report",
      "- Ada (Lead) — you\n- Bob (Researcher)\n- Cy",
      "one workspace: /workspace",
      "`delegate`",
      "Each result arrives as a message",
      "When the goal changes, re-check finished work",
    ])
      expect(coordinator).toContain(rule);
    expect(coordinator).not.toContain("resumes after an interruption");
  });

  it("state the file-partition rule concretely", () => {
    for (const rule of [
      "every brief names the files that worker owns",
      "Workers edit only the files in their brief and may read any other",
      "are yours: edit them after the results arrive",
    ])
      expect(coordinator).toContain(rule);
    expect(worker).toContain(
      "Edit only the files your brief names; you may read any file.",
    );
  });

  it("tell the coordinator not to delegate assigned work again", () => {
    expect(coordinator).toContain(
      "Never delegate work that is already assigned (`delegate` lists your open delegations)",
    );
  });

  it("tell the coordinator to finish with complete_task, and when ending without it is right", () => {
    expect(coordinator).toContain(
      "When the work is done and verified (every delegation has reported and you have checked the result against the goal), call `complete_task` with the consolidated result.",
    );
    expect(coordinator).toContain(
      "without `complete_task` only when you genuinely need the user's input, and say exactly what you need",
    );
  });

  it("tell a resumed coordinator to check what is open and finish with complete_task", () => {
    expect(resumedCoordinator).toContain(
      "This run resumes after an interruption (a restart). Check what has reported and what is still open, then carry on; once the work is done and verified, finish with `complete_task`.",
    );
  });

  it("tell a worker whom it reports to and that it cannot complete the task", () => {
    expect(worker).toContain("Ada asked you to do one piece of this task");
    expect(worker).toContain("That final message is sent to Ada.");
    expect(worker).toContain("You cannot complete the task");
    expect(worker).not.toContain("`delegate`");
    expect(worker).not.toContain("Your memory");
  });

  it("tell a chat bot when to answer, create a task or forward", () => {
    for (const rule of [
      "cannot run commands",
      "- task_1: Report (running, you coordinate)",
      "Do not create a task for them.",
      "call `create_task` once",
      "forward it with `send_to_task` instead of creating a new task",
      "The client prefers Markdown.",
      "- Bob (Researcher)",
    ])
      expect(chat).toContain(rule);
  });

  it("stay stable", () => {
    expect({ coordinator, worker, chat }).toMatchSnapshot();
  });
});
