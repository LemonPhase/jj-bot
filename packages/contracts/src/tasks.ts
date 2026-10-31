import { z } from "zod";
import {
  COMMAND_TEXT_LIMIT,
  idListSchema,
  idSchema,
  RECORD_TEXT_LIMIT,
  timestampSchema,
} from "./common";

/**
 * - `queued`: created, nothing has started.
 * - `running`: at least one session is queued or running.
 * - `waiting`: no active work; the coordinator ended its turn without calling
 *   `complete_task`, usually to ask the user something. The next user message continues it.
 * - `completed`: the coordinator called `complete_task`.
 * - `failed`: unrecoverable, for example the coordinator session failed.
 * - `cancelled`: stopped by the user. Terminal: it cannot be continued.
 *
 * Posting to a `waiting`, `completed` or `failed` task continues it.
 */
export const TASK_STATUSES = [
  "queued",
  "running",
  "waiting",
  "completed",
  "failed",
  "cancelled",
] as const;
export const taskStatusSchema = z.enum(TASK_STATUSES);

/** Statuses a task finishes in (`task.finished`). Only `cancelled` cannot be continued. */
export const FINISHED_TASK_STATUSES = [
  "completed",
  "failed",
  "cancelled",
] as const;
export const finishedTaskStatusSchema = taskStatusSchema.extract(
  FINISHED_TASK_STATUSES,
);

/**
 * Same states as a task, scoped to one session. `waiting`: the session ended
 * its turn and resumes when input arrives; `waitingFor` says which input.
 */
export const sessionStatusSchema = z.enum(TASK_STATUSES);

/**
 * What a waiting session resumes on: results of its open delegations, or the
 * user (a coordinator that ended its turn without `complete_task`).
 */
export const waitingForSchema = z.enum(["delegations", "user"]);

/** True for completed, failed and cancelled, for tasks and sessions alike. */
export const isFinishedStatus = (
  status: TaskStatus | SessionStatus,
): status is FinishedTaskStatus =>
  (FINISHED_TASK_STATUSES as readonly string[]).includes(status);

export const ACTIVITY_KINDS = [
  "thinking",
  "command",
  "reading",
  "editing",
  "searching",
  "delegating",
  "messaging",
  "waiting",
] as const;

/** Longest activity line, in UTF-16 code units. */
export const ACTIVITY_TEXT_LIMIT = 200;

/** The one-line "what is this bot doing" shown per session, derived from durable events. */
export const activitySchema = z.object({
  kind: z.enum(ACTIVITY_KINDS),
  /** For example "Running `npm test`", "Editing src/app.ts", "Delegated to Researcher". */
  text: z.string().min(1).max(ACTIVITY_TEXT_LIMIT),
  since: timestampSchema,
});

const goalSchema = z.string().trim().min(1).max(COMMAND_TEXT_LIMIT);
const goalVersionSchema = z.number().int().min(1);
const titleSchema = z.string().trim().min(1).max(120);
const commandTextSchema = z.string().trim().min(1).max(COMMAND_TEXT_LIMIT);
/** Text written by a model or the engine. */
const recordTextSchema = z.string().max(RECORD_TEXT_LIMIT);

/** The task record without its cross-field refinement, for `.pick`, `.omit` and `.partial`. */
export const taskObjectSchema = z.object({
  id: idSchema,
  /** Derived from the goal by the server when the creator gives none. */
  title: titleSchema,
  goal: goalSchema,
  goalVersion: goalVersionSchema,
  coordinatorBotId: idSchema,
  participantBotIds: idListSchema.min(1),
  status: taskStatusSchema,
  result: recordTextSchema.nullable(),
  error: recordTextSchema.nullable(),
  cancelReason: z.string().nullable(),
  /**
   * Set when the user asks to stop. From then on the API answers new messages
   * with 409 TASK_TERMINAL and clients show "Stopping…" until the task is cancelled.
   */
  cancelRequestedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  finishedAt: timestampSchema.nullable(),
});

const coordinatorParticipates = (
  task: { coordinatorBotId: string; participantBotIds: string[] },
  context: z.RefinementCtx,
) => {
  if (!task.participantBotIds.includes(task.coordinatorBotId))
    context.addIssue({
      code: "custom",
      path: ["participantBotIds"],
      message: "The coordinator must participate in the task.",
    });
};

export const taskSchema = taskObjectSchema.superRefine(coordinatorParticipates);

/**
 * One execution of a bot's work within a task. There is no separate assignment
 * record: a delegation creates a child session whose `parentSessionId` is the
 * requesting session, whose `brief` is the assignment and whose `result` is the
 * assignment's result. The session tree is the task's execution graph.
 */
export const executionSessionSchema = z.object({
  id: idSchema,
  taskId: idSchema,
  botId: idSchema,
  parentSessionId: idSchema.nullable(),
  role: z.enum(["coordinator", "worker"]),
  brief: recordTextSchema,
  goalVersion: goalVersionSchema,
  depth: z.number().int().nonnegative(),
  status: sessionStatusSchema,
  /** Non-null exactly while `status` is `waiting`. */
  waitingFor: waitingForSchema.nullable(),
  result: recordTextSchema.nullable(),
  error: recordTextSchema.nullable(),
  /**
   * Latest activity, derived from events with `activityFromEvent`; null when
   * idle. Activity changes alone do not touch `updatedAt` or emit `session.updated`.
   */
  activity: activitySchema.nullable(),
  runCount: z.number().int().nonnegative(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  startedAt: timestampSchema.nullable(),
  finishedAt: timestampSchema.nullable(),
});

export const MESSAGE_INTENTS = [
  "discussion",
  "assignment",
  "result",
  "steering",
  "notification",
] as const;

/**
 * Every message is visible to the whole task. `recipientBotIds` is activation,
 * not visibility: the bots the message is addressed to and may wake.
 */
export const taskMessageSchema = z.object({
  id: idSchema,
  taskId: idSchema,
  sequence: z.number().int().min(1),
  authorKind: z.enum(["user", "bot", "system"]),
  authorBotId: idSchema.nullable(),
  sessionId: idSchema.nullable(),
  intent: z.enum(MESSAGE_INTENTS),
  /** As produced; the engine posts "(no text)" for a final turn with no text. */
  text: recordTextSchema,
  recipientBotIds: idListSchema,
  createdAt: timestampSchema,
});

/**
 * A file a session produced, or tool output spilled because it exceeded the
 * event preview. Content: `GET /api/tasks/:taskId/artifacts/:artifactId/content`.
 */
export const artifactSchema = z.object({
  id: idSchema,
  taskId: idSchema,
  sessionId: idSchema.nullable(),
  runId: idSchema.nullable(),
  kind: z.enum(["file", "output"]),
  /** Workspace-relative path for a file; a label for spilled output. */
  path: z.string().min(1),
  name: z.string().min(1),
  contentType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: timestampSchema,
});

const tokenCountSchema = z.number().int().nonnegative();

export const usageSchema = z.object({
  modelCalls: tokenCountSchema,
  inputTokens: tokenCountSchema,
  outputTokens: tokenCountSchema,
  cacheReadTokens: tokenCountSchema,
  cacheWriteTokens: tokenCountSchema,
  costUsd: z.number().nonnegative(),
});

export const emptyUsage = (): Usage => ({
  modelCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
});

export const addUsage = (a: Usage, b: Usage): Usage => ({
  modelCalls: a.modelCalls + b.modelCalls,
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  costUsd: a.costUsd + b.costUsd,
});

export const verificationCriterionSchema = z.object({
  id: idSchema,
  description: z.string().min(1),
  method: z.string().min(1),
  expectedEvidence: z.string().min(1),
});

/**
 * Opt-in per task. The API rejects a present plan with VERIFICATION_UNAVAILABLE
 * while `capabilities.verification` is false, instead of storing a plan nothing enforces.
 */
export const verificationPlanSchema = z
  .array(verificationCriterionSchema)
  .min(1);

/** The create-task command before participant normalization. */
export const createTaskCommandObjectSchema = z.object({
  goal: goalSchema,
  title: titleSchema.optional(),
  coordinatorBotId: idSchema,
  participantBotIds: idListSchema.default([]),
  verificationPlan: verificationPlanSchema.optional(),
});

/** `POST /api/tasks`. The coordinator is added to the participants when missing. */
export const createTaskCommandSchema = createTaskCommandObjectSchema.transform(
  (command) => ({
    ...command,
    participantBotIds: command.participantBotIds.includes(
      command.coordinatorBotId,
    )
      ? command.participantBotIds
      : [command.coordinatorBotId, ...command.participantBotIds],
  }),
);

/** The post-message command without its goal/version refinement. */
export const postTaskMessageCommandObjectSchema = z.object({
  text: commandTextSchema,
  goal: goalSchema.optional(),
  observedGoalVersion: goalVersionSchema.optional(),
  verificationPlan: verificationPlanSchema.optional(),
});

/**
 * `POST /api/tasks/:taskId/messages`. Every user message steers the coordinator.
 * `goal` replaces the goal and increments the goal version; it requires the
 * version the user was looking at, so a stale edit fails with STALE_GOAL_VERSION.
 * Posting to a waiting, completed or failed task continues it (`task.reopened`).
 * A cancelled task, or one with `cancelRequestedAt` set, answers 409 TASK_TERMINAL.
 */
export const postTaskMessageCommandSchema =
  postTaskMessageCommandObjectSchema.superRefine((command, context) => {
    if (command.goal !== undefined && command.observedGoalVersion === undefined)
      context.addIssue({
        code: "custom",
        path: ["observedGoalVersion"],
        message: "Changing the goal requires the goal version you observed.",
      });
  });

/** `POST /api/tasks/:taskId/stop`. An empty or blank reason counts as none. */
export const stopTaskCommandSchema = z.object({
  reason: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((reason) => reason || undefined),
});

/** The task summary without its cross-field refinement. */
export const taskSummaryObjectSchema = taskObjectSchema.extend({
  activeSessionCount: z.number().int().nonnegative(),
  sessionCount: z.number().int().nonnegative(),
  usage: usageSchema,
});

/** A task as lists show it. */
export const taskSummarySchema = taskSummaryObjectSchema.superRefine(
  coordinatorParticipates,
);

export type TaskStatus = z.infer<typeof taskStatusSchema>;
export type FinishedTaskStatus = z.infer<typeof finishedTaskStatusSchema>;
export type SessionStatus = z.infer<typeof sessionStatusSchema>;
export type WaitingFor = z.infer<typeof waitingForSchema>;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export type Activity = z.infer<typeof activitySchema>;
export type Task = z.infer<typeof taskSchema>;
export type ExecutionSession = z.infer<typeof executionSessionSchema>;
export type SessionRole = ExecutionSession["role"];
export type MessageIntent = (typeof MESSAGE_INTENTS)[number];
export type TaskMessage = z.infer<typeof taskMessageSchema>;
export type Artifact = z.infer<typeof artifactSchema>;
export type Usage = z.infer<typeof usageSchema>;
export type VerificationCriterion = z.infer<typeof verificationCriterionSchema>;
export type VerificationPlan = z.infer<typeof verificationPlanSchema>;
export type CreateTaskCommand = z.input<typeof createTaskCommandSchema>;
export type PostTaskMessageCommand = z.input<
  typeof postTaskMessageCommandSchema
>;
export type StopTaskCommand = z.input<typeof stopTaskCommandSchema>;
export type TaskSummary = z.infer<typeof taskSummarySchema>;
