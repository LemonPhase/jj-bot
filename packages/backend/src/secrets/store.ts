// The secrets store: values entered through settings, kept encrypted in the
// `secrets` table. Provider keys are named by provider id, sandbox secrets by
// the variable they become. This module holds what every process reads: a
// snapshot of the decrypted rows, reloaded with `refresh()` (each run and
// chat reply builds its redactor through it, so a standalone worker sees
// writes the API made), and what writes go through: sealing a value for its
// row. No value ever leaves it except to the model registry (provider keys)
// and to sandbox acquisition (granted secrets). Replaced and removed values
// are kept as well, retired (`retired_secrets`), for redaction alone.
import type { SecretInfo } from "@jj/contracts";
import {
  type Executor,
  LOCAL_OWNER,
  type RetiredSecretRow,
  retiredSecrets,
  type SecretKind,
  type SecretRow,
  secrets,
} from "@jj/db";
import { and, eq, inArray, lt } from "drizzle-orm";
import type { Logger } from "../context";
import type { Secret } from "../redact";
import type { Keyring, Sealed } from "./keyring";

/** A stored provider key as the model registry reads it. */
export interface StoredProviderKey {
  /** Undefined when the current `JJ_SECRET_KEY` cannot decrypt it. */
  value: string | undefined;
  hint: string;
  updatedAt: string;
}

interface Entry {
  kind: SecretKind;
  name: string;
  value: string | undefined;
  hint: string;
  keyId: string;
  createdAt: Date;
  updatedAt: Date;
  /** Changes whenever the row is sealed again; decrypting is skipped while it holds. */
  stamp: string;
}

/** A retired value as the snapshot keeps it. */
interface RetiredEntry {
  kind: SecretKind;
  name: string;
  value: string | undefined;
  stamp: string;
}

/**
 * How long a replaced or removed value is still redacted. Long enough to
 * outlive the sandboxes and the work of the tasks that ran with it and the
 * time a rotated credential takes to be revoked where it was issued; after
 * that its plaintext is no longer a credential worth hiding.
 */
export const RETIRED_SECRET_DAYS = 90;
const RETIRED_SECRET_MS = RETIRED_SECRET_DAYS * 24 * 60 * 60 * 1000;

/** Retired values older than this, at `now`, are deleted. */
export const retiredBefore = (now: Date) =>
  new Date(now.getTime() - RETIRED_SECRET_MS);

/** The value's last four characters, shown in settings in place of the value. */
export const secretHint = (value: string) => value.slice(-4);

const entryKey = (kind: SecretKind, name: string) => `${kind}:${name}`;

const stampOf = (row: SecretRow) =>
  `${row.keyId}:${row.updatedAt.getTime()}:${Buffer.from(row.nonce).toString("hex")}`;

const retiredStampOf = (row: RetiredSecretRow) =>
  `${row.keyId}:${Buffer.from(row.nonce).toString("hex")}`;

/** The columns of a `secrets` row that seal its value. */
export type SealedSecret = Pick<
  SecretRow,
  "kind" | "name" | "keyId" | "nonce" | "ciphertext"
>;

export interface SecretStoreOptions {
  db: Executor;
  /** Undefined without `JJ_SECRET_KEY`: nothing can be stored or read. */
  keyring?: Keyring;
  owner?: string;
}

export class SecretStore {
  private entries = new Map<string, Entry>();
  /** Retired values by row id. */
  private retired = new Map<string, RetiredEntry>();
  /** Refreshes started, and the newest whose read has been applied. */
  private started = 0;
  private applied = 0;
  private readonly db: Executor;
  /** Whose rows these are (`secrets.owner_id`). */
  readonly owner: string;
  readonly keyring: Keyring | undefined;

  constructor(options: SecretStoreOptions) {
    this.db = options.db;
    this.keyring = options.keyring;
    this.owner = options.owner ?? LOCAL_OWNER;
  }

  /** Values can be stored: the server has a master key. */
  get available(): boolean {
    return this.keyring !== undefined;
  }

  /** Associated data that binds a ciphertext to its row. */
  private aad(kind: SecretKind, name: string): string {
    return `jj-bot/secret/v1\u0000${this.owner}\u0000${kind}\u0000${name}`;
  }

  /**
   * Associated data of a retired value: another table's, so a retired
   * ciphertext opens as nothing else, and never as a current value.
   */
  private retiredAad(kind: SecretKind, name: string): string {
    return `jj-bot/retired-secret/v1\u0000${this.owner}\u0000${kind}\u0000${name}`;
  }

  private open(row: SealedSecret): string | undefined {
    return this.keyring?.open(
      { keyId: row.keyId, nonce: row.nonce, ciphertext: row.ciphertext },
      this.aad(row.kind, row.name),
    );
  }

  private openRetired(row: SealedSecret): string | undefined {
    return this.keyring?.open(
      { keyId: row.keyId, nonce: row.nonce, ciphertext: row.ciphertext },
      this.retiredAad(row.kind, row.name),
    );
  }

  /**
   * Whether a configured key opens a stored row, however the caller read it
   * (the data check reads rows of any schema version with raw SQL).
   */
  opens(row: SealedSecret): boolean {
    return this.open(row) !== undefined;
  }

  /** `opens` for a row of `retired_secrets`. */
  opensRetired(row: SealedSecret): boolean {
    return (
      this.keyring?.open(
        { keyId: row.keyId, nonce: row.nonce, ciphertext: row.ciphertext },
        this.retiredAad(row.kind, row.name),
      ) !== undefined
    );
  }

  /** The columns a value is stored as. Throws without a master key. */
  seal(
    kind: SecretKind,
    name: string,
    value: string,
  ): Sealed & { hint: string } {
    if (!this.keyring) throw new Error("No JJ_SECRET_KEY is configured.");
    return {
      ...this.keyring.seal(value, this.aad(kind, name)),
      hint: secretHint(value),
    };
  }

  /**
   * Retires `row`'s value once `replacement` (none when it is removed)
   * takes its place: sealed again into `retired_secrets`, bound to that
   * table, retired `at`. A name keeps one row per value: retiring a value
   * it already holds moves that row's time instead. Nothing is kept when the
   * value is unchanged, or no configured key opens it, so it was redacted
   * nowhere anyway.
   */
  async retire(
    exec: Executor,
    row: SecretRow,
    at: Date,
    id: string,
    replacement?: string,
  ): Promise<void> {
    const keyring = this.keyring;
    const value = this.open(row);
    if (!keyring || value === undefined || value === replacement) return;
    const earlier = await exec
      .select()
      .from(retiredSecrets)
      .where(
        and(
          eq(retiredSecrets.ownerId, row.ownerId),
          eq(retiredSecrets.kind, row.kind),
          eq(retiredSecrets.name, row.name),
        ),
      );
    const [same, ...duplicates] = earlier.filter(
      (retired) => this.openRetired(retired) === value,
    );
    if (same) {
      await exec
        .update(retiredSecrets)
        .set({ retiredAt: at })
        .where(eq(retiredSecrets.id, same.id));
      if (duplicates.length > 0)
        await exec.delete(retiredSecrets).where(
          inArray(
            retiredSecrets.id,
            duplicates.map((duplicate) => duplicate.id),
          ),
        );
      return;
    }
    const sealed = keyring.seal(value, this.retiredAad(row.kind, row.name));
    await exec.insert(retiredSecrets).values({
      id,
      ownerId: row.ownerId,
      kind: row.kind,
      name: row.name,
      keyId: sealed.keyId,
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext,
      retiredAt: at,
    });
  }

  /** Deletes the values retired before `before`. */
  async purgeRetired(before: Date, exec: Executor = this.db): Promise<number> {
    const deleted = await exec
      .delete(retiredSecrets)
      .where(
        and(
          eq(retiredSecrets.ownerId, this.owner),
          lt(retiredSecrets.retiredAt, before),
        ),
      )
      .returning({ id: retiredSecrets.id });
    return deleted.length;
  }

  /**
   * Reads every stored row again, the retired ones included, decrypting only
   * those that changed. A read that finishes after a later-started one has
   * been applied is dropped, so an older snapshot never replaces a newer one.
   */
  async refresh(exec: Executor = this.db): Promise<void> {
    const generation = ++this.started;
    const rows = await exec
      .select()
      .from(secrets)
      .where(eq(secrets.ownerId, this.owner));
    const retiredRows = await exec
      .select()
      .from(retiredSecrets)
      .where(eq(retiredSecrets.ownerId, this.owner));
    if (generation < this.applied) return;
    const next = new Map<string, Entry>();
    for (const row of rows) {
      const key = entryKey(row.kind, row.name);
      const stamp = stampOf(row);
      const previous = this.entries.get(key);
      next.set(
        key,
        previous && previous.stamp === stamp
          ? previous
          : {
              kind: row.kind,
              name: row.name,
              value: this.open(row),
              hint: row.hint,
              keyId: row.keyId,
              createdAt: row.createdAt,
              updatedAt: row.updatedAt,
              stamp,
            },
      );
    }
    const retired = new Map<string, RetiredEntry>();
    for (const row of retiredRows) {
      const stamp = retiredStampOf(row);
      const previous = this.retired.get(row.id);
      retired.set(
        row.id,
        previous && previous.stamp === stamp
          ? previous
          : {
              kind: row.kind,
              name: row.name,
              value: this.openRetired(row),
              stamp,
            },
      );
    }
    this.entries = next;
    this.retired = retired;
    this.applied = generation;
  }

  /** From the last refresh. */
  providerKey(providerId: string): StoredProviderKey | undefined {
    const entry = this.entries.get(entryKey("provider", providerId));
    return entry
      ? {
          value: entry.value,
          hint: entry.hint,
          updatedAt: entry.updatedAt.toISOString(),
        }
      : undefined;
  }

  /** The sandbox secrets as settings shows them, by name, from the last refresh. */
  sandboxSecrets(): SecretInfo[] {
    return [...this.entries.values()]
      .filter((entry) => entry.kind === "sandbox")
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      .map((entry) => ({
        name: entry.name,
        hint: entry.hint,
        readable: entry.value !== undefined,
        createdAt: entry.createdAt.toISOString(),
        updatedAt: entry.updatedAt.toISOString(),
      }));
  }

  /** Every readable value (of one kind), for redaction and the "already a server secret" checks. */
  values(kind?: SecretKind): Secret[] {
    return [...this.entries.values()].flatMap((entry) =>
      entry.value === undefined || (kind && entry.kind !== kind)
        ? []
        : [
            {
              name:
                entry.kind === "provider"
                  ? `the stored ${entry.name} key`
                  : `the sandbox secret ${entry.name}`,
              value: entry.value,
            },
          ],
    );
  }

  /**
   * The readable retired values, from the last refresh: for redaction only.
   * They are never injected, and no answer carries them.
   */
  retiredValues(kind?: SecretKind): Secret[] {
    return [...this.retired.values()].flatMap((entry) =>
      entry.value === undefined || (kind && entry.kind !== kind)
        ? []
        : [
            {
              name:
                entry.kind === "provider"
                  ? `a replaced or removed ${entry.name} key`
                  : `a replaced or removed value of ${entry.name}`,
              value: entry.value,
            },
          ],
    );
  }

  /** How many retired values no current key opens, from the last refresh. */
  unreadableRetired(): number {
    return [...this.retired.values()].filter(
      (entry) => entry.value === undefined,
    ).length;
  }

  /** Names of the stored rows no current key opens, from the last refresh. */
  unreadable(): { kind: SecretKind; name: string }[] {
    return [...this.entries.values()]
      .filter((entry) => entry.value === undefined)
      .map((entry) => ({ kind: entry.kind, name: entry.name }));
  }

  /**
   * The granted sandbox secrets' values, read from the database (not the
   * snapshot), by name. A name that is not stored, or that no key opens, is
   * reported in `missing` or `unreadable`.
   */
  async sandboxValues(
    names: readonly string[],
    exec: Executor = this.db,
  ): Promise<{
    values: Record<string, string>;
    missing: string[];
    unreadable: string[];
  }> {
    const result = {
      values: {} as Record<string, string>,
      missing: [] as string[],
      unreadable: [] as string[],
    };
    if (names.length === 0) return result;
    const rows = await exec
      .select()
      .from(secrets)
      .where(and(eq(secrets.ownerId, this.owner), eq(secrets.kind, "sandbox")));
    for (const name of names) {
      const row = rows.find((candidate) => candidate.name === name);
      const value = row && this.open(row);
      if (!row) result.missing.push(name);
      else if (value === undefined) result.unreadable.push(name);
      else result.values[name] = value;
    }
    return result;
  }

  /**
   * Seals again, under the current key, every row a previous key sealed,
   * retired values included. Idempotent across processes: a row is
   * rewritten only while it still carries the old key id.
   */
  async rotate(logger: Logger, exec: Executor = this.db): Promise<number> {
    const keyring = this.keyring;
    if (!keyring) return 0;
    const rows = await exec
      .select()
      .from(secrets)
      .where(eq(secrets.ownerId, this.owner));
    let count = 0;
    for (const row of rows) {
      if (row.keyId === keyring.currentKeyId || !keyring.knows(row.keyId))
        continue;
      const value = this.open(row);
      if (value === undefined) continue;
      const sealed = keyring.seal(value, this.aad(row.kind, row.name));
      const updated = await exec
        .update(secrets)
        .set({
          keyId: sealed.keyId,
          nonce: sealed.nonce,
          ciphertext: sealed.ciphertext,
        })
        .where(
          and(
            eq(secrets.ownerId, row.ownerId),
            eq(secrets.kind, row.kind),
            eq(secrets.name, row.name),
            eq(secrets.keyId, row.keyId),
          ),
        )
        .returning({ name: secrets.name });
      count += updated.length;
    }
    const retiredRows = await exec
      .select()
      .from(retiredSecrets)
      .where(eq(retiredSecrets.ownerId, this.owner));
    let retired = 0;
    for (const row of retiredRows) {
      if (row.keyId === keyring.currentKeyId || !keyring.knows(row.keyId))
        continue;
      const value = this.openRetired(row);
      if (value === undefined) continue;
      const sealed = keyring.seal(value, this.retiredAad(row.kind, row.name));
      const updated = await exec
        .update(retiredSecrets)
        .set({
          keyId: sealed.keyId,
          nonce: sealed.nonce,
          ciphertext: sealed.ciphertext,
        })
        .where(
          and(
            eq(retiredSecrets.id, row.id),
            eq(retiredSecrets.keyId, row.keyId),
          ),
        )
        .returning({ id: retiredSecrets.id });
      retired += updated.length;
    }
    if (retired > 0)
      logger.info(
        `Re-encrypted ${retired} replaced or removed secret ${retired === 1 ? "value" : "values"}, kept for redaction, with the current JJ_SECRET_KEY.`,
      );
    if (count > 0)
      logger.info(
        `Re-encrypted ${count} stored ${count === 1 ? "secret" : "secrets"} with the current JJ_SECRET_KEY. Remove JJ_SECRET_KEY_PREVIOUS once every process runs with this key.`,
      );
    return count;
  }
}

/** Warns, by name only, about stored values the server cannot use. */
export function warnUnreadable(store: SecretStore, logger: Logger): void {
  const retired = store.unreadableRetired();
  if (retired > 0)
    logger.warn(
      store.available
        ? `${retired} replaced or removed secret ${retired === 1 ? "value cannot" : "values cannot"} be decrypted with JJ_SECRET_KEY, so ${retired === 1 ? "it is" : "they are"} no longer redacted from task history. Set the key that sealed ${retired === 1 ? "it" : "them"} in JJ_SECRET_KEY_PREVIOUS to keep redacting ${retired === 1 ? "it" : "them"}.`
        : `JJ_SECRET_KEY is not set, so ${retired} replaced or removed secret ${retired === 1 ? "value is" : "values are"} no longer redacted from task history.`,
    );
  const unreadable = store.unreadable();
  if (unreadable.length === 0) return;
  const names = unreadable
    .map((entry) =>
      entry.kind === "provider" ? `the ${entry.name} key` : entry.name,
    )
    .join(", ");
  logger.warn(
    store.available
      ? `${unreadable.length} stored ${unreadable.length === 1 ? "secret" : "secrets"} cannot be decrypted with JJ_SECRET_KEY (${names}): they were stored under another key. Set the old key in JJ_SECRET_KEY_PREVIOUS to keep them, or store them again in Settings.`
      : `JJ_SECRET_KEY is not set, so ${unreadable.length} stored ${unreadable.length === 1 ? "secret is" : "secrets are"} unavailable (${names}). Set the key they were stored with, or remove them in Settings.`,
  );
}
