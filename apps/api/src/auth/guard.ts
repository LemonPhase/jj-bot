// Credentials on `/api/*` and `/metrics`, after the cross-site checks
// (../guard.ts). When the API requires them, a request needs one of:
//
// - `Authorization: Bearer <token>`, for scripts and `/metrics`. The right
//   token always gets in. A wrong one counts against its client: after 30 in
//   a minute, its wrong ones answer 429 for the rest of that minute.
// - The session cookie of a live session. A write (any method but GET, HEAD
//   and OPTIONS) also needs `Origin` equal to where users open the app, so
//   no other page, not even one on a sibling subdomain, writes with it.
//
// `GET /api/auth/session` and `POST /api/auth/login` answer without
// credentials. A cookie that names no live session is cleared in the answer.
import type { Context, MiddlewareHandler } from "hono";
import { errorResponse } from "../http";
import { setStreamAuth } from "../sse";
import { clientAddress } from "./clients";
import { clearSessionCookie, readSessionCookie } from "./cookie";
import type { AuthService, Principal } from "./service";

const READS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Routes that answer without credentials, as `METHOD path`. */
const OPEN_ROUTES = new Set(["GET /api/auth/session", "POST /api/auth/login"]);

const PRINCIPAL = "jjAuthPrincipal";

/** Who the request came as; undefined without valid credentials. */
export const principalOf = (c: Context): Principal | undefined =>
  c.get(PRINCIPAL as never) as Principal | undefined;

const setPrincipal = (c: Context, principal: Principal) =>
  c.set(PRINCIPAL as never, principal as never);

/** `Retry-After` and the contract's details for a 429. */
export function rateLimited(c: Context, retryAfterMs: number, message: string) {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  c.header("Retry-After", String(retryAfterSeconds));
  return errorResponse(c, 429, "RATE_LIMITED", message, { retryAfterSeconds });
}

const requestHost = (c: Context) =>
  c.req.header("Host") ?? new URL(c.req.url).host;

/** Whether a cookie write comes from where users open the app. */
export const originMatches = (auth: AuthService, c: Context) =>
  auth.originAllowed(c.req.header("Origin"), requestHost(c));

export function authGuard(auth: AuthService): MiddlewareHandler {
  return async (c, next) => {
    if (!auth.required) {
      setPrincipal(c, { via: "none" });
      return next();
    }
    const open = OPEN_ROUTES.has(`${c.req.method} ${c.req.path}`);
    const unauthorized = (message: string) => {
      c.header("WWW-Authenticate", 'Bearer realm="jj-bot"');
      return errorResponse(c, 401, "UNAUTHORIZED", message);
    };

    const authorization = c.req.header("Authorization");
    if (authorization !== undefined) {
      // The token first: the right one always gets in, so no neighbour
      // sending wrong ones from the same address can lock a script out.
      const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(authorization);
      const digest = match?.[1] ? await auth.tokenMatches(match[1]) : undefined;
      if (!digest) {
        const client = clientAddress(c, auth.trustedProxies);
        const waitMs = auth.limits.bearerWaitMs(client);
        if (waitMs > 0)
          return rateLimited(
            c,
            waitMs,
            "Too many requests with a wrong token: wait, then send the right one.",
          );
        auth.limits.bearerFailed(client);
        return unauthorized(
          "The bearer token is wrong: send Authorization: Bearer <token>, with the token `npm run auth:token` prints.",
        );
      }
      setPrincipal(c, { via: "bearer", digest });
      setStreamAuth(c, {
        credential: { bearer: true },
        alive: () => auth.bearerCurrent(digest),
      });
      return next();
    }

    const secret = readSessionCookie(auth.cookie, c.req.header("Cookie"));
    if (secret !== undefined) {
      const session = await auth.store.findSession(secret);
      if (!session) {
        c.header("Set-Cookie", clearSessionCookie(auth.cookie), {
          append: true,
        });
        if (open) return next();
        return unauthorized("Your session has ended: sign in again.");
      }
      if (!READS.has(c.req.method) && !originMatches(auth, c))
        return errorResponse(
          c,
          403,
          "UNAUTHORIZED",
          `A signed-in change must come from the JJ Bot app at ${auth.publicLocation}: this request's Origin is not it.`,
        );
      setPrincipal(c, { via: "cookie", session });
      setStreamAuth(c, {
        credential: { sessionId: session.id },
        alive: () => auth.store.sessionLive(session.id),
      });
      return next();
    }

    if (open) return next();
    return unauthorized(
      "Sign in first, or send Authorization: Bearer <token>.",
    );
  };
}
