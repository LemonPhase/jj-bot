import { describe, expect, it } from "vitest";
import {
  taskMessageSchema,
  taskSchema,
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
