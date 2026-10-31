import { describe, expect, it } from "vitest";
import {
  createTaskCommandSchema,
  postTaskMessageCommandSchema,
  steerTaskCommandSchema,
  taskMessageSchema,
  taskSchema,
  taskViewSchema,
  verificationResultSchema,
} from "./index";

const criterion = {
  id: "check-1",
  description: "Cite the answer",
  method: "Compare source",
  expectedEvidence: "Source URL and supporting passage",
};
const task = {
  id: "task-1",
  goal: "Compare sources",
  goalVersion: 1,
  coordinatorBotId: "a",
  participantBotIds: ["a", "b", "c"],
  verificationPlan: [criterion],
  status: "queued",
};
describe("JJ domain boundaries", () => {
  it("supports a variable roster and requires the coordinator to belong to it", () => {
    expect(taskSchema.safeParse(task).success).toBe(true);
    expect(
      taskSchema.safeParse({ ...task, coordinatorBotId: "outsider" }).success,
    ).toBe(false);
    expect(
      taskSchema.safeParse({ ...task, participantBotIds: ["a", "a"] }).success,
    ).toBe(false);
  });
  it("requires verification before task creation", () => {
    expect(
      taskSchema.safeParse({ ...task, verificationPlan: [] }).success,
    ).toBe(false);
  });
  it("permits a shared message that activates nobody", () => {
    expect(
      taskMessageSchema.safeParse({
        id: "m1",
        taskId: "task-1",
        authorId: "a",
        authorKind: "bot",
        text: "Source attached",
        intent: "notification",
        activateBotIds: [],
      }).success,
    ).toBe(true);
  });
  it("does not accept a passed check without evidence", () => {
    const result = {
      criterionId: "check-1",
      taskId: "task-1",
      goalVersion: 1,
      outcome: "passed",
      evidence: [],
    };
    expect(verificationResultSchema.safeParse(result).success).toBe(false);
    expect(
      verificationResultSchema.safeParse({
        ...result,
        evidence: ["https://example.org/source"],
      }).success,
    ).toBe(true);
    expect(
      verificationResultSchema.safeParse({ ...result, outcome: "inconclusive" })
        .success,
    ).toBe(true);
  });
});

describe("frontend command boundary", () => {
  it("requires a verification plan and a participating coordinator to create a task", () => {
    const command = {
      goal: "Compare sources",
      coordinatorBotId: "a",
      participantBotIds: ["a", "b"],
      verificationPlan: [criterion],
    };
    expect(createTaskCommandSchema.safeParse(command).success).toBe(true);
    expect(
      createTaskCommandSchema.safeParse({ ...command, verificationPlan: [] })
        .success,
    ).toBe(false);
    expect(
      createTaskCommandSchema.safeParse({
        ...command,
        coordinatorBotId: "outsider",
      }).success,
    ).toBe(false);
  });
  it("separates posting a message from steering the goal", () => {
    expect(
      postTaskMessageCommandSchema.safeParse({
        taskId: "task-1",
        text: "For reference",
        activateBotIds: [],
      }).success,
    ).toBe(true);
    // Steering carries the version the user saw, so stale steering can be rejected.
    expect(
      steerTaskCommandSchema.safeParse({
        taskId: "task-1",
        text: "Prioritise the primary source",
        observedGoalVersion: 1,
      }).success,
    ).toBe(true);
    expect(
      steerTaskCommandSchema.safeParse({
        taskId: "task-1",
        text: "Prioritise the primary source",
      }).success,
    ).toBe(false);
  });
  it("carries a replay cursor so a reload can resume the same event stream", () => {
    const view = {
      task,
      participants: [
        { id: "a", name: "Atlas", instructions: "Coordinate" },
        { id: "b", name: "Beacon", instructions: "Research" },
        { id: "c", name: "Cinder", instructions: "Check" },
      ],
      messages: [],
      sessions: [],
      verificationResults: [],
      events: [],
      replayCursor: 0,
    };
    expect(taskViewSchema.safeParse(view).success).toBe(true);
    expect(
      taskViewSchema.safeParse({ ...view, replayCursor: -1 }).success,
    ).toBe(false);
  });
});
