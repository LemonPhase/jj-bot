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
// Commands the frontend sends. Each is a separate authority: posting a message is not
// permission to execute, and only steering may advance the goal version.
export const createTaskCommandSchema = z
  .object({
    goal: z.string().min(1),
    coordinatorBotId: id,
    participantBotIds: z.array(id).min(1),
    verificationPlan: verificationPlanSchema,
  })
  .superRefine((command, context) => {
    if (!command.participantBotIds.includes(command.coordinatorBotId)) {
      context.addIssue({
        code: "custom",
        path: ["coordinatorBotId"],
        message: "The coordinator must participate in the task.",
      });
    }
  });
export const createBotCommandSchema = z.object({
  name: z.string().min(1),
  instructions: z.string().min(1),
});
export const postTaskMessageCommandSchema = z.object({
  taskId: id,
  text: z.string().min(1),
  // Explicit: an empty list shares the message without activating any bot.
  activateBotIds: z.array(id),
});
export const steerTaskCommandSchema = z.object({
  taskId: id,
  text: z.string().min(1),
  // The goal version the user was looking at, so the backend can reject stale steering.
  observedGoalVersion: z.number().int().positive(),
  // Present only when the user is replacing the goal, which bumps the goal version.
  replacementGoal: z.string().min(1).optional(),
});
export const stopTaskCommandSchema = z.object({
  taskId: id,
  reason: z.string().min(1),
});
// One read model behind both the task chat and the collaboration view, so they cannot disagree.
export const taskViewSchema = z.object({
  task: taskSchema,
  participants: z.array(botSchema),
  messages: z.array(taskMessageSchema),
  sessions: z.array(executionSessionSchema),
  verificationResults: z.array(verificationResultSchema),
  events: z.array(taskEventSchema),
  // Highest event sequence included here; resume a stream from it after a reload.
  replayCursor: z.number().int().nonnegative(),
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
export type CreateBotCommand = z.infer<typeof createBotCommandSchema>;
export type CreateTaskCommand = z.infer<typeof createTaskCommandSchema>;
export type PostTaskMessageCommand = z.infer<
  typeof postTaskMessageCommandSchema
>;
export type SteerTaskCommand = z.infer<typeof steerTaskCommandSchema>;
export type StopTaskCommand = z.infer<typeof stopTaskCommandSchema>;
export type TaskView = z.infer<typeof taskViewSchema>;
