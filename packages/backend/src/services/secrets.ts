// Settings → Secrets and the stored provider keys: write-only values sealed
// with the server's JJ_SECRET_KEY (see secrets/store.ts). No answer carries a
// value; refusals name the user's secret, never its value, and never which
// server secret a value matches. A model key never becomes a sandbox secret,
// whichever is stored first. A value replaced or removed is retired in the
// same transaction: kept sealed, for redaction alone.
import {
  type ModelsView,
  type ProviderInfo,
  type PutSecretCommand,
  putSecretCommandSchema,
  type SecretInfo,
  type SecretsView,
  secretNameSchema,
  z,
} from "@jj/contracts";
import {
  runtimeProfiles,
  type SecretKind,
  type SecretRow,
  secrets,
  type Tx,
} from "@jj/db";
import { and, eq } from "drizzle-orm";
import type { EngineContext } from "../context";
import { DomainError, notFound, parseCommand } from "../errors";
import { hint } from "../events";
import { MIN_BARE_SECRET_LENGTH, type Secret } from "../redact";
import {
  RETIRED_SECRET_DAYS,
  RETIRED_VALUES_PER_NAME,
  retiredBefore,
} from "../secrets/store";

/**
 * The secret among `secrets` that `value` would carry into a sandbox: one
 * equal to it (a database password of any length included), one it contains
 * or one that contains it ("Bearer <model key>", a line of an .npmrc, a
 * piece of a key). Containment counts only secrets long enough to redact.
 */
export function overlappingSecret(
  value: string,
  secrets: readonly Secret[],
): Secret | undefined {
  return secrets.find(
    (secret) =>
      secret.value.length > 0 &&
      (secret.value === value ||
        (secret.value.length >= MIN_BARE_SECRET_LENGTH &&
          (value.includes(secret.value) || secret.value.includes(value)))),
  );
}

/**
 * The one refusal of a value that holds or is part of a server secret: the
 * same whichever it is, current or retired, so it never says which, nor
 * how the value matched it.
 */
export const SERVER_SECRET_REFUSAL = `it holds, or is part of, a server secret: a model key (the current one, or one of the ${RETIRED_VALUES_PER_NAME} a provider most recently replaced or removed, in the last ${RETIRED_SECRET_DAYS} days), the API token, the database password or JJ_SECRET_KEY. None of them ever enters a sandbox.`;

const NO_KEY =
  "This server has no JJ_SECRET_KEY, so it cannot store keys or secrets. Generate one with `openssl rand -base64 32`, set it as JJ_SECRET_KEY in the server's environment (.env) and restart the server.";

function requireStore(ctx: EngineContext) {
  if (!ctx.secretStore.available)
    throw new DomainError("SECRET_STORE_UNAVAILABLE", NO_KEY);
}

/** A sandbox secret's name from the path: VALIDATION_FAILED when it cannot be one. */
function secretName(raw: string): string {
  const parsed = secretNameSchema.safeParse(raw);
  if (!parsed.success)
    throw new DomainError(
      "VALIDATION_FAILED",
      `name: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
      parsed.error.issues,
    );
  return parsed.data;
}

const rowOf = (ctx: EngineContext, kind: SecretKind, name: string) =>
  and(
    eq(secrets.ownerId, ctx.secretStore.owner),
    eq(secrets.kind, kind),
    eq(secrets.name, name),
  );

/**
 * Keeps the value of `row`, which `replacement` (none: removal) takes the
 * place of, as a retired value: what a task wrote or printed with it while
 * it was current is still redacted once no sandbox holds it any more. Values
 * retired longer ago than the retention period are deleted on the way.
 */
async function retire(
  ctx: EngineContext,
  tx: Tx,
  row: SecretRow,
  replacement?: string,
): Promise<void> {
  const now = ctx.clock();
  await ctx.secretStore.purgeRetired(retiredBefore(now), tx);
  await ctx.secretStore.retire(
    tx,
    row,
    now,
    ctx.ids("retiredSecret"),
    replacement,
  );
}

/**
 * What no sandbox value may hold or be part of: the server's own secrets,
 * the stored provider keys, and those replaced or removed in the last 90
 * days, which may not be revoked yet.
 */
async function serverValues(ctx: EngineContext): Promise<Secret[]> {
  return [
    ...(await ctx.serverSecrets()),
    ...ctx.secretStore.values("provider"),
    ...ctx.secretStore.retiredValues("provider"),
  ];
}

/** Stores `value` under (kind, name), replacing what is there. True when it is new. */
async function upsert(
  ctx: EngineContext,
  tx: Tx,
  kind: SecretKind,
  name: string,
  value: string,
): Promise<boolean> {
  const sealed = ctx.secretStore.seal(kind, name, value);
  const now = ctx.clock();
  const [existing] = await tx
    .select()
    .from(secrets)
    .where(rowOf(ctx, kind, name))
    .for("update");
  const columns = {
    keyId: sealed.keyId,
    nonce: sealed.nonce,
    ciphertext: sealed.ciphertext,
    hint: sealed.hint,
    updatedAt: now,
  };
  await tx
    .insert(secrets)
    .values({
      ownerId: ctx.secretStore.owner,
      kind,
      name,
      ...columns,
      createdAt: now,
    })
    .onConflictDoUpdate({
      target: [secrets.ownerId, secrets.kind, secrets.name],
      set: columns,
    });
  if (existing) await retire(ctx, tx, existing, value);
  await hint(tx, { type: "secrets.changed" });
  return !existing;
}

/** `GET /api/secrets`. */
export async function listSecrets(ctx: EngineContext): Promise<SecretsView> {
  await ctx.secretStore.refresh();
  return {
    available: ctx.secretStore.available,
    secrets: ctx.secretStore.sandboxSecrets(),
  };
}

/**
 * `PUT /api/secrets/:name`. Refuses a value that holds or is part of a
 * server secret (a model key, the API token, the master key): those never
 * enter a sandbox. The refusal never names the secret.
 */
export async function putSecret(
  ctx: EngineContext,
  rawName: string,
  input: PutSecretCommand,
): Promise<{ secret: SecretInfo; created: boolean }> {
  const name = secretName(rawName);
  const { value } = parseCommand(putSecretCommandSchema, input);
  requireStore(ctx);
  await ctx.secretStore.refresh();
  if (overlappingSecret(value, await serverValues(ctx)))
    throw new DomainError(
      "VALIDATION_FAILED",
      `value: ${SERVER_SECRET_REFUSAL}`,
    );
  const created = await ctx.db.transaction((tx) =>
    upsert(ctx, tx, "sandbox", name, value),
  );
  await ctx.secretStore.refresh();
  const secret = ctx.secretStore
    .sandboxSecrets()
    .find((entry) => entry.name === name);
  if (!secret) throw notFound("Secret", name);
  return { secret, created };
}

/**
 * `DELETE /api/secrets/:name`: removes the secret and, in the same
 * transaction, every profile's grant of it. Its value is retired.
 */
export async function deleteSecret(
  ctx: EngineContext,
  rawName: string,
): Promise<void> {
  const name = secretName(rawName);
  await ctx.db.transaction(async (tx) => {
    const deleted = await tx
      .delete(secrets)
      .where(rowOf(ctx, "sandbox", name))
      .returning();
    if (deleted.length === 0) throw notFound("Secret", name);
    for (const row of deleted) await retire(ctx, tx, row);
    const profiles = await tx
      .select({ id: runtimeProfiles.id, secrets: runtimeProfiles.secrets })
      .from(runtimeProfiles);
    const granting = profiles.filter(
      (profile) =>
        Array.isArray(profile.secrets) && profile.secrets.includes(name),
    );
    for (const profile of granting)
      await tx
        .update(runtimeProfiles)
        .set({
          secrets: profile.secrets.filter((granted) => granted !== name),
          updatedAt: ctx.clock(),
        })
        .where(eq(runtimeProfiles.id, profile.id));
    await hint(tx, { type: "secrets.changed" });
    if (granting.length > 0) await hint(tx, { type: "profiles.changed" });
  });
  await ctx.secretStore.refresh();
}

/** `GET /api/models`, with stored keys as they are now. */
export async function modelsView(ctx: EngineContext): Promise<ModelsView> {
  await ctx.secretStore.refresh();
  return ctx.models.view();
}

/** A provider that takes a key: NOT_FOUND for an unknown or keyless one. */
function keyedProvider(ctx: EngineContext, providerId: string): ProviderInfo {
  const provider = ctx.models
    .providers()
    .find((candidate) => candidate.id === providerId);
  if (!provider || provider.envVars.length === 0)
    throw new DomainError(
      "NOT_FOUND",
      `No model provider "${providerId}" takes a key on this server.`,
    );
  return provider;
}

const providerIdSchema = z.string().min(1).max(64);

/**
 * `PUT /api/models/providers/:providerId/key`. The server's variable wins, so
 * a provider it configures refuses a stored key (CONFLICT).
 */
export async function putProviderKey(
  ctx: EngineContext,
  providerId: string,
  input: PutSecretCommand,
): Promise<ModelsView> {
  const id = parseCommand(providerIdSchema, providerId);
  const { value } = parseCommand(putSecretCommandSchema, input);
  await ctx.secretStore.refresh();
  const provider = keyedProvider(ctx, id);
  requireStore(ctx);
  if (provider.keySource === "env")
    throw new DomainError(
      "CONFLICT",
      `${provider.name} is configured by ${provider.envVars.join(" or ")} on the server, which takes precedence over a stored key. Unset it on the server to manage this key here.`,
    );
  const sandbox = ctx.secretStore
    .values("sandbox")
    .find((secret) => overlappingSecret(secret.value, [{ ...secret, value }]));
  if (sandbox)
    throw new DomainError(
      "VALIDATION_FAILED",
      `value: it holds, or is part of, ${sandbox.name}, which sandboxes can be granted. A model key never enters a sandbox: store another value there first.`,
    );
  await ctx.db.transaction((tx) => upsert(ctx, tx, "provider", id, value));
  return modelsView(ctx);
}

/** `DELETE /api/models/providers/:providerId/key`. Its value is retired. */
export async function deleteProviderKey(
  ctx: EngineContext,
  providerId: string,
): Promise<ModelsView> {
  const id = parseCommand(providerIdSchema, providerId);
  const provider = keyedProvider(ctx, id);
  await ctx.db.transaction(async (tx) => {
    const deleted = await tx
      .delete(secrets)
      .where(rowOf(ctx, "provider", id))
      .returning();
    if (deleted.length === 0)
      throw new DomainError(
        "NOT_FOUND",
        `No key is stored for ${provider.name}.`,
      );
    for (const row of deleted) await retire(ctx, tx, row);
    await hint(tx, { type: "secrets.changed" });
  });
  return modelsView(ctx);
}

/**
 * The values a sandbox acquired with this profile receives: its granted
 * secrets. Throws, naming the secret, when one cannot be used, so the run
 * fails visibly instead of running without it.
 */
export async function grantedSecrets(
  ctx: EngineContext,
  profile: { name: string; secrets: readonly string[] },
): Promise<Record<string, string>> {
  if (profile.secrets.length === 0) return {};
  const { values, missing, unreadable } = await ctx.secretStore.sandboxValues(
    profile.secrets,
  );
  const label = `Runtime profile "${profile.name}" grants`;
  const list = (names: string[]) => names.join(", ");
  if (missing.length > 0)
    throw new Error(
      `${label} ${list(missing)}, which ${missing.length === 1 ? "is" : "are"} not stored. Store ${missing.length === 1 ? "it" : "them"} in Settings → Secrets, or remove the grant.`,
    );
  if (unreadable.length > 0)
    throw new Error(
      `${label} ${list(unreadable)}, which ${
        ctx.secretStore.available
          ? "the current JJ_SECRET_KEY cannot decrypt"
          : "cannot be read: JJ_SECRET_KEY is not set"
      }. Store ${unreadable.length === 1 ? "it" : "them"} again in Settings → Secrets, or remove the grant.`,
    );
  await ctx.secretStore.refresh();
  const server = await serverValues(ctx);
  for (const [name, value] of Object.entries(values))
    if (overlappingSecret(value, server))
      throw new Error(
        `The sandbox secret ${name} cannot be used: ${SERVER_SECRET_REFUSAL} Store another value for ${name}.`,
      );
  return values;
}
