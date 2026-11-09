// `/api/auth/*` (contract 1.13.0): the sign-in state, signing in and out,
// the signed-in devices, and rotating the generated token. Every answer is
// `Cache-Control: no-store`.
import { DomainError } from "@jj/backend";
import { loginCommandSchema, rotateTokenCommandSchema, z } from "@jj/contracts";
import { type Context, Hono } from "hono";
import { errorResponse, idParam, jsonBody } from "../http";
import type { StreamRegistry } from "../sse";
import { clientAddress } from "./clients";
import { clearSessionCookie, setSessionCookie } from "./cookie";
import { originMatches, principalOf, rateLimited } from "./guard";
import { deviceLabel } from "./label";
import { type AuthService, type CheckResult, SIGN_IN_FAILED } from "./service";
import { sessionView } from "./store";

async function parse<Schema extends z.ZodType>(
  c: Context,
  schema: Schema,
): Promise<z.output<Schema>> {
  const parsed = schema.safeParse(await jsonBody(c));
  if (!parsed.success)
    throw new DomainError(
      "VALIDATION_FAILED",
      z.prettifyError(parsed.error),
      parsed.error.issues,
    );
  return parsed.data;
}

const minutes = (ms: number) => {
  const count = Math.max(1, Math.ceil(ms / 60_000));
  return `${count} minute${count === 1 ? "" : "s"}`;
};

/** The answer to a refused credential: the one sign-in message, or 429. */
function refused(c: Context, result: Exclude<CheckResult, { ok: true }>) {
  if (result.status === 429)
    return rateLimited(
      c,
      result.retryAfterMs,
      `Too many failed sign-ins: try again in ${minutes(result.retryAfterMs)}.`,
    );
  return errorResponse(c, 401, "UNAUTHORIZED", SIGN_IN_FAILED);
}

export function authRoutes(auth: AuthService, streams: StreamRegistry) {
  const routes = new Hono();
  routes.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });
  const currentSession = (c: Context) => {
    const principal = principalOf(c);
    return principal?.via === "cookie" ? principal.session.id : undefined;
  };
  const endSessionStreams = (ids: readonly string[]) =>
    streams.endWhere(
      (credential) =>
        credential.sessionId !== undefined &&
        ids.includes(credential.sessionId),
    );

  routes.get("/session", (c) => c.json(auth.state(principalOf(c))));

  routes.post("/login", async (c) => {
    if (!auth.required)
      return errorResponse(
        c,
        409,
        "CONFLICT",
        "This server asks for no sign-in: without a token it answers only on this machine.",
      );
    // A browser always sends Origin with a POST; a script may send none.
    if (c.req.header("Origin") !== undefined && !originMatches(auth, c))
      return errorResponse(
        c,
        403,
        "UNAUTHORIZED",
        `Sign in from the JJ Bot app at ${auth.publicLocation}: this page's Origin is not it.`,
      );
    const command = await parse(c, loginCommandSchema);
    const result = await auth.check(
      command,
      clientAddress(c, auth.trustedProxies),
    );
    if (!result.ok) return refused(c, result);
    const { row, secret } = await auth.store.createSession(
      deviceLabel(c.req.header("User-Agent")),
    );
    // Signing in again from a signed-in browser replaces its session.
    const previous = currentSession(c);
    if (previous) {
      await auth.store.deleteSession(previous);
      endSessionStreams([previous]);
    }
    // The cookie lasts the session's absolute lifetime; the server ends an
    // idle one before that, and the browser sends the cookie only until then.
    c.header(
      "Set-Cookie",
      setSessionCookie(
        auth.cookie,
        secret,
        row.expiresAt.getTime() - auth.now(),
      ),
      { append: true },
    );
    return c.json({ session: sessionView(row, row.id) });
  });

  routes.post("/logout", async (c) => {
    const current = currentSession(c);
    if (current) {
      await auth.store.deleteSession(current);
      endSessionStreams([current]);
    }
    if (auth.required)
      c.header("Set-Cookie", clearSessionCookie(auth.cookie), { append: true });
    return c.body(null, 204);
  });

  routes.get("/sessions", async (c) => {
    const current = currentSession(c);
    const rows = auth.required ? await auth.store.listSessions() : [];
    return c.json({ sessions: rows.map((row) => sessionView(row, current)) });
  });

  routes.delete("/sessions/:id", async (c) => {
    const id = idParam(c, "id");
    if (!(await auth.store.deleteSession(id)))
      return errorResponse(
        c,
        404,
        "NOT_FOUND",
        `Session ${id} was not found: it has signed out or ended.`,
      );
    endSessionStreams([id]);
    if (id === currentSession(c))
      c.header("Set-Cookie", clearSessionCookie(auth.cookie), { append: true });
    return c.body(null, 204);
  });

  routes.delete("/sessions", async (c) => {
    const signedOut = await auth.store.deleteOtherSessions(currentSession(c));
    endSessionStreams(signedOut);
    return c.body(null, 204);
  });

  routes.post("/token", async (c) => {
    if (!auth.rotatable)
      return errorResponse(
        c,
        409,
        "CONFLICT",
        auth.required
          ? "API_TOKEN sets this server's token: change it there and restart the server, which signs out every device."
          : "This server has no token to rotate: without one it answers only on this machine.",
      );
    const { current } = await parse(c, rotateTokenCommandSchema);
    const result = await auth.check(
      current,
      clientAddress(c, auth.trustedProxies),
    );
    if (!result.ok) return refused(c, result);
    const keep = currentSession(c);
    const { token } = await auth.rotateToken(keep);
    // Streams opened with the old token or another session end now.
    streams.endWhere(
      (credential) =>
        credential.bearer === true ||
        (credential.sessionId !== undefined && credential.sessionId !== keep),
    );
    return c.json({ token }, 201);
  });

  return routes;
}
