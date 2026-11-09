import { z } from "zod";
import { idSchema, timestampSchema } from "./common";

/**
 * Signing in (1.14.0). One owner: the API takes the bearer token, which
 * scripts and `/metrics` keep sending, or a cookie session that a sign-in
 * issues (`POST /api/auth/login`). A session is an `HttpOnly` cookie the
 * client never reads; what clients see of it is `authSessionSchema`.
 *
 * Every failed sign-in answers 401 `UNAUTHORIZED` with the same message,
 * whatever failed; too many answer 429 `RATE_LIMITED` with `Retry-After` and
 * `details.retryAfterSeconds` (`rateLimitedDetailsSchema`).
 */

/** Longest label of a session: the browser and system it signed in from. */
export const AUTH_SESSION_LABEL_LIMIT = 80;
/** Longest credential a sign-in or a token rotation takes. */
export const AUTH_CREDENTIAL_LIMIT = 1024;

/** A signed-in device: one cookie session. */
export const authSessionSchema = z.object({
  id: idSchema,
  /** The browser and system it signed in from, such as "Safari on iPhone". */
  label: z.string().max(AUTH_SESSION_LABEL_LIMIT),
  createdAt: timestampSchema,
  /** Updated at most hourly. */
  lastSeenAt: timestampSchema,
  /** When it ends unless used again: the earlier of its absolute and idle expiry. */
  expiresAt: timestampSchema,
  /** The session of the request that asked. */
  current: z.boolean(),
});

/** How a request was let in: without credentials (none required), a cookie session or the bearer token. */
export const AUTH_VIA = ["none", "cookie", "bearer"] as const;

/** `GET /api/auth/session`: answered without credentials, behind the cross-site checks. */
export const authStateSchema = z.object({
  /** The API needs credentials: false only on loopback without a token. */
  required: z.boolean(),
  /** This request may use the API. */
  authenticated: z.boolean(),
  via: z.enum(AUTH_VIA),
  /** The sign-in methods this server takes. */
  methods: z.object({
    /** The access token (`API_TOKEN` or the generated one); true whenever sign-in is required. */
    token: z.boolean(),
    /** A password (`JJ_PASSWORD_HASH`). */
    password: z.boolean(),
    /** Passkeys: not offered yet. */
    passkey: z.boolean(),
  }),
  /** The cookie session the request came with, when it is valid. */
  session: authSessionSchema.nullable(),
});

const credential = z.string().min(1).max(AUTH_CREDENTIAL_LIMIT);

/** The access token, or a password. */
export const authCredentialSchema = z.union([
  z.strictObject({ token: credential }),
  z.strictObject({ password: credential }),
]);

/**
 * `POST /api/auth/login`: the access token, the password, or the one-time
 * code of a login link (`#/login?code=`). Answers 200 `loginResultSchema`
 * with the session cookie.
 */
export const loginCommandSchema = z.union([
  z.strictObject({ token: credential }),
  z.strictObject({ password: credential }),
  z.strictObject({ code: z.string().min(1).max(128) }),
]);

export const loginResultSchema = z.object({ session: authSessionSchema });

/** `GET /api/auth/sessions`: the signed-in devices, newest first. */
export const authSessionListSchema = z.object({
  sessions: z.array(authSessionSchema),
});

/**
 * `POST /api/auth/token`: replaces the generated access token, proving the
 * current token or the password, and signs out every other session. Answers
 * 201 `rotateTokenResultSchema`, the only time the new token is shown, and
 * 409 `CONFLICT` when `API_TOKEN` sets the token.
 */
export const rotateTokenCommandSchema = z.strictObject({
  current: authCredentialSchema,
});

export const rotateTokenResultSchema = z.object({ token: z.string().min(1) });

/** `details` of a 429 `RATE_LIMITED` sign-in or bearer refusal. */
export const rateLimitedDetailsSchema = z.object({
  retryAfterSeconds: z.number().int().positive(),
});

export type AuthSession = z.infer<typeof authSessionSchema>;
export type AuthVia = (typeof AUTH_VIA)[number];
export type AuthState = z.infer<typeof authStateSchema>;
export type AuthCredential = z.input<typeof authCredentialSchema>;
export type LoginCommand = z.input<typeof loginCommandSchema>;
export type LoginResult = z.infer<typeof loginResultSchema>;
export type AuthSessionList = z.infer<typeof authSessionListSchema>;
export type RotateTokenCommand = z.input<typeof rotateTokenCommandSchema>;
export type RotateTokenResult = z.infer<typeof rotateTokenResultSchema>;
export type RateLimitedDetails = z.infer<typeof rateLimitedDetailsSchema>;
