import { z } from "zod";

export const CONTRACT_VERSION = "0.3.0";
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
    result: z.string().optional(),
    cancelReason: z.string().optional(),
    cancelledAt: z.iso.datetime().optional(),
    createdAt: z.iso.datetime().optional(),
    updatedAt: z.iso.datetime().optional(),
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
  kind: z.enum(["work", "synthesis"]).optional(),
  result: z.string().optional(),
  error: z.string().optional(),
  runId: id.optional(),
  attempts: z.number().int().nonnegative().optional(),
  createdAt: z.iso.datetime().optional(),
  updatedAt: z.iso.datetime().optional(),
});
export const taskMessageSchema = z.object({
  id,
  createdAt: z.iso.datetime().optional(),
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
    "model.started",
    "model.finished",
    "verification.started",
    "session.revising",
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
export const checkDefinitionSchema = z.object({
  id,
  kind: z.enum(["contains", "regex", "json", "model"]),
  value: z.string().optional(),
  description: z.string().optional(),
});
export const createTaskCommandSchema = z
  .object(taskSchema.shape)
  .omit({
    id: true,
    goalVersion: true,
    status: true,
    result: true,
    cancelReason: true,
    cancelledAt: true,
    createdAt: true,
    updatedAt: true,
  })
  .extend({
    checks: z.array(checkDefinitionSchema).optional(),
    autoStart: z.boolean().default(true),
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
export const postTaskMessageCommandSchema = taskMessageSchema
  .omit({ id: true, taskId: true })
  .extend({
    authorId: id.default("user"),
    authorKind: z.enum(["user", "bot", "system"]).default("user"),
    intent: z
      .enum(["discussion", "assignment", "result", "steering", "notification"])
      .default("discussion"),
    activateBotIds: z.array(id).default([]),
  });
export const steerTaskCommandSchema = z.object({
  text: z.string().min(1),
  authorId: id.default("user"),
  observedGoalVersion: z.number().int().positive().optional(),
  goal: z.string().min(1).optional(),
  verificationPlan: taskSchema.shape.verificationPlan.optional(),
  checks: z.array(checkDefinitionSchema).optional(),
});
export const stopTaskCommandSchema = z.object({
  reason: z.string().min(1).optional(),
  authorId: id.optional(),
  requestedBy: id.optional(),
});
export const taskViewSchema = z.object({
  task: taskSchema,
  bots: z.array(botSchema).default([]),
  participants: z.array(botSchema).default([]),
  sessions: z.array(executionSessionSchema),
  messages: z.array(taskMessageSchema),
  checks: z.array(verificationResultSchema),
  events: z.array(taskEventSchema),
  replayCursor: z.number().int().nonnegative(),
});
export const bootstrapSchema = z.object({
  mode: z.enum(["scaffold", "backend"]),
  contractVersion: z.string(),
  modelConfigured: z.boolean(),
  capabilities: z.object({
    agentExecution: z.boolean(),
    persistence: z.boolean(),
    taskStreaming: z.boolean(),
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
export type CheckDefinition = z.infer<typeof checkDefinitionSchema>;
export type CreateTaskCommand = z.input<typeof createTaskCommandSchema>;
export type PostTaskMessageCommand = z.input<
  typeof postTaskMessageCommandSchema
>;
export type SteerTaskCommand = z.input<typeof steerTaskCommandSchema>;
export type StopTaskCommand = z.input<typeof stopTaskCommandSchema>;
export type TaskView = z.infer<typeof taskViewSchema>;
export type Bootstrap = z.infer<typeof bootstrapSchema>;

// Keep API validation on the same schema implementation as the shared contracts.
export { z } from "zod";
