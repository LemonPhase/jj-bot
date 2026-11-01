// Runtime profiles: a sandbox spec validated by its driver, coding tools and
// budgets. A spec the driver cannot enforce is refused with the driver's own
// message (PROFILE_UNSUPPORTED); nothing is silently downgraded.
import {
  CODING_TOOLS,
  type CreateRuntimeProfileCommand,
  createRuntimeProfileCommandSchema,
  type ModelsView,
  profileBudgetsSchema,
  type RuntimeProfile,
  type RuntimeProfileStatus,
  type SandboxDriverInfo,
  type SandboxSpec,
  type UpdateRuntimeProfileCommand,
  updateRuntimeProfileCommandSchema,
} from "@jj/contracts";
import {
  bots,
  type Executor,
  type RuntimeProfileRow,
  runtimeProfiles,
  type Tx,
} from "@jj/db";
import { asc, eq, sql } from "drizzle-orm";
import type { EngineContext } from "../context";
import { DomainError, errorMessage, notFound, parseCommand } from "../errors";
import { hint } from "../events";
import { profileSettings, toProfile } from "../records";

/** Validates a spec with its driver: PROFILE_UNSUPPORTED with the driver's message on refusal. */
export function validateSpec(ctx: EngineContext, spec: unknown): SandboxSpec {
  const driverId =
    typeof spec === "object" && spec !== null
      ? (spec as { driver?: unknown }).driver
      : undefined;
  const driver =
    typeof driverId === "string" ? ctx.drivers.get(driverId) : undefined;
  if (!driver)
    throw new DomainError(
      "PROFILE_UNSUPPORTED",
      `No sandbox driver "${String(driverId)}" is installed on this server.`,
    );
  try {
    return driver.validateSpec(spec);
  } catch (error) {
    throw new DomainError("PROFILE_UNSUPPORTED", errorMessage(error));
  }
}

export function profileStatus(
  ctx: EngineContext,
  spec: { driver: string },
  infos: readonly SandboxDriverInfo[],
): RuntimeProfileStatus {
  const driver = ctx.drivers.get(spec.driver);
  const info = infos.find((entry) => entry.id === spec.driver);
  if (!driver || !info)
    return {
      driverAvailable: false,
      isolated: false,
      detail: `Sandbox driver "${spec.driver}" is not installed.`,
    };
  return {
    driverAvailable: info.available,
    isolated: driver.capabilities.filesystemIsolation,
    ...(info.detail ? { detail: info.detail } : {}),
  };
}

async function records(
  ctx: EngineContext,
  rows: RuntimeProfileRow[],
): Promise<RuntimeProfile[]> {
  const infos = await ctx.drivers.list();
  return rows.map((row) =>
    toProfile(row, profileStatus(ctx, profileSettings(row).sandbox, infos)),
  );
}

export async function profileRows(exec: Executor) {
  return exec
    .select()
    .from(runtimeProfiles)
    .orderBy(asc(runtimeProfiles.createdAt), asc(runtimeProfiles.id));
}

export async function listProfiles(
  ctx: EngineContext,
): Promise<{ profiles: RuntimeProfile[] }> {
  return { profiles: await records(ctx, await profileRows(ctx.db)) };
}

async function profileRow(exec: Executor, id: string) {
  const [row] = await exec
    .select()
    .from(runtimeProfiles)
    .where(eq(runtimeProfiles.id, id));
  if (!row) throw notFound("Runtime profile", id);
  return row;
}

export async function getProfile(
  ctx: EngineContext,
  id: string,
): Promise<{ profile: RuntimeProfile }> {
  const [profile] = await records(ctx, [await profileRow(ctx.db, id)]);
  return { profile: profile as RuntimeProfile };
}

async function clearDefault(tx: Tx, except: string) {
  await tx
    .update(runtimeProfiles)
    .set({ isDefault: false })
    .where(
      sql`${runtimeProfiles.isDefault} and ${runtimeProfiles.id} <> ${except}`,
    );
}

export async function createProfile(
  ctx: EngineContext,
  input: CreateRuntimeProfileCommand,
): Promise<{ profile: RuntimeProfile }> {
  const command = parseCommand(createRuntimeProfileCommandSchema, input);
  const sandbox = validateSpec(ctx, input.sandbox);
  const id = ctx.ids("runtimeProfile");
  const now = ctx.clock();
  const row = await ctx.db.transaction(async (tx) => {
    if (command.isDefault) await clearDefault(tx, id);
    const [inserted] = await tx
      .insert(runtimeProfiles)
      .values({
        id,
        name: command.name,
        description: command.description ?? "",
        sandbox,
        tools: command.tools ?? [...CODING_TOOLS],
        budgets: command.budgets ?? profileBudgetsSchema.parse({}),
        isDefault: command.isDefault ?? false,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await hint(tx, { type: "profiles.changed" });
    return inserted as RuntimeProfileRow;
  });
  const [profile] = await records(ctx, [row]);
  return { profile: profile as RuntimeProfile };
}

/**
 * Deep-merges the patch onto the stored spec: nested objects field by field,
 * while `network`, `env` and `driverConfig` are replaced whole. Changing the
 * driver drops the old driver's `image` and `driverConfig` unless the patch
 * sets them, since they mean nothing to another driver.
 */
function mergeSpec(
  stored: SandboxSpec,
  patch: NonNullable<UpdateRuntimeProfileCommand["sandbox"]>,
): Record<string, unknown> {
  const switching =
    patch.driver !== undefined && patch.driver !== stored.driver;
  const base = switching
    ? { ...stored, image: undefined, driverConfig: {} }
    : stored;
  const merged: Record<string, unknown> = {
    ...base,
    ...Object.fromEntries(
      Object.entries(patch).filter(([, value]) => value !== undefined),
    ),
    resources: { ...base.resources, ...(patch.resources ?? {}) },
    limits: { ...base.limits, ...(patch.limits ?? {}) },
  };
  if (merged.image === undefined) delete merged.image;
  return merged;
}

export async function updateProfile(
  ctx: EngineContext,
  id: string,
  input: UpdateRuntimeProfileCommand,
): Promise<{ profile: RuntimeProfile }> {
  const command = parseCommand(updateRuntimeProfileCommandSchema, input);
  const current = await profileRow(ctx.db, id);
  const settings = profileSettings(current);
  if (command.isDefault === false && current.isDefault)
    throw new DomainError(
      "CONFLICT",
      "Make another profile the default instead of unsetting this one.",
    );
  const sandbox = command.sandbox
    ? validateSpec(ctx, mergeSpec(settings.sandbox, command.sandbox))
    : settings.sandbox;
  const row = await ctx.db.transaction(async (tx) => {
    if (command.isDefault) await clearDefault(tx, id);
    const [updated] = await tx
      .update(runtimeProfiles)
      .set({
        ...(command.name !== undefined ? { name: command.name } : {}),
        ...(command.description !== undefined
          ? { description: command.description }
          : {}),
        ...(command.tools !== undefined ? { tools: command.tools } : {}),
        ...(command.isDefault !== undefined
          ? { isDefault: command.isDefault }
          : {}),
        sandbox,
        budgets: { ...settings.budgets, ...(command.budgets ?? {}) },
        updatedAt: ctx.clock(),
      })
      .where(eq(runtimeProfiles.id, id))
      .returning();
    if (!updated) throw notFound("Runtime profile", id);
    await hint(tx, { type: "profiles.changed" });
    return updated;
  });
  const [profile] = await records(ctx, [row]);
  return { profile: profile as RuntimeProfile };
}

/** PROFILE_IN_USE while a bot references the profile; the default cannot be deleted. */
export async function deleteProfile(
  ctx: EngineContext,
  id: string,
): Promise<void> {
  await ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(runtimeProfiles)
      .where(eq(runtimeProfiles.id, id))
      .for("update");
    if (!row) throw notFound("Runtime profile", id);
    if (row.isDefault)
      throw new DomainError(
        "CONFLICT",
        "This is the default profile; make another profile the default first.",
      );
    const users = await tx
      .select({ id: bots.id, name: bots.name })
      .from(bots)
      .where(eq(bots.runtimeProfileId, id));
    if (users.length > 0)
      throw new DomainError(
        "PROFILE_IN_USE",
        `Used by ${users.map((user) => user.name).join(", ")}.`,
        { botIds: users.map((user) => user.id) },
      );
    await tx.delete(runtimeProfiles).where(eq(runtimeProfiles.id, id));
    await hint(tx, { type: "profiles.changed" });
  });
}

/** The profile a bot runs with: its own, else the default. */
export async function profileFor(
  exec: Executor,
  profileId: string | null,
): Promise<RuntimeProfileRow | undefined> {
  const [row] = await exec
    .select()
    .from(runtimeProfiles)
    .where(
      profileId
        ? eq(runtimeProfiles.id, profileId)
        : eq(runtimeProfiles.isDefault, true),
    );
  return row;
}

/**
 * On first boot, seeds "Docker sandbox" and "Local (unisolated)" for the
 * drivers this server has. The default is docker when its probe is ok, else
 * local. Concurrent boots serialize on an advisory lock.
 */
export async function seedDefaultProfiles(ctx: EngineContext): Promise<void> {
  const infos = await ctx.drivers.list();
  const candidates = [
    {
      name: "Docker sandbox",
      description: "Each task runs in its own container (isolated).",
      spec: {
        driver: "docker",
        image: "jj-sandbox:base-1",
        network: { mode: "open" },
        workspace: "task",
        resources: { cpus: 2, memoryMb: 2048, processes: 512 },
      },
    },
    {
      name: "Local (unisolated)",
      description:
        "Commands run directly on this machine as the server's user. Not isolated.",
      spec: { driver: "local", network: { mode: "open" }, workspace: "task" },
    },
  ].filter((candidate) => ctx.drivers.get(candidate.spec.driver));
  if (candidates.length === 0) return;
  const dockerOk = infos.some((info) => info.id === "docker" && info.available);
  const defaultDriver = dockerOk
    ? "docker"
    : candidates.some((candidate) => candidate.spec.driver === "local")
      ? "local"
      : candidates[0]?.spec.driver;
  await ctx.db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext('jj-bot:seed-profiles'))`,
    );
    const existing = await tx
      .select({ id: runtimeProfiles.id })
      .from(runtimeProfiles)
      .limit(1);
    if (existing.length > 0) return;
    for (const candidate of candidates) {
      const now = ctx.clock();
      await tx.insert(runtimeProfiles).values({
        id: ctx.ids("runtimeProfile"),
        name: candidate.name,
        description: candidate.description,
        sandbox: validateSpec(ctx, candidate.spec),
        tools: [...CODING_TOOLS],
        budgets: profileBudgetsSchema.parse({}),
        isDefault: candidate.spec.driver === defaultDriver,
        createdAt: now,
        updatedAt: now,
      });
    }
    await hint(tx, { type: "profiles.changed" });
  });
}

export function modelsView(ctx: EngineContext): ModelsView {
  return ctx.models.view();
}
