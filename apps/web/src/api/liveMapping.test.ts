import { taskViewSchema } from "@jj/contracts/legacy";
import { describe, expect, it } from "vitest";
import { toBotProfile, toTaskView } from "./liveMapping";

const t = (minute: number) =>
  `2026-10-31T15:${String(minute).padStart(2, "0")}:00.000Z`;
const plan = [
  {
    id: "c1",
    description: "Answer is correct",
    method: "Rubric",
    expectedEvidence: "Reviewer note",
  },
  {
    id: "c2",
    description: "Cites sources",
    method: "Rubric",
    expectedEvidence: "Links",
  },
];

const view = taskViewSchema.parse({
  task: {
    id: "task-1",
    goal: "Summarise the spec",
    goalVersion: 2,
    coordinatorBotId: "bot-a",
    participantBotIds: ["bot-a", "bot-b"],
    verificationPlan: plan,
    status: "running",
    createdAt: t(0),
    updatedAt: t(9),
  },
  sessions: [
    {
      id: "s-late",
      taskId: "task-1",
      botId: "bot-b",
      goalVersion: 2,
      brief: "Synthesise",
      verificationPlan: plan,
      status: "queued",
      kind: "synthesis",
      createdAt: t(5),
    },
    {
      id: "s-early",
      taskId: "task-1",
      botId: "bot-a",
      goalVersion: 2,
      brief: "Research",
      verificationPlan: plan,
      status: "running",
      kind: "work",
      createdAt: t(1),
    },
  ],
  messages: [
    {
      id: "m1",
      taskId: "task-1",
      authorId: "user",
      authorKind: "user",
      text: "Go",
      intent: "discussion",
      activateBotIds: [],
    },
  ],
  verificationResults: [
    // Stale result from v1 must be ignored.
    {
      criterionId: "c1",
      taskId: "task-1",
      goalVersion: 1,
      outcome: "passed",
      evidence: ["old"],
    },
    {
      criterionId: "c1",
      taskId: "task-1",
      goalVersion: 2,
      outcome: "failed",
      evidence: ["missing section 3"],
    },
  ],
  events: [
    {
      id: "e1",
      taskId: "task-1",
      sequence: 1,
      sessionId: "s-early",
      occurredAt: t(2),
      type: "tool.started",
      payload: { tool: "read_file" },
    },
  ],
  replayCursor: 1,
});

describe("toTaskView", () => {
  const mapped = toTaskView(view);

  it("orders sessions by creation and labels them by kind", () => {
    expect(mapped.sessions.map((s) => s.label)).toEqual([
      "s-1 · Work",
      "s-2 · Synthesis",
    ]);
  });

  it("collects tool calls and live progress as session evidence", () => {
    expect(mapped.sessions[0]?.tools).toEqual(["read_file"]);
    expect(mapped.sessions[0]?.evidence).toBe("Running a tool…");
    expect(mapped.sessions[1]?.evidence).toBe("Queued");
  });

  it("shows one check per criterion using only current-version results", () => {
    expect(mapped.checks).toEqual([
      {
        id: "c1",
        description: "Answer is correct",
        outcome: "failed",
        evidence: "missing section 3",
      },
      {
        id: "c2",
        description: "Cites sources",
        outcome: "inconclusive",
        evidence: "Not run yet",
      },
    ]);
  });

  it("falls back to the task creation time for undated messages", () => {
    expect(mapped.messages[0]?.createdAt).toBe(t(0));
  });
});

describe("toBotProfile", () => {
  it("is stable for the same id and honours saved appearance", () => {
    const bot = { id: "bot-a", name: "Ada", instructions: "Help" };
    expect(toBotProfile(bot, "").color).toBe(toBotProfile(bot, "").color);
    const styled = toBotProfile(bot, "notes", {
      role: "Reviewer",
      glyph: "wave",
    });
    expect(styled).toMatchObject({
      role: "Reviewer",
      glyph: "wave",
      memory: "notes",
    });
  });
});
