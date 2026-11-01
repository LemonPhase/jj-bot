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
      "Partition files: never give two bots the same file at once",
      "`delegate`",
      "Each result arrives as a message",
      "every delegation has reported, call `complete_task` with the consolidated result",
      "without `complete_task` means you are waiting for the user",
      "When the goal changes, re-check finished work",
    ])
      expect(coordinator).toContain(rule);
  });

  it("tell a worker whom it reports to and that it cannot complete the task", () => {
    expect(worker).toContain("Ada asked you to do one piece of this task");
    expect(worker).toContain("That final message is sent to Ada.");
    expect(worker).toContain("You cannot complete the task");
    expect(worker).toContain("Do not edit files other bots own.");
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
