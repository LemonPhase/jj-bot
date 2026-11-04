import { z } from "zod";
import {
  COMMAND_TEXT_LIMIT,
  hasSomeField,
  idListSchema,
  idSchema,
  SOME_FIELD_REQUIRED,
  spendCapUsdSchema,
  timestampSchema,
} from "./common";
import {
  type CreateTaskCommand,
  coordinatorParticipates,
  createTaskCommandObjectSchema,
  taskObjectSchema,
  withCoordinator,
} from "./tasks";
import { uploadEntryListSchema } from "./uploads";
import { verificationPlanSchema } from "./verification";

/**
 * Task templates: a saved task setup the user starts again with one action.
 * Starting one creates the same task `POST /api/tasks` creates from the same
 * fields (`templateTaskCommand`), with `templateId` set. Templates are the
 * user's: no agent tool lists, saves or starts them.
 */

/** Most templates a server keeps; a save past it answers CONFLICT. */
export const MAX_TASK_TEMPLATES = 200;
/** Longest instructions for one run of a template, in UTF-16 code units. */
export const TEMPLATE_INSTRUCTIONS_LIMIT = 4000;
/** The line a run's instructions follow, after the template's goal. */
export const TEMPLATE_INSTRUCTIONS_HEADING = "Instructions for this run:";
/**
 * `updateTaskTemplateCommandSchema.spendCapUsd`: go back to the coordinator's
 * profile cap at start (the read shape then omits `spendCapUsd`).
 */
export const PROFILE_SPEND_CAP = "profile";

const titleSchema = taskObjectSchema.shape.title;
const goalSchema = taskObjectSchema.shape.goal;

/**
 * Why a template cannot start now, derived from the bots, models and
 * capabilities each time it is read. A start with any problem is refused
 * with TEMPLATE_UNUSABLE before anything is written. Spend caps are checked
 * at start and are not problems.
 */
export const templateProblemSchema = z.discriminatedUnion("kind", [
  /** A participant (the coordinator included) is archived: the template never starts without it. */
  z.object({
    kind: z.literal("bot_archived"),
    botId: idSchema,
    name: z.string().min(1),
  }),
  /** A participant's model, or the default one, cannot run. */
  z.object({
    kind: z.literal("model_not_configured"),
    botId: idSchema,
    message: z.string().min(1),
  }),
  /** The template has a verification plan and this server does not enforce plans. */
  z.object({ kind: z.literal("verification_unavailable") }),
]);

/** The template record without its roster refinement, for `.pick` and `.omit`. */
export const taskTemplateObjectSchema = z.object({
  id: idSchema,
  title: titleSchema,
  goal: goalSchema,
  coordinatorBotId: idSchema,
  /** The coordinator included, as in a task. */
  participantBotIds: idListSchema.min(1),
  verificationPlan: verificationPlanSchema.nullable().default(null),
  /**
   * Omitted: the coordinator's profile's `budgets.maxUsdPerTask`, read when
   * a task starts. Null: no cap. As in `createTaskCommandSchema`.
   */
  spendCapUsd: spendCapUsdSchema.nullable().optional(),
  /** Empty when the template can start now. */
  problems: z.array(templateProblemSchema).default(() => []),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

export const taskTemplateSchema = taskTemplateObjectSchema.superRefine(
  coordinatorParticipates,
);

/**
 * The create command before participant normalization: the create-task
 * fields, with a title. A template carries no files: uploads are given at
 * each start.
 */
export const createTaskTemplateCommandObjectSchema =
  createTaskCommandObjectSchema
    .omit({ uploads: true })
    .extend({ title: titleSchema });

/**
 * `POST /api/task-templates`. The coordinator is added to the participants
 * when missing. An unknown or archived bot is VALIDATION_FAILED, as for a
 * task; more than MAX_TASK_TEMPLATES is CONFLICT.
 */
export const createTaskTemplateCommandSchema =
  createTaskTemplateCommandObjectSchema.transform(withCoordinator);

/** The update command without its at-least-one-field refinement. */
export const updateTaskTemplateCommandObjectSchema = z
  .object({
    title: titleSchema,
    goal: goalSchema,
    coordinatorBotId: idSchema,
    /** Replaced whole; the coordinator is added when missing. */
    participantBotIds: idListSchema,
    /** Null removes the plan. */
    verificationPlan: verificationPlanSchema.nullable(),
    /** A cap, null for none, or PROFILE_SPEND_CAP for the coordinator's profile's at start. */
    spendCapUsd: z.union([
      spendCapUsdSchema.nullable(),
      z.literal(PROFILE_SPEND_CAP),
    ]),
  })
  .partial();

/**
 * `PATCH /api/task-templates/:id`. The server merges the patch onto the
 * stored template and checks the result as a save.
 */
export const updateTaskTemplateCommandSchema =
  updateTaskTemplateCommandObjectSchema.refine(
    hasSomeField,
    SOME_FIELD_REQUIRED,
  );

/**
 * `POST /api/task-templates/:id/tasks`. `instructions` are appended to the
 * goal (`templateRunGoal`); a goal that then exceeds COMMAND_TEXT_LIMIT
 * answers 422 VALIDATION_FAILED. `title` replaces the template's title for
 * this task, and `spendCapUsd` its cap (null for none). `uploads` attaches
 * staged uploads to the new task, as `POST /api/tasks` does. A template with
 * problems answers 409 TEMPLATE_UNUSABLE with `details.problems`, and a
 * coordinator at its cap 409 SPEND_CAP_REACHED; neither writes anything.
 */
export const startTemplateCommandSchema = z.object({
  instructions: z
    .string()
    .trim()
    .min(1)
    .max(TEMPLATE_INSTRUCTIONS_LIMIT)
    .optional(),
  title: titleSchema.optional(),
  spendCapUsd: spendCapUsdSchema.nullable().optional(),
  uploads: uploadEntryListSchema.default(() => []),
});

/** `GET /api/task-templates`, oldest first. */
export const taskTemplateListSchema = z.object({
  templates: z.array(taskTemplateSchema),
});
/** `POST`, `GET` and `PATCH` of one template. */
export const taskTemplateResultSchema = z.object({
  template: taskTemplateSchema,
});

/** `TEMPLATE_UNUSABLE`'s `details`. */
export const templateUnusableDetailsSchema = z.object({
  problems: z.array(templateProblemSchema).min(1),
});

/** The goal a run of a template starts with: its goal, then the run's instructions. */
export function templateRunGoal(goal: string, instructions?: string): string {
  return instructions
    ? `${goal}\n\n${TEMPLATE_INSTRUCTIONS_HEADING}\n${instructions}`
    : goal;
}

/**
 * The create-task command a start makes: the template's fields, with the
 * run's instructions appended to the goal, its title and cap in place of
 * the template's when given, and its uploads. Its `goal` may exceed COMMAND_TEXT_LIMIT
 * (`templateGoalTooLong`).
 */
export function templateTaskCommand(
  template: Pick<
    TaskTemplate,
    | "title"
    | "goal"
    | "coordinatorBotId"
    | "participantBotIds"
    | "verificationPlan"
    | "spendCapUsd"
  >,
  start: Partial<z.output<typeof startTemplateCommandSchema>> = {},
): CreateTaskCommand {
  const spendCapUsd =
    start.spendCapUsd !== undefined ? start.spendCapUsd : template.spendCapUsd;
  return {
    goal: templateRunGoal(template.goal, start.instructions),
    title: start.title ?? template.title,
    coordinatorBotId: template.coordinatorBotId,
    participantBotIds: [...template.participantBotIds],
    verificationPlan: template.verificationPlan,
    ...(spendCapUsd !== undefined ? { spendCapUsd } : {}),
    ...(start.uploads && start.uploads.length > 0
      ? { uploads: start.uploads.map((entry) => ({ ...entry })) }
      : {}),
  };
}

/** True when the goal with these instructions is longer than a task accepts. */
export const templateGoalTooLong = (goal: string, instructions?: string) =>
  templateRunGoal(goal, instructions).length > COMMAND_TEXT_LIMIT;

/** One line saying why a template cannot start, for refusals and warning rows. */
export function describeTemplateProblem(problem: TemplateProblem): string {
  switch (problem.kind) {
    case "bot_archived":
      return `${problem.name} is archived.`;
    case "model_not_configured":
      return problem.message;
    case "verification_unavailable":
      return "This server does not enforce verification checks, and the template has some.";
  }
}

export type TemplateProblem = z.infer<typeof templateProblemSchema>;
export type TaskTemplate = z.infer<typeof taskTemplateSchema>;
export type CreateTaskTemplateCommand = z.input<
  typeof createTaskTemplateCommandSchema
>;
export type UpdateTaskTemplateCommand = z.input<
  typeof updateTaskTemplateCommandSchema
>;
export type StartTemplateCommand = z.input<typeof startTemplateCommandSchema>;
export type TemplateUnusableDetails = z.infer<
  typeof templateUnusableDetailsSchema
>;
