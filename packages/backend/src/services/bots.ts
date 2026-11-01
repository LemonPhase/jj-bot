// Bots, their memory and presence. Presence is derived: a bot is working while
// it has a queued or running session; its active tasks are the unfinished
// tasks it participates in.
import {
  type Bot,
  type BotMemory,
  type CreateBotCommand,
  createBotCommandSchema,
  defaultAppearanceFor,
  FINISHED_TASK_STATUSES,
  type UpdateBotCommand,
  type UpdateBotMemoryCommand,
  updateBotCommandSchema,
  updateBotMemoryCommandSchema,
} from "@jj/contracts";
import {
  type BotRow,
  botMemory,
  bots,
  type Executor,
  runtimeProfiles,
  sessions,
  taskParticipants,
  tasks,
} from "@jj/db";
import { and, asc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import type { EngineContext } from "../context";
import {
  DomainError,
  isUniqueViolation,
  notFound,
  parseCommand,
} from "../errors";
import { hint } from "../events";
import { type Presence, toBot } from "../records";
import { assertModel } from "./tasks";

/** Presence for the given bots (all bots when omitted). */
export async function presenceOf(
  exec: Executor,
  botIds: readonly string[],
): Promise<Map<string, Presence>> {
  const result = new Map<string, Presence>(
    botIds.map((id) => [id, { working: false, activeTaskIds: [] }]),
  );
  if (botIds.length === 0) return result;
  const working = await exec
    .selectDistinct({ botId: sessions.botId })
    .from(sessions)
    .where(
      and(
        inArray(sessions.botId, [...botIds]),
        inArray(sessions.status, ["queued", "running"]),
      ),
    );
  for (const row of working) {
    const entry = result.get(row.botId);
    if (entry) entry.working = true;
  }
  const active = await exec
    .select({ botId: taskParticipants.botId, taskId: taskParticipants.taskId })
    .from(taskParticipants)
    .innerJoin(tasks, eq(tasks.id, taskParticipants.taskId))
    .where(
      and(
        inArray(taskParticipants.botId, [...botIds]),
        notInArray(tasks.status, [...FINISHED_TASK_STATUSES]),
      ),
    )
    .orderBy(asc(tasks.createdAt), asc(tasks.id));
  for (const row of active)
    result.get(row.botId)?.activeTaskIds.push(row.taskId);
  return result;
}

export async function activeBotRows(exec: Executor): Promise<BotRow[]> {
  return exec
    .select()
    .from(bots)
    .where(isNull(bots.archivedAt))
    .orderBy(asc(bots.createdAt), asc(bots.id));
}

export async function listBots(ctx: EngineContext): Promise<{ bots: Bot[] }> {
  const rows = await activeBotRows(ctx.db);
  const presence = await presenceOf(
    ctx.db,
    rows.map((row) => row.id),
  );
  return {
    bots: rows.map((row) => toBot(row, presence.get(row.id) as Presence)),
  };
}

/** An active (not archived) bot row, or NOT_FOUND. */
export async function activeBot(
  exec: Executor,
  botId: string,
): Promise<BotRow> {
  const [row] = await exec
    .select()
    .from(bots)
    .where(and(eq(bots.id, botId), isNull(bots.archivedAt)));
  if (!row) throw notFound("Bot", botId);
  return row;
}

async function botRecord(exec: Executor, row: BotRow): Promise<Bot> {
  const presence = await presenceOf(exec, [row.id]);
  return toBot(row, presence.get(row.id) as Presence);
}

export async function getBot(
  ctx: EngineContext,
  botId: string,
): Promise<{ bot: Bot }> {
  return { bot: await botRecord(ctx.db, await activeBot(ctx.db, botId)) };
}

async function assertProfile(exec: Executor, profileId: string | null) {
  if (!profileId) return;
  const [row] = await exec
    .select({ id: runtimeProfiles.id })
    .from(runtimeProfiles)
    .where(eq(runtimeProfiles.id, profileId));
  if (!row)
    throw new DomainError(
      "VALIDATION_FAILED",
      `Runtime profile ${profileId} does not exist.`,
    );
}

const nameTaken = (name: string) =>
  new DomainError("CONFLICT", `A bot named ${name} already exists.`);

export async function createBot(
  ctx: EngineContext,
  input: CreateBotCommand,
): Promise<{ bot: Bot }> {
  const command = parseCommand(createBotCommandSchema, input);
  const model = command.model ?? null;
  if (model) assertModel(ctx, { name: command.name, model });
  await assertProfile(ctx.db, command.runtimeProfileId ?? null);
  const now = ctx.clock();
  try {
    const row = await ctx.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(bots)
        .values({
          id: ctx.ids("bot"),
          name: command.name,
          role: command.role ?? "",
          instructions: command.instructions ?? "",
          model,
          runtimeProfileId: command.runtimeProfileId ?? null,
          appearance: command.appearance ?? defaultAppearanceFor(command.name),
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      if (!inserted) throw new Error("The bot insert returned no row.");
      await hint(tx, { type: "bots.changed", botId: inserted.id });
      return inserted;
    });
    return { bot: await botRecord(ctx.db, row) };
  } catch (error) {
    if (isUniqueViolation(error)) throw nameTaken(command.name);
    throw error;
  }
}

export async function updateBot(
  ctx: EngineContext,
  botId: string,
  input: UpdateBotCommand,
): Promise<{ bot: Bot }> {
  const command = parseCommand(updateBotCommandSchema, input);
  const current = await activeBot(ctx.db, botId);
  if (command.model)
    assertModel(ctx, {
      name: command.name ?? current.name,
      model: command.model,
    });
  if (command.runtimeProfileId !== undefined)
    await assertProfile(ctx.db, command.runtimeProfileId);
  try {
    const row = await ctx.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(bots)
        .set({
          ...(command.name !== undefined ? { name: command.name } : {}),
          ...(command.role !== undefined ? { role: command.role } : {}),
          ...(command.instructions !== undefined
            ? { instructions: command.instructions }
            : {}),
          ...(command.model !== undefined ? { model: command.model } : {}),
          ...(command.runtimeProfileId !== undefined
            ? { runtimeProfileId: command.runtimeProfileId }
            : {}),
          ...(command.appearance !== undefined
            ? { appearance: command.appearance }
            : {}),
          updatedAt: ctx.clock(),
        })
        .where(and(eq(bots.id, botId), isNull(bots.archivedAt)))
        .returning();
      if (!updated) throw notFound("Bot", botId);
      await hint(tx, { type: "bots.changed", botId });
      return updated;
    });
    return { bot: await botRecord(ctx.db, row) };
  } catch (error) {
    if (isUniqueViolation(error)) throw nameTaken(command.name ?? "");
    throw error;
  }
}

/** `DELETE /api/bots/:id`: archives. Refused with CONFLICT while the bot has active tasks. */
export async function archiveBot(
  ctx: EngineContext,
  botId: string,
): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(bots)
      .where(and(eq(bots.id, botId), isNull(bots.archivedAt)))
      .for("update");
    if (!row) throw notFound("Bot", botId);
    const presence = await presenceOf(tx, [botId]);
    const active = presence.get(botId)?.activeTaskIds ?? [];
    if (active.length > 0)
      throw new DomainError(
        "CONFLICT",
        `${row.name} still takes part in ${active.length} unfinished task(s); stop or finish them first.`,
        { activeTaskIds: active },
      );
    await tx
      .update(bots)
      .set({ archivedAt: ctx.clock(), updatedAt: ctx.clock() })
      .where(eq(bots.id, botId));
    await hint(tx, { type: "bots.changed", botId });
  });
}

export async function memoryText(exec: Executor, botId: string) {
  const [row] = await exec
    .select()
    .from(botMemory)
    .where(eq(botMemory.botId, botId));
  return row;
}

export async function getMemory(
  ctx: EngineContext,
  botId: string,
): Promise<BotMemory> {
  const bot = await activeBot(ctx.db, botId);
  const row = await memoryText(ctx.db, botId);
  return {
    botId,
    text: row?.text ?? "",
    updatedAt: (row?.updatedAt ?? bot.createdAt).toISOString(),
  };
}

export async function putMemory(
  ctx: EngineContext,
  botId: string,
  input: UpdateBotMemoryCommand,
): Promise<BotMemory> {
  const command = parseCommand(updateBotMemoryCommandSchema, input);
  await activeBot(ctx.db, botId);
  const now = ctx.clock();
  const row = await ctx.db.transaction(async (tx) => {
    const [saved] = await tx
      .insert(botMemory)
      .values({ botId, text: command.text, updatedAt: now })
      .onConflictDoUpdate({
        target: botMemory.botId,
        set: { text: command.text, updatedAt: now },
      })
      .returning();
    await hint(tx, { type: "bots.changed", botId });
    return saved;
  });
  return {
    botId,
    text: row?.text ?? command.text,
    updatedAt: (row?.updatedAt ?? now).toISOString(),
  };
}
