// Cookie sessions and one-time login codes in the database. Only hashes are
// stored: the cookie's 32 random bytes and a code's 32 random bytes are
// SHA-256'd before they are written or looked up, so the database alone signs
// nobody in. Times come from the injected clock, so expiry is testable.
import { createHash, randomBytes } from "node:crypto";
import { AUTH_SESSION_LABEL_LIMIT, type AuthSession } from "@jj/contracts";
import {
  type AuthSessionRow,
  authLoginCodes,
  authSessions,
  type Executor,
  newId,
} from "@jj/db";
import { and, desc, eq, gt, lt, lte, ne, or } from "drizzle-orm";

const HOUR = 60 * 60_000;
const DAY = 24 * HOUR;

/** A session ends this long after it signed in, used or not. */
export const SESSION_ABSOLUTE_MS = 30 * DAY;
/** A session ends after this long without a request. */
export const SESSION_IDLE_MS = 7 * DAY;
/** `last_seen_at` is written at most this often. */
export const LAST_SEEN_WRITE_MS = HOUR;
/** A login code works for this long, once. */
export const LOGIN_CODE_MS = 15 * 60_000;

/** 32 random bytes, base64url: a cookie's or a login code's secret. */
export const newSecret = () => randomBytes(32).toString("base64url");

export const secretHash = (secret: string) =>
  createHash("sha256").update(secret, "utf8").digest("hex");

/** When a session ends unless it is used again. */
export const sessionExpiry = (
  row: Pick<AuthSessionRow, "expiresAt" | "lastSeenAt">,
) =>
  new Date(
    Math.min(
      row.expiresAt.getTime(),
      row.lastSeenAt.getTime() + SESSION_IDLE_MS,
    ),
  );

export function sessionView(
  row: AuthSessionRow,
  currentId: string | undefined,
): AuthSession {
  return {
    id: row.id,
    label: row.label,
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    expiresAt: sessionExpiry(row).toISOString(),
    current: row.id === currentId,
  };
}

export class AuthStore {
  constructor(
    private readonly db: Executor,
    private readonly now: () => number = Date.now,
  ) {}

  private date() {
    return new Date(this.now());
  }

  /** Live sessions only: before their absolute expiry and used within the idle limit. */
  private live(at: Date) {
    return and(
      gt(authSessions.expiresAt, at),
      gt(authSessions.lastSeenAt, new Date(at.getTime() - SESSION_IDLE_MS)),
    );
  }

  /** A new session; the secret goes in the cookie and nowhere else. */
  async createSession(
    label: string,
  ): Promise<{ row: AuthSessionRow; secret: string }> {
    const at = this.date();
    const secret = newSecret();
    const [row] = await this.db
      .insert(authSessions)
      .values({
        id: newId("authSession"),
        secretHash: secretHash(secret),
        label: label.slice(0, AUTH_SESSION_LABEL_LIMIT),
        createdAt: at,
        lastSeenAt: at,
        expiresAt: new Date(at.getTime() + SESSION_ABSOLUTE_MS),
      })
      .returning();
    await this.prune(at);
    return { row: row as AuthSessionRow, secret };
  }

  /**
   * The live session a cookie names, its `last_seen_at` moved to now when it
   * is an hour old or more. Undefined for an unknown, expired or signed-out one.
   */
  async findSession(secret: string): Promise<AuthSessionRow | undefined> {
    const at = this.date();
    const [row] = await this.db
      .select()
      .from(authSessions)
      .where(
        and(eq(authSessions.secretHash, secretHash(secret)), this.live(at)),
      );
    if (!row) return undefined;
    if (at.getTime() - row.lastSeenAt.getTime() < LAST_SEEN_WRITE_MS)
      return row;
    const [touched] = await this.db
      .update(authSessions)
      .set({ lastSeenAt: at })
      .where(eq(authSessions.id, row.id))
      .returning();
    return touched;
  }

  /** Whether the session is still live; reads only (a stream's check). */
  async sessionLive(id: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: authSessions.id })
      .from(authSessions)
      .where(and(eq(authSessions.id, id), this.live(this.date())));
    return Boolean(row);
  }

  /** The live sessions, newest first. */
  async listSessions(): Promise<AuthSessionRow[]> {
    return this.db
      .select()
      .from(authSessions)
      .where(this.live(this.date()))
      .orderBy(desc(authSessions.createdAt), desc(authSessions.id));
  }

  /** Signs one session out; false when there was none. */
  async deleteSession(id: string): Promise<boolean> {
    const deleted = await this.db
      .delete(authSessions)
      .where(eq(authSessions.id, id))
      .returning({ id: authSessions.id });
    return deleted.length > 0;
  }

  /** Signs every session out but `keep`; returns the ids signed out. */
  async deleteOtherSessions(keep: string | undefined): Promise<string[]> {
    const deleted = await this.db
      .delete(authSessions)
      .where(keep ? ne(authSessions.id, keep) : undefined)
      .returning({ id: authSessions.id });
    return deleted.map((row) => row.id);
  }

  /** A new one-time login code, valid for LOGIN_CODE_MS. */
  async createLoginCode(): Promise<string> {
    const at = this.date();
    const code = newSecret();
    await this.db.insert(authLoginCodes).values({
      codeHash: secretHash(code),
      createdAt: at,
      expiresAt: new Date(at.getTime() + LOGIN_CODE_MS),
    });
    await this.prune(at);
    return code;
  }

  /** Uses a login code up: true once for a code that has not expired. */
  async consumeLoginCode(code: string): Promise<boolean> {
    const used = await this.db
      .delete(authLoginCodes)
      .where(
        and(
          eq(authLoginCodes.codeHash, secretHash(code)),
          gt(authLoginCodes.expiresAt, this.date()),
        ),
      )
      .returning({ codeHash: authLoginCodes.codeHash });
    return used.length > 0;
  }

  /** Deletes expired sessions and codes. */
  async prune(at: Date = this.date()): Promise<void> {
    await this.db
      .delete(authSessions)
      .where(
        or(
          lte(authSessions.expiresAt, at),
          lte(
            authSessions.lastSeenAt,
            new Date(at.getTime() - SESSION_IDLE_MS),
          ),
        ),
      );
    await this.db
      .delete(authLoginCodes)
      .where(lt(authLoginCodes.expiresAt, at));
  }
}
