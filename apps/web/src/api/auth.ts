/**
 * Signing in to the JJ Bot API (contract 1.13.0). The web app signs in once
 * per browser: with the access token, a password, or the one-time code of a
 * login link (`#/login?code=`), and the server answers with an `HttpOnly`
 * session cookie that every later request, stream and download carries by
 * itself. The app never holds a credential after that: no token in
 * localStorage, in a URL or in its memory. Using a login link's code or a
 * token an earlier version kept is in ./signIn.ts, loaded only for them.
 */
import {
  type AuthCredential,
  type AuthSession,
  type AuthState,
  authSessionListSchema,
  authStateSchema,
  type LoginCommand,
  loginResultSchema,
  rotateTokenResultSchema,
} from "@jj/contracts";
import { ApiError } from "./client";
import { createHttp, type HttpOptions } from "./liveApi";

/** The device list, signing out and rotating the token (Settings → Security). */
export interface AuthApi {
  /** `GET /api/auth/session`: answered without credentials. */
  state(): Promise<AuthState>;
  /** `POST /api/auth/login`: sets the session cookie. */
  login(command: LoginCommand): Promise<AuthSession>;
  /** `POST /api/auth/logout`: ends this browser's session. */
  logout(): Promise<void>;
  /** `GET /api/auth/sessions`: the signed-in devices, newest first. */
  sessions(): Promise<AuthSession[]>;
  /** `DELETE /api/auth/sessions/:id`. */
  signOut(sessionId: string): Promise<void>;
  /** `DELETE /api/auth/sessions`: every device but this one. */
  signOutOthers(): Promise<void>;
  /**
   * `POST /api/auth/token`: a new generated token, shown once; every other
   * device is signed out. Rejects with `CONFLICT` when API_TOKEN sets it.
   */
  rotateToken(current: AuthCredential): Promise<string>;
}

export function createAuthApi(options: HttpOptions = {}): AuthApi {
  const { request } = createHttp(options);
  const id = encodeURIComponent;
  return {
    state: () => request("GET", "/auth/session", authStateSchema),
    login: async (command) =>
      (await request("POST", "/auth/login", loginResultSchema, command))
        .session,
    logout: () => request("POST", "/auth/logout", null),
    sessions: async () =>
      (await request("GET", "/auth/sessions", authSessionListSchema)).sessions,
    signOut: (sessionId) =>
      request("DELETE", `/auth/sessions/${id(sessionId)}`, null),
    signOutOthers: () => request("DELETE", "/auth/sessions", null),
    rotateToken: async (current) =>
      (
        await request("POST", "/auth/token", rotateTokenResultSchema, {
          current,
        })
      ).token,
  };
}

/**
 * The sign-in state, or null when the server has no sign-in routes (an older
 * server, a static host): the caller probes it as before.
 */
export async function authState(auth: AuthApi): Promise<AuthState | null> {
  try {
    return await auth.state();
  } catch (error) {
    if (
      error instanceof ApiError &&
      (error.status === 404 || error.code === "INVALID_RESPONSE")
    )
      return null;
    throw error;
  }
}

/** Seconds to wait from a 429, or null. */
export function retryAfterSeconds(error: unknown): number | null {
  if (!(error instanceof ApiError) || error.code !== "RATE_LIMITED")
    return null;
  const seconds = (error.details as { retryAfterSeconds?: unknown } | null)
    ?.retryAfterSeconds;
  return typeof seconds === "number" && seconds > 0 ? seconds : 60;
}

/** Where the login screen lives. */
export const LOGIN_HASH = "#/login";

/** Whether a hash is the login screen's, with or without a code. */
export const isLoginHash = (hash: string) =>
  hash === LOGIN_HASH || hash.startsWith(`${LOGIN_HASH}?`);

/** Where earlier versions kept the token in this browser. */
export const LEGACY_TOKEN_KEY = "jj.apiToken";

/**
 * Whether a load of `href` carries something to sign in with or to clear: a
 * login link's code, an old `?token=`, or a token an earlier version kept in
 * `storage` (the browser's localStorage).
 */
export function hasPendingSignIn(
  href: string,
  storage?: { getItem(key: string): string | null },
): boolean {
  const url = new URL(href);
  if (url.hash.startsWith(`${LOGIN_HASH}?`) || url.searchParams.has("token"))
    return true;
  try {
    return storage?.getItem(LEGACY_TOKEN_KEY) != null;
  } catch {
    return false;
  }
}
