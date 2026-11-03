import { z } from "zod";
import { pendingApprovalSchema } from "./approvals";
import {
  COMMAND_TEXT_LIMIT,
  hasSomeField,
  idListSchema,
  idSchema,
  RECORD_TEXT_LIMIT,
  SOME_FIELD_REQUIRED,
  spendCapUsdSchema,
  timestampSchema,
} from "./common";
import { artifactUploadSchema, uploadEntryListSchema } from "./uploads";
import {
  verificationPlanSchema,
  verificationSummarySchema,
} from "./verification";

/**
 * - `queued`: created, nothing has started.
 * - `running`: at least one session is queued or running.
 * - `waiting`: no active work; the coordinator ended its turn without calling
 *   `complete_task`, usually to ask the user something, or every session
 *   still open waits for its delegations or for the user's approval of a
 *   call. The next user message continues it, as does an approval's answer.
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
 * What a waiting session resumes on: results of its open delegations, the
 * user (a coordinator that ended its turn without `complete_task`), or the
 * user's answer to the call it holds for approval (`approval`).
 */
export const waitingForSchema = z.enum(["delegations", "user", "approval"]);

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
  "verifying",
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
  /**
   * The verification plan of the current goal version, written by the user;
   * null for none. Parsed as null from events stored before plans existed.
   */
  verificationPlan: verificationPlanSchema.nullable().default(null),
  /**
   * The task's spend cap in US dollars, null for none. Set from the
   * coordinator's profile (`budgets.maxUsdPerTask`) when the task is created,
   * changed with `PATCH /api/tasks/:taskId`. No model call starts once the
   * task's priced spend reaches it; the task then waits for the user. Parsed
   * as null from events stored before caps existed.
   */
  spendCapUsd: spendCapUsdSchema.nullable().default(null),
  /**
   * The task template the task was started from (`POST
   * /api/task-templates/:id/tasks`), null for one created otherwise.
   * Attribution only: deleting the template leaves it set. Parsed as null
   * from events stored before templates existed.
   */
  templateId: idSchema.nullable().default(null),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
  finishedAt: timestampSchema.nullable(),
});

/** Refinement for records with a roster: the coordinator is one of the participants. */
export const coordinatorParticipates = (
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
 * A file a session produced, a file the user uploaded, or tool output
 * spilled because it exceeded the event preview. Content:
 * `GET /api/tasks/:taskId/artifacts/:artifactId/content`.
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
  /**
   * Set for a file the user uploaded (kind `file`, no session or run): the
   * announcement that attached it and where it stands in the workspace
   * (`artifact.updated` reports each change). Null for every other
   * artifact, and parsed as null from records stored before uploads.
   */
  upload: artifactUploadSchema.nullable().default(null),
  createdAt: timestampSchema,
});

const tokenCountSchema = z.number().int().nonnegative();

/**
 * Tokens and cost of model calls. `costUsd` is computed from the model
 * catalog's listed price; `unpricedCalls` counts the calls on models with no
 * listed price, whose cost is unknown and not in `costUsd` (spend caps cannot
 * bound them). Parsed as 0 from events stored before it existed.
 */
export const usageSchema = z.object({
  modelCalls: tokenCountSchema,
  inputTokens: tokenCountSchema,
  outputTokens: tokenCountSchema,
  cacheReadTokens: tokenCountSchema,
  cacheWriteTokens: tokenCountSchema,
  costUsd: z.number().nonnegative(),
  unpricedCalls: tokenCountSchema.default(0),
});

export const emptyUsage = (): Usage => ({
  modelCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  unpricedCalls: 0,
});

export const addUsage = (a: Usage, b: Usage): Usage => ({
  modelCalls: a.modelCalls + b.modelCalls,
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  costUsd: a.costUsd + b.costUsd,
  unpricedCalls: a.unpricedCalls + b.unpricedCalls,
});

/** The create-task command before participant normalization. */
export const createTaskCommandObjectSchema = z.object({
  goal: goalSchema,
  title: titleSchema.optional(),
  coordinatorBotId: idSchema,
  participantBotIds: idListSchema.default([]),
  /** The user's plan; omitted or null for none. Refused while `capabilities.verification` is false. */
  verificationPlan: verificationPlanSchema.nullable().optional(),
  /** Omitted: the coordinator's profile's `budgets.maxUsdPerTask`. Null: no cap. */
  spendCapUsd: spendCapUsdSchema.nullable().optional(),
  /**
   * Staged uploads to attach (`uploadEntryListSchema`), placed in the
   * workspace before the coordinator's first model call. Refused with 404
   * while `capabilities.uploads` is null.
   */
  uploads: uploadEntryListSchema.default(() => []),
});

/** The command with its coordinator added to the participants when missing, first. */
export const withCoordinator = <
  Command extends { coordinatorBotId: string; participantBotIds: string[] },
>(
  command: Command,
): Command => ({
  ...command,
  participantBotIds: command.participantBotIds.includes(
    command.coordinatorBotId,
  )
    ? command.participantBotIds
    : [command.coordinatorBotId, ...command.participantBotIds],
});

/** `POST /api/tasks`. The coordinator is added to the participants when missing. */
export const createTaskCommandSchema =
  createTaskCommandObjectSchema.transform(withCoordinator);

/** The post-message command without its goal/version refinement. */
export const postTaskMessageCommandObjectSchema = z.object({
  text: commandTextSchema,
  goal: goalSchema.optional(),
  observedGoalVersion: goalVersionSchema.optional(),
  /** Replaces the plan (null removes it), starting a new goal version when it differs. */
  verificationPlan: verificationPlanSchema.nullable().optional(),
});

/**
 * `POST /api/tasks/:taskId/messages`. Every user message steers the coordinator.
 * `goal` replaces the goal and `verificationPlan` the plan; a change to either
 * increments the goal version. Both require the version the user was looking
 * at, so a stale edit fails with STALE_GOAL_VERSION.
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
    else if (
      command.verificationPlan !== undefined &&
      command.observedGoalVersion === undefined
    )
      context.addIssue({
        code: "custom",
        path: ["observedGoalVersion"],
        message:
          "Changing the verification plan requires the goal version you observed.",
      });
  });

/**
 * `POST /api/tasks/:taskId/uploads` → 201: the attached uploads' artifacts,
 * in the order given, and the announcement posted to the task log.
 */
export const uploadToTaskResultSchema = z.object({
  artifacts: z.array(artifactSchema),
  message: taskMessageSchema,
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

/** Longest `TaskSummary.question`, in UTF-16 code units. */
export const TASK_QUESTION_LIMIT = 240;

/** The task update command without its at-least-one-field refinement. */
export const updateTaskCommandObjectSchema = z
  .object({
    /** The new spend cap (null for none). It may be below what the task has spent: no further call starts. */
    spendCapUsd: spendCapUsdSchema.nullable(),
  })
  .partial();

/**
 * `PATCH /api/tasks/:taskId`. Changing the cap does not continue a task that
 * stopped at it; a user message does. A cancelled task, or one with
 * `cancelRequestedAt` set, answers 409 TASK_TERMINAL.
 */
export const updateTaskCommandSchema = updateTaskCommandObjectSchema.refine(
  hasSomeField,
  SOME_FIELD_REQUIRED,
);

/** The task summary without its cross-field refinement. */
export const taskSummaryObjectSchema = taskObjectSchema.extend({
  activeSessionCount: z.number().int().nonnegative(),
  sessionCount: z.number().int().nonnegative(),
  usage: usageSchema,
  /**
   * Set only while the task is `waiting` for the user: the coordinator's
   * last message to the user, on one line and clipped (`questionExcerpt`).
   * Derived from the task log; absent once the task continues or finishes.
   */
  question: z.string().min(1).max(TASK_QUESTION_LIMIT).optional(),
  /**
   * The task's calls waiting for the user's approval, oldest first: at most
   * one per session. Parsed as empty from servers before approvals.
   */
  pendingApprovals: z.array(pendingApprovalSchema).default(() => []),
  /**
   * Set exactly when the task has a plan: where its checks stand for the
   * current goal version (`verificationSummary`). Show the task as verified
   * only through `isVerified`.
   */
  verification: verificationSummarySchema.optional(),
});

/** A task as lists show it. */
export const taskSummarySchema = taskSummaryObjectSchema.superRefine(
  (summary, context) => {
    coordinatorParticipates(summary, context);
    if (summary.question !== undefined && summary.status !== "waiting")
      context.addIssue({
        code: "custom",
        path: ["question"],
        message: "Only a waiting task has a question.",
      });
    if (
      (summary.verification !== undefined) !==
      (summary.verificationPlan !== null)
    )
      context.addIssue({
        code: "custom",
        path: ["verification"],
        message:
          "A task has a verification summary exactly when it has a plan.",
      });
  },
);

/**
 * `text` as a `TaskSummary.question`: on one line, cut near
 * TASK_QUESTION_LIMIT (never inside a surrogate pair) with "…". Undefined
 * for blank text.
 */
export function questionExcerpt(text: string): string | undefined {
  const line = text.replace(/\s+/g, " ").trim();
  if (!line) return undefined;
  if (line.length <= TASK_QUESTION_LIMIT) return line;
  return `${line
    .slice(0, TASK_QUESTION_LIMIT - 1)
    .replace(/[\uD800-\uDBFF]$/, "")
    .trimEnd()}…`;
}

/**
 * Whether a task message is the coordinator talking to the user: a
 * discussion message its root session posted with no recipients (as when it
 * ends a turn to ask the user something).
 */
export function isCoordinatorToUser(
  message: Pick<
    TaskMessage,
    "authorKind" | "authorBotId" | "sessionId" | "intent" | "recipientBotIds"
  >,
  task: Pick<Task, "coordinatorBotId">,
  rootSessionId: string | undefined,
): boolean {
  return (
    message.authorKind === "bot" &&
    message.authorBotId === task.coordinatorBotId &&
    message.intent === "discussion" &&
    message.recipientBotIds.length === 0 &&
    rootSessionId !== undefined &&
    message.sessionId === rootSessionId
  );
}

/**
 * A summary's `question` from a task view: while the task waits, the
 * coordinator's last message to the user (see `isCoordinatorToUser`).
 */
export function waitingQuestion(view: {
  task: Pick<Task, "status" | "coordinatorBotId">;
  sessions: readonly Pick<ExecutionSession, "id" | "parentSessionId">[];
  messages: readonly Pick<
    TaskMessage,
    | "authorKind"
    | "authorBotId"
    | "sessionId"
    | "intent"
    | "recipientBotIds"
    | "text"
  >[];
}): string | undefined {
  if (view.task.status !== "waiting") return undefined;
  const root = view.sessions.find((s) => s.parentSessionId === null)?.id;
  for (let index = view.messages.length - 1; index >= 0; index--) {
    const message = view.messages[index];
    if (message && isCoordinatorToUser(message, view.task, root))
      return questionExcerpt(message.text);
  }
  return undefined;
}

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
export type UploadToTaskResult = z.infer<typeof uploadToTaskResultSchema>;
export type Usage = z.infer<typeof usageSchema>;
export type CreateTaskCommand = z.input<typeof createTaskCommandSchema>;
export type PostTaskMessageCommand = z.input<
  typeof postTaskMessageCommandSchema
>;
export type StopTaskCommand = z.input<typeof stopTaskCommandSchema>;
export type UpdateTaskCommand = z.input<typeof updateTaskCommandSchema>;
export type TaskSummary = z.infer<typeof taskSummarySchema>;
