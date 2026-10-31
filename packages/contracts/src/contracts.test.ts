import { describe, expect, it } from "vitest";
import {
  CONTRACT_VERSION,
  createTaskCommandSchema,
  postTaskMessageCommandSchema,
  steerTaskCommandSchema,
  stopTaskCommandSchema,
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
  it("validates 0.2.0 command and taskView schemas", () => {
    expect(CONTRACT_VERSION).toBe("0.2.0");
    expect(
      createTaskCommandSchema.safeParse({
        goal: "Compare sources",
        coordinatorBotId: "a",
        participantBotIds: ["a", "b"],
        verificationPlan: [criterion],
      }).success,
    ).toBe(true);
    expect(
      postTaskMessageCommandSchema.parse({
        text: "Shared note",
      }).activateBotIds,
    ).toEqual([]);
    expect(
      steerTaskCommandSchema.safeParse({
        text: "Focus on primary sources",
        observedGoalVersion: 1,
      }).success,
    ).toBe(true);
    expect(
      stopTaskCommandSchema.safeParse({
        reason: "User requested stop",
      }).success,
    ).toBe(true);
    expect(
      taskViewSchema.safeParse({
        task,
        bots: [{ id: "a", name: "Alpha", instructions: "Lead" }],
        participants: [{ id: "a", name: "Alpha", instructions: "Lead" }],
        sessions: [],
        messages: [],
        checks: [],
        events: [],
        replayCursor: 0,
      }).success,
    ).toBe(true);
  });
});
