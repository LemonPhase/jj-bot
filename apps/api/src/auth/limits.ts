// Rate limits on credentials, in memory per API process (a restart resets
// them):
//
// - Sign-ins: after 5 failed sign-ins (or token rotations) from a client in
//   15 minutes, its sign-ins answer 429 until the oldest failure leaves the
//   window. A password is then not checked at all; a token or a login code
//   still is, and lets the owner in: a code and a generated token are
//   256-bit, and a configured token beyond loopback at least 32 characters
//   (config.ts), so checking them gives a guesser nothing, and the owner is
//   never locked out.
// - The password: after 20 failed password checks from anywhere, password
//   sign-ins are locked for 15 minutes, then 30, doubling up to 4 hours, until
//   one succeeds or a day passes without a failure. Token and code sign-ins
//   never lock. At most 2 password checks run at once, server-wide; more
//   answer 429 at once, so a burst of guesses neither fills the threadpool
//   nor gets more checks than the limits allow. A failure is counted before
//   its check runs, and taken back when the check succeeds, so parallel
//   attempts see each other's.
// - Bearer requests: the right token is always let in. After 30 wrong tokens
//   from a client in a minute, its wrong ones answer 429 until the oldest
//   leaves the window.
//
// A client is an address, or for IPv6 a /64 (clients.ts, `limitKey`).

const MINUTE = 60_000;

export const LOGIN_WINDOW_MS = 15 * MINUTE;
export const LOGIN_FAILURES_PER_CLIENT = 5;
export const PASSWORD_FAILURES_BEFORE_LOCK = 20;
export const PASSWORD_LOCK_MS = 15 * MINUTE;
export const PASSWORD_LOCK_MAX_MS = 4 * 60 * MINUTE;
/** A day without a failed password check forgets earlier locks. */
export const PASSWORD_LOCK_RESET_MS = 24 * 60 * MINUTE;
export const BEARER_WINDOW_MS = MINUTE;
export const BEARER_FAILURES_PER_CLIENT = 30;
/** Password checks (scrypt) running at once at most, server-wide. */
export const MAX_PASSWORD_CHECKS = 2;
/** Clients tracked per window at most; the oldest are forgotten first. */
const MAX_CLIENTS = 10_000;

/** Failures per client within a sliding window. */
class FailureWindow {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number,
    private readonly limit: number,
  ) {}

  private recent(client: string, now: number): number[] {
    const times = (this.failures.get(client) ?? []).filter(
      (at) => at > now - this.windowMs,
    );
    if (times.length === 0) this.failures.delete(client);
    else this.failures.set(client, times);
    return times;
  }

  /** Milliseconds until the client may try again, or 0. */
  waitMs(client: string, now: number): number {
    const times = this.recent(client, now);
    if (times.length < this.limit) return 0;
    const oldest = times[times.length - this.limit] as number;
    return Math.max(1, oldest + this.windowMs - now);
  }

  fail(client: string, now: number): void {
    const times = this.recent(client, now);
    times.push(now);
    // Re-inserted last, so the map stays ordered by latest failure.
    this.failures.delete(client);
    this.failures.set(client, times.slice(-this.limit));
    while (this.failures.size > MAX_CLIENTS) {
      const first = this.failures.keys().next().value;
      if (first === undefined) break;
      this.failures.delete(first);
    }
  }

  clear(client: string): void {
    this.failures.delete(client);
  }
}

export interface PasswordLock {
  /** How long password sign-ins stay locked. */
  lockedForMs: number;
  /** The lock just started (for the warning in the log). */
  started: boolean;
}

export class AuthLimits {
  private readonly logins = new FailureWindow(
    LOGIN_WINDOW_MS,
    LOGIN_FAILURES_PER_CLIENT,
  );
  private readonly bearer = new FailureWindow(
    BEARER_WINDOW_MS,
    BEARER_FAILURES_PER_CLIENT,
  );
  private passwordFailures = 0;
  private lastPasswordFailure = Number.NEGATIVE_INFINITY;
  private lockedUntil = 0;
  private locks = 0;
  private passwordChecks = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Milliseconds before this client's next sign-in, or 0. */
  loginWaitMs(client: string): number {
    return this.logins.waitMs(client, this.now());
  }

  /** Milliseconds the password path stays locked, or 0. */
  passwordLockMs(): number {
    return Math.max(0, this.lockedUntil - this.now());
  }

  /** A failed sign-in or rotation; a failed password also counts towards the lock. */
  loginFailed(client: string, password: boolean): PasswordLock | undefined {
    const now = this.now();
    this.logins.fail(client, now);
    if (!password) return undefined;
    if (now - this.lastPasswordFailure > PASSWORD_LOCK_RESET_MS) {
      this.locks = 0;
      this.passwordFailures = 0;
    }
    this.lastPasswordFailure = now;
    this.passwordFailures += 1;
    if (this.passwordFailures < PASSWORD_FAILURES_BEFORE_LOCK) return undefined;
    const lockedForMs = Math.min(
      PASSWORD_LOCK_MS * 2 ** this.locks,
      PASSWORD_LOCK_MAX_MS,
    );
    this.locks += 1;
    this.passwordFailures = 0;
    this.lockedUntil = now + lockedForMs;
    return { lockedForMs, started: true };
  }

  /**
   * A sign-in that succeeded: the client starts afresh (which also takes back
   * the failure counted before its check), and a password unlocks.
   */
  loginSucceeded(client: string, password: boolean): void {
    this.logins.clear(client);
    if (!password) return;
    this.passwordFailures = 0;
    this.locks = 0;
    this.lockedUntil = 0;
  }

  /**
   * Takes one of the MAX_PASSWORD_CHECKS slots for a password check (scrypt,
   * on the libuv threadpool, which file reads share), or answers false when
   * they are all taken: parallel guesses cannot fill the threadpool.
   */
  beginPasswordCheck(): boolean {
    if (this.passwordChecks >= MAX_PASSWORD_CHECKS) return false;
    this.passwordChecks += 1;
    return true;
  }

  endPasswordCheck(): void {
    this.passwordChecks = Math.max(0, this.passwordChecks - 1);
  }

  /** Milliseconds before this client's next bearer request, or 0. */
  bearerWaitMs(client: string): number {
    return this.bearer.waitMs(client, this.now());
  }

  bearerFailed(client: string): void {
    this.bearer.fail(client, this.now());
  }
}
