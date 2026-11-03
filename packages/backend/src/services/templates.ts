// Task templates: saved task setups the user starts again. A start builds
// the create-task command from the template (`templateTaskCommand`) and
// creates the task through `createTask`, the path `POST /api/tasks` takes, so
// a started task is the manual task with those fields and its `templateId`.
// Problems (an archived bot, a model that cannot run, plans this build does
// not enforce) are derived on every read and refuse a start before anything
// is written. Templates are the user's: no agent tool reads or starts them.
import {
  COMMAND_TEXT_LIMIT,
  type CreateTaskTemplateCommand,
  createTaskTemplateCommandSchema,
  describeTemplateProblem,
  MAX_TASK_TEMPLATES,
  PROFILE_SPEND_CAP,
  type StartTemplateCommand,
  startTemplateCommandSchema,
  type Task,
  type TaskTemplate,
  type TemplateProblem,
  templateGoalTooLong,
  templateRunGoal,
  templateTaskCommand,
  type UpdateTaskTemplateCommand,
  updateTaskTemplateCommandSchema,
  withCoordinator,
} from "@jj/contracts";
import {
  type BotRow,
  bots,
  type Executor,
  type TaskTemplateRow,
  type Tx,
  taskTemplates,
} from "@jj/db";
import { asc, count, eq, inArray, sql } from "drizzle-orm";
import type { EngineContext } from "../context";
import { DomainError, errorMessage, notFound, parseCommand } from "../errors";
import { hint } from "../events";
import { participantOrder, planOf, toTaskTemplate } from "../records";
import { createTask } from "./tasks";
import { VERIFICATION_ENFORCED } from "./verification";

type BotFacts = Pick<BotRow, "id" | "name" | "model" | "archivedAt">;

/** What keeps a template from starting now, in roster order; empty when it can. */
export function templateProblems(
  ctx: EngineContext,
  row: Pick<TaskTemplateRow, "participantBotIds" | "verificationPlan">,
  known: ReadonlyMap<string, BotFacts>,
): TemplateProblem[] {
  const problems: TemplateProblem[] = [];
  for (const botId of row.participantBotIds) {
    const bot = known.get(botId);
    // Bots are archived, never deleted; a missing row reads as archived.
    if (!bot || bot.archivedAt) {
      problems.push({ kind: "bot_archived", botId, name: bot?.name ?? botId });
      continue;
    }
    try {
      ctx.models.resolve(bot.model);
    } catch (error) {
      problems.push({
        kind: "model_not_configured",
        botId,
        message: `${bot.name} cannot run: ${errorMessage(error)}`,
      });
    }
  }
  if (planOf(row.verificationPlan) && !VERIFICATION_ENFORCED)
    problems.push({ kind: "verification_unavailable" });
  return problems;
}

async function withProblems(
  ctx: EngineContext,
  exec: Executor,
  rows: TaskTemplateRow[],
): Promise<TaskTemplate[]> {
  const ids = [...new Set(rows.flatMap((row) => row.participantBotIds))];
  const found =
    ids.length === 0
      ? []
      : await exec
          .select({
            id: bots.id,
            name: bots.name,
            model: bots.model,
            archivedAt: bots.archivedAt,
          })
          .from(bots)
          .where(inArray(bots.id, ids));
  const known = new Map(found.map((bot) => [bot.id, bot]));
  return rows.map((row) =>
    toTaskTemplate(row, templateProblems(ctx, row, known)),
  );
}

async function templateRow(
  exec: Executor,
  templateId: string,
  lock = false,
): Promise<TaskTemplateRow> {
  const query = exec
    .select()
    .from(taskTemplates)
    .where(eq(taskTemplates.id, templateId));
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw notFound("Task template", templateId);
  return row;
}

/** VALIDATION_FAILED for an unknown or archived bot, as task creation answers. */
async function assertActiveBots(tx: Tx, botIds: readonly string[]) {
  const found = await tx
    .select({ id: bots.id, archivedAt: bots.archivedAt })
    .from(bots)
    .where(inArray(bots.id, [...botIds]));
  const missing = botIds.filter(
    (id) => !found.some((bot) => bot.id === id && !bot.archivedAt),
  );
  if (missing.length > 0)
    throw new DomainError(
      "VALIDATION_FAILED",
      `Unknown bot: ${missing.join(", ")}.`,
      { botIds: missing },
    );
}

/** The stored cap columns for a command's `spendCapUsd` (omitted: the profile's at start). */
const capColumns = (spendCapUsd: number | null | undefined) =>
  spendCapUsd === undefined
    ? { spendCapUsd: null, spendCapInherit: true }
    : { spendCapUsd, spendCapInherit: false };

/** `GET /api/task-templates`, oldest first. */
export async function listTemplates(
  ctx: EngineContext,
): Promise<{ templates: TaskTemplate[] }> {
  const rows = await ctx.db
    .select()
    .from(taskTemplates)
    .orderBy(asc(taskTemplates.createdAt), asc(taskTemplates.id));
  return { templates: await withProblems(ctx, ctx.db, rows) };
}

/** `GET /api/task-templates/:id`. */
export async function getTemplate(
  ctx: EngineContext,
  templateId: string,
): Promise<{ template: TaskTemplate }> {
  const row = await templateRow(ctx.db, templateId);
  const [template] = await withProblems(ctx, ctx.db, [row]);
  return { template: template as TaskTemplate };
}

/** `POST /api/task-templates`: CONFLICT past MAX_TASK_TEMPLATES. */
export async function createTemplate(
  ctx: EngineContext,
  input: CreateTaskTemplateCommand,
): Promise<{ template: TaskTemplate }> {
  const command = parseCommand(createTaskTemplateCommandSchema, input);
  const row = await ctx.db.transaction(async (tx) => {
    // Concurrent saves count one at a time, so the limit holds.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('jj-bot:task-templates'))`,
    );
    await assertActiveBots(tx, command.participantBotIds);
    const [stored] = await tx.select({ value: count() }).from(taskTemplates);
    if ((stored?.value ?? 0) >= MAX_TASK_TEMPLATES)
      throw new DomainError(
        "CONFLICT",
        `This server keeps at most ${MAX_TASK_TEMPLATES} task templates; delete one before saving another.`,
        { limit: MAX_TASK_TEMPLATES },
      );
    const now = ctx.clock();
    const [inserted] = await tx
      .insert(taskTemplates)
      .values({
        id: ctx.ids("template"),
        title: command.title,
        goal: command.goal,
        coordinatorBotId: command.coordinatorBotId,
        participantBotIds: participantOrder(
          command.coordinatorBotId,
          command.participantBotIds,
        ),
        verificationPlan: command.verificationPlan ?? null,
        ...capColumns(command.spendCapUsd),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    if (!inserted) throw new Error("The template insert returned no row.");
    await hint(tx, { type: "templates.changed" });
    return inserted;
  });
  const [template] = await withProblems(ctx, ctx.db, [row]);
  return { template: template as TaskTemplate };
}

/**
 * `PATCH /api/task-templates/:id`: the patch merged onto the stored
 * template, the participants replaced whole (the coordinator added when
 * missing), and the result checked as a save.
 */
export async function updateTemplate(
  ctx: EngineContext,
  templateId: string,
  input: UpdateTaskTemplateCommand,
): Promise<{ template: TaskTemplate }> {
  const command = parseCommand(updateTaskTemplateCommandSchema, input);
  const row = await ctx.db.transaction(async (tx) => {
    const current = await templateRow(tx, templateId, true);
    const roster = withCoordinator({
      coordinatorBotId: command.coordinatorBotId ?? current.coordinatorBotId,
      participantBotIds: command.participantBotIds ?? current.participantBotIds,
    });
    await assertActiveBots(tx, roster.participantBotIds);
    const cap =
      command.spendCapUsd === undefined
        ? {}
        : capColumns(
            command.spendCapUsd === PROFILE_SPEND_CAP
              ? undefined
              : command.spendCapUsd,
          );
    const [updated] = await tx
      .update(taskTemplates)
      .set({
        ...(command.title !== undefined ? { title: command.title } : {}),
        ...(command.goal !== undefined ? { goal: command.goal } : {}),
        ...(command.verificationPlan !== undefined
          ? { verificationPlan: command.verificationPlan }
          : {}),
        coordinatorBotId: roster.coordinatorBotId,
        participantBotIds: participantOrder(
          roster.coordinatorBotId,
          roster.participantBotIds,
        ),
        ...cap,
        updatedAt: ctx.clock(),
      })
      .where(eq(taskTemplates.id, templateId))
      .returning();
    if (!updated) throw notFound("Task template", templateId);
    await hint(tx, { type: "templates.changed" });
    return updated;
  });
  const [template] = await withProblems(ctx, ctx.db, [row]);
  return { template: template as TaskTemplate };
}

/** `DELETE /api/task-templates/:id`. Tasks started from it keep their `templateId`. */
export async function deleteTemplate(
  ctx: EngineContext,
  templateId: string,
): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const [deleted] = await tx
      .delete(taskTemplates)
      .where(eq(taskTemplates.id, templateId))
      .returning({ id: taskTemplates.id });
    if (!deleted) throw notFound("Task template", templateId);
    await hint(tx, { type: "templates.changed" });
  });
}

/**
 * `POST /api/task-templates/:id/tasks`. Refused before anything is written
 * while the template has problems (TEMPLATE_UNUSABLE) or the goal with the
 * instructions is over the task limit (422); otherwise the task is created as
 * `createTask` creates it, which checks the bots, their models and the caps
 * again. A bot archived, or a model lost, between the two checks still
 * answers TEMPLATE_UNUSABLE: a refusal of `createTask` is read against the
 * problems derived again then.
 */
export async function startTemplate(
  ctx: EngineContext,
  templateId: string,
  input: StartTemplateCommand,
): Promise<{ task: Task }> {
  const command = parseCommand(startTemplateCommandSchema, input);
  const row = await templateRow(ctx.db, templateId);
  const template = await usableTemplate(ctx, row);
  if (templateGoalTooLong(template.goal, command.instructions)) {
    const length = templateRunGoal(template.goal, command.instructions).length;
    throw new DomainError(
      "VALIDATION_FAILED",
      `instructions: the goal with these instructions is ${length} characters, over the ${COMMAND_TEXT_LIMIT} a task takes; shorten them.`,
      { length, limit: COMMAND_TEXT_LIMIT },
      422,
    );
  }
  try {
    return await createTask(ctx, templateTaskCommand(template, command), {
      templateId: template.id,
    });
  } catch (error) {
    // The bots or models changed since the check: say why as a template's problems.
    if (
      error instanceof DomainError &&
      (error.code === "VALIDATION_FAILED" ||
        error.code === "MODEL_NOT_CONFIGURED")
    )
      await usableTemplate(ctx, row);
    throw error;
  }
}

/** The template with its problems now; TEMPLATE_UNUSABLE when it has any. */
async function usableTemplate(
  ctx: EngineContext,
  row: TaskTemplateRow,
): Promise<TaskTemplate> {
  const [template] = await withProblems(ctx, ctx.db, [row]);
  if (!template) throw notFound("Task template", row.id);
  if (template.problems.length > 0)
    throw new DomainError(
      "TEMPLATE_UNUSABLE",
      `"${template.title}" cannot start: ${template.problems
        .map(describeTemplateProblem)
        .join(" ")}`,
      { problems: template.problems },
    );
  return template;
}
