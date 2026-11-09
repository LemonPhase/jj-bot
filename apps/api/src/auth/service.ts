// What the API knows about signing in: whether it requires credentials, the
// bearer token in force, the optional password, the cookie it issues, the
// origin a cookie write must come from, the rate limits, and the sessions and
// login codes (store.ts). Routes (routes.ts) and the guard (guard.ts) answer
// HTTP with it; the boot line and the CLI mint login codes through it.
import { createHash, timingSafeEqual } from "node:crypto";
import type { Logger } from "@jj/backend";
import type { AuthState, AuthVia } from "@jj/contracts";
import {
  type AuthSessionRow,
  type Executor,
  readInstanceSetting,
  writeInstanceSetting,
} from "@jj/db";
import { isLoopbackHost } from "../config";
import { GENERATED_TOKEN_KEY, generateApiToken } from "../token";
import {
  DEFAULT_TRUSTED_PROXIES,
  parseTrustedProxies,
  type TrustedProxies,
} from "./clients";
import { type SessionCookie, sessionCookie } from "./cookie";
import { AuthLimits } from "./limits";
import { type PasswordHash, verifyPassword } from "./password";
import { AuthStore, sessionView } from "./store";

/** The bearer token in force, and where it comes from. */
export type TokenSource =
  | { kind: "configured"; token: string }
  | { kind: "generated"; token: string }
  | { kind: "none" };

export interface AuthOptions {
  db: Executor;
  token: TokenSource;
  /** `JJ_PASSWORD_HASH`, parsed, with its text (the credential fingerprint uses it). */
  password?: { hash: PasswordHash; text: string };
  /** `API_PUBLIC_URL`: the cookie's flags and the origin cookie writes must come from. */
  publicUrl?: string;
  trustedProxies?: TrustedProxies;
  /** Milliseconds since the epoch; tests inject a clock. */
  now?: () => number;
  logger: Logger;
  /** Called once a rotated token is stored, so the redactor covers it. */
  onTokenChanged?: () => Promise<unknown>;
}

/** Who a request came as. */
export type Principal =
  | { via: "none" }
  | { via: "bearer"; digest: Buffer }
  | { via: "cookie"; session: AuthSessionRow };

/** A credential checked: accepted, or refused with 401 or 429. */
export type CheckResult =
  | { ok: true }
  | { ok: false; status: 401 }
  | {
      ok: false;
      status: 429;
      retryAfterMs: number;
      /** Every password-check slot was taken, not a limit of this client's. */
      busy?: boolean;
    };

/** The one message every failed sign-in answers, whatever failed. */
export const SIGN_IN_FAILED =
  "Sign-in failed: the token, password or link is wrong, used or expired.";

/** The instance setting that holds the fingerprint of the credentials sessions were made with. */
export const CREDENTIALS_KEY = "auth.credentials";

/** A generated token another process rotated is picked up within this long. */
const TOKEN_REFRESH_MS = 5_000;

export const tokenDigest = (token: string) =>
  createHash("sha256").update(token, "utf8").digest();

export class AuthService {
  readonly required: boolean;
  readonly store: AuthStore;
  readonly limits: AuthLimits;
  readonly cookie: SessionCookie;
  readonly trustedProxies: TrustedProxies;
  readonly now: () => number;
  private readonly publicOrigin: string | undefined;
  private tokenKind: TokenSource["kind"];
  private digest: Buffer | undefined;
  private refreshedAt: number;

  constructor(private readonly options: AuthOptions) {
    this.now = options.now ?? Date.now;
    this.tokenKind = options.token.kind;
    this.digest =
      options.token.kind === "none"
        ? undefined
        : tokenDigest(options.token.token);
    this.refreshedAt = this.now();
    this.required = options.token.kind !== "none";
    this.store = new AuthStore(options.db, this.now);
    this.limits = new AuthLimits(this.now);
    this.cookie = sessionCookie(options.publicUrl);
    this.trustedProxies =
      options.trustedProxies ?? parseTrustedProxies(DEFAULT_TRUSTED_PROXIES);
    this.publicOrigin = options.publicUrl
      ? new URL(options.publicUrl).origin
      : undefined;
  }

  get passwordSet(): boolean {
    return this.options.password !== undefined;
  }

  /** Whether the token can be rotated here: it is the generated one. */
  get rotatable(): boolean {
    return this.tokenKind === "generated";
  }

  /** The current token's digest; a generated one is re-read every few seconds, for other processes' rotations. */
  private async currentDigest(): Promise<Buffer | undefined> {
    if (
      this.tokenKind === "generated" &&
      this.now() - this.refreshedAt > TOKEN_REFRESH_MS
    ) {
      this.refreshedAt = this.now();
      const stored = await readInstanceSetting(
        this.options.db,
        GENERATED_TOKEN_KEY,
      );
      if (stored) this.digest = tokenDigest(stored);
    }
    return this.digest;
  }

  /** Whether `candidate` is the token in force, compared in constant time over digests. */
  async tokenMatches(candidate: string): Promise<Buffer | undefined> {
    const expected = await this.currentDigest();
    const digest = tokenDigest(candidate);
    return expected && timingSafeEqual(digest, expected) ? digest : undefined;
  }

  /** Whether a bearer stream opened with `digest` may stay open: the token was not rotated. */
  async bearerCurrent(digest: Buffer): Promise<boolean> {
    const expected = await this.currentDigest();
    return expected !== undefined && timingSafeEqual(digest, expected);
  }

  /**
   * Whether a cookie write's `Origin` is where users open the app:
   * API_PUBLIC_URL's origin, or without one, a loopback origin naming the
   * request's own `Host` (the Vite dev server keeps the browser's `Host`).
   */
  originAllowed(origin: string | undefined, host: string): boolean {
    if (!origin) return false;
    if (this.publicOrigin) return origin === this.publicOrigin;
    try {
      const url = new URL(origin);
      return (
        url.origin === origin &&
        isLoopbackHost(url.hostname) &&
        url.host === host.trim().toLowerCase()
      );
    } catch {
      return false;
    }
  }

  /** Where users open the app, for refusals. */
  get publicLocation(): string {
    return this.publicOrigin ?? "a loopback address";
  }

  state(principal: Principal | undefined): AuthState {
    const via: AuthVia = principal?.via ?? "none";
    return {
      required: this.required,
      authenticated: !this.required || principal !== undefined,
      via: this.required ? via : "none",
      methods: {
        token: this.required,
        password: this.required && this.passwordSet,
        passkey: false,
      },
      session:
        principal?.via === "cookie"
          ? sessionView(principal.session, principal.session.id)
          : null,
    };
  }

  /**
   * Checks a sign-in credential from `client`, within the rate limits. A code
   * is used up when it is accepted.
   */
  async check(
    credential: { token: string } | { password: string } | { code: string },
    client: string,
  ): Promise<CheckResult> {
    const password = "password" in credential;
    const waitMs = this.limits.loginWaitMs(client);
    if (password) {
      // A throttled or locked password is not even checked, and no more
      // than MAX_PASSWORD_CHECKS run at once.
      const lockMs = this.limits.passwordLockMs();
      if (waitMs > 0 || lockMs > 0)
        return {
          ok: false,
          status: 429,
          retryAfterMs: Math.max(waitMs, lockMs),
        };
      if (!this.limits.beginPasswordCheck())
        return { ok: false, status: 429, retryAfterMs: 1000, busy: true };
    }
    // Counted before the check, which awaits: attempts running in parallel
    // see each other's failures. A success takes it back.
    const lock = this.limits.loginFailed(client, password);
    let accepted = false;
    try {
      if ("token" in credential)
        accepted = (await this.tokenMatches(credential.token)) !== undefined;
      else if ("code" in credential)
        accepted = await this.store.consumeLoginCode(credential.code);
      else if (this.options.password)
        accepted = await verifyPassword(
          this.options.password.hash,
          credential.password,
        );
    } finally {
      if (password) this.limits.endPasswordCheck();
    }
    if (accepted) {
      this.limits.loginSucceeded(client, password);
      return { ok: true };
    }
    if (lock?.started)
      this.options.logger.warn(
        `Password sign-in is locked for ${Math.round(lock.lockedForMs / 60_000)} minutes after repeated failures; the access token and login links still sign in.`,
      );
    const retryAfterMs = Math.max(
      this.limits.loginWaitMs(client),
      password ? this.limits.passwordLockMs() : 0,
    );
    return retryAfterMs > 0 && waitMs > 0
      ? { ok: false, status: 429, retryAfterMs }
      : { ok: false, status: 401 };
  }

  /**
   * Replaces the generated token: stores the new one, signs out every session
   * but `keep`, and records the new credentials. Returns the new token and
   * the sessions signed out.
   */
  async rotateToken(
    keep: string | undefined,
  ): Promise<{ token: string; signedOut: string[] }> {
    const token = generateApiToken();
    await writeInstanceSetting(this.options.db, GENERATED_TOKEN_KEY, token);
    this.digest = tokenDigest(token);
    this.refreshedAt = this.now();
    const signedOut = await this.store.deleteOtherSessions(keep);
    await writeInstanceSetting(
      this.options.db,
      CREDENTIALS_KEY,
      this.fingerprint(),
    );
    await this.options.onTokenChanged?.();
    this.options.logger.info(
      `The access token was replaced; ${signedOut.length} other session${signedOut.length === 1 ? " was" : "s were"} signed out.`,
    );
    return { token, signedOut };
  }

  /** A digest of the credentials in force; sessions made under others end. */
  private fingerprint(): string {
    return createHash("sha256")
      .update(
        [
          "jj-auth-credentials-v1",
          this.tokenKind,
          this.digest?.toString("hex") ?? "",
          this.options.password?.text ?? "",
        ].join("\n"),
      )
      .digest("hex");
  }

  /**
   * At boot: when the token or the password changed since sessions were
   * made, signs every session out, so a changed credential locks out every
   * device that signed in with the old one.
   */
  async reconcileCredentials(): Promise<number> {
    if (!this.required) return 0;
    const fingerprint = this.fingerprint();
    const stored = await readInstanceSetting(this.options.db, CREDENTIALS_KEY);
    if (stored === fingerprint) return 0;
    const signedOut = stored
      ? await this.store.deleteOtherSessions(undefined)
      : [];
    await writeInstanceSetting(this.options.db, CREDENTIALS_KEY, fingerprint);
    if (signedOut.length > 0)
      this.options.logger.info(
        `The access token or the password changed: ${signedOut.length} session${signedOut.length === 1 ? " was" : "s were"} signed out.`,
      );
    return signedOut.length;
  }
}
