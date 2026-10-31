import { z } from "zod";

export const CONTRACT_VERSION = "0.1.0";
const id = z.string().min(1);
export const verificationCriterionSchema = z.object({
  id,
  description: z.string().min(1),
  method: z.string().min(1),
  expectedEvidence: z.string().min(1),
});
export const verificationPlanSchema = z
  .array(verificationCriterionSchema)
  .min(1);
export const botSchema = z.object({
  id,
  name: z.string().min(1),
  instructions: z.string().min(1),
});
export const taskSchema = z
  .object({
    id,
    goal: z.string().min(1),
    goalVersion: z.number().int().positive(),
    coordinatorBotId: id,
    participantBotIds: z.array(id).min(1),
    verificationPlan: verificationPlanSchema,
    status: z.enum([
      "queued",
      "running",
      "waiting",
      "completed",
      "failed",
      "cancelled",
    ]),
  })
  .superRefine((task, context) => {
    if (!task.participantBotIds.includes(task.coordinatorBotId)) {
      context.addIssue({
        code: "custom",
        path: ["coordinatorBotId"],
        message: "The coordinator must participate in the task.",
      });
    }
    if (
      new Set(task.participantBotIds).size !== task.participantBotIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["participantBotIds"],
        message: "Task participants must be unique.",
      });
    }
  });
export const executionSessionSchema = z.object({
  id,
  taskId: id,
  botId: id,
  parentSessionId: id.optional(),
  goalVersion: z.number().int().positive(),
  brief: z.string().min(1),
  verificationPlan: verificationPlanSchema,
  status: z.enum([
    "queued",
    "running",
    "verifying",
    "waiting",
    "completed",
    "failed",
    "cancelled",
  ]),
});
export const taskMessageSchema = z.object({
  id,
  taskId: id,
  authorId: id,
  authorKind: z.enum(["user", "bot", "system"]),
  text: z.string().min(1),
  intent: z.enum([
    "discussion",
    "assignment",
    "result",
    "steering",
    "notification",
  ]),
  // Shared visibility is independent of this explicit activation list.
  activateBotIds: z.array(id),
});
export const taskEventSchema = z.object({
  id,
  taskId: id,
  sequence: z.number().int().positive(),
  botId: id.optional(),
  sessionId: id.optional(),
  runId: id.optional(),
  causedByEventId: id.optional(),
  occurredAt: z.iso.datetime(),
  type: z.enum([
    "task.created",
    "message.posted",
    "session.started",
    "session.finished",
    "tool.started",
    "tool.finished",
    "verification.recorded",
    "steering.received",
    "cancellation.requested",
    "task.finished",
  ]),
  payload: z.record(z.string(), z.unknown()),
});
export const verificationResultSchema = z
  .object({
    criterionId: id,
    taskId: id,
    sessionId: id.optional(),
    goalVersion: z.number().int().positive(),
    outcome: z.enum(["passed", "failed", "inconclusive"]),
    evidence: z.array(z.string().min(1)),
  })
  .superRefine((result, context) => {
    if (result.outcome === "passed" && result.evidence.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["evidence"],
        message: "A passed check requires evidence.",
      });
    }
  });
export const bootstrapSchema = z.object({
  mode: z.literal("scaffold"),
  contractVersion: z.string(),
  modelConfigured: z.boolean(),
  capabilities: z.object({
    agentExecution: z.literal(false),
    persistence: z.literal(false),
    taskStreaming: z.literal(false),
  }),
  bots: z.array(botSchema),
  tasks: z.array(taskSchema),
});
export type Bot = z.infer<typeof botSchema>;
export type Task = z.infer<typeof taskSchema>;
export type ExecutionSession = z.infer<typeof executionSessionSchema>;
export type TaskMessage = z.infer<typeof taskMessageSchema>;
export type TaskEvent = z.infer<typeof taskEventSchema>;
export type VerificationResult = z.infer<typeof verificationResultSchema>;
export type Bootstrap = z.infer<typeof bootstrapSchema>;
