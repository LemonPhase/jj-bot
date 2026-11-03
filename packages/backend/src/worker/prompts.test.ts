import { describe, expect, it } from "vitest";
import { LOOKUP_TOOLS } from "./lookup-tools";
import {
  BRIEF_HEADING,
  briefPointer,
  chatPrompt,
  sessionPrompt,
} from "./prompts";

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
  brief:
    "Write notes-bob.md about penguins.\n\n## Sources\nUse the zoo's site.",
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

  it("tell the coordinator to settle shared decisions in the briefs, and a worker to keep to them", () => {
    expect(coordinator).toContain(
      "- Shared decisions: when pieces share something (an interface such as a function's exact name and signature, a naming or style convention, a data format), decide it yourself before delegating and state it in every affected brief, alongside the files that worker owns. Do not leave workers to agree it between themselves or to report what they chose; inside its own piece, each worker decides.",
    );
    expect(worker).toContain(
      "- Keep to the shared decisions in your brief (interfaces, conventions, data formats); inside your piece, you decide. If a shared decision needs to change, say so in your report, or `message` Ada.",
    );
    // Nothing important may exist only as a message.
    expect(worker).toContain(
      "- Anything a teammate or Ada must know goes into your report or a file you own, not only into a `message`.",
    );
    const solo = sessionPrompt({
      bot: { name: "Ada", role: "", instructions: "" },
      memory: "",
      role: "coordinator",
      goal: "Write a report",
      goalVersion: 1,
      roster: [{ name: "Ada", role: "", self: true }],
      workspaceDir: "/workspace",
      canDelegate: false,
    });
    expect(solo).not.toContain("Shared decisions");
  });

  it("tell the coordinator not to delegate assigned work again", () => {
    expect(coordinator).toContain(
      "Never delegate work that is already assigned (each `delegate` result and each result you receive lists your open delegations)",
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

  it("give a worker its brief in the prompt, last, whole and attributed", () => {
    expect(worker).toContain(
      "Ada asked you to do one piece of this task, described in your brief below.",
    );
    expect(worker).not.toContain("first message");
    expect(
      worker.endsWith(
        `${BRIEF_HEADING} (from Ada)\nWrite notes-bob.md about penguins.\n\n## Sources\nUse the zoo's site.`,
      ),
    ).toBe(true);
    expect(coordinator).not.toContain(BRIEF_HEADING);
    // The inbox item that starts the session only points at it.
    expect(briefPointer("Ada")).toBe(
      'Assignment from Ada: your brief is in the "Your brief" section of your system prompt. Start now.',
    );
  });

  it("tell a worker whom it reports to and that it cannot complete the task", () => {
    expect(worker).toContain("Ada asked you to do one piece of this task");
    expect(worker).toContain("That final message is sent to Ada.");
    expect(worker).toContain("You cannot complete the task");
    expect(worker).not.toContain("`delegate`");
    expect(worker).not.toContain("Your memory");
  });

  it("tell every task session about the lookup tools and when to use them, in one line", () => {
    const solo = sessionPrompt({
      bot: { name: "Ada", role: "", instructions: "" },
      memory: "",
      role: "coordinator",
      goal: "Write a report",
      goalVersion: 1,
      roster: [{ name: "Ada", role: "", self: true }],
      workspaceDir: "/workspace",
      canDelegate: false,
    });
    const lookupLines = (prompt: string) =>
      prompt.split("\n").filter((line) => line.includes("`task_log`"));
    for (const prompt of [coordinator, worker, solo]) {
      const lines = lookupLines(prompt);
      expect(lines).toHaveLength(1);
      for (const tool of LOOKUP_TOOLS)
        expect(lines[0]).toContain(`\`${tool}\``);
      expect(lines[0]).toContain(
        "look up this task's shared record: its sessions, the user's messages, and every brief, report and teammate message in full.",
      );
    }
    expect(lookupLines(coordinator)[0]).toContain(
      "Use them when you need something no longer in front of you, such as an earlier report or what the user asked before, but not to check on open delegations: their results arrive as messages, so end your turn to wait.",
    );
    expect(lookupLines(worker)[0]).toContain(
      "When your brief refers to something it does not spell out (a rule or request from the user, earlier work, a teammate's result, a file it does not explain), look it up with `task_log` or `read_report` before you start.",
    );
    expect(chat).not.toContain("`task_log`");
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
