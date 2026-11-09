// The session cookie. Over https it is `__Host-jj_session` with `Secure`: the
// browser then keeps it only from a secure page, for this exact host and
// path `/`, and no subdomain can set or shadow it. When users open the app
// over plain http (a loopback API_PUBLIC_URL, whose traffic never leaves the
// machine, or one JJ_ALLOW_INSECURE_HTTP allows), a Secure cookie would not
// be kept, so it is `jj_session` without it. Either way it is `HttpOnly` (no
// script reads it, so an XSS or an artifact cannot take it) and
// `SameSite=Strict` (no other site's page or link sends it).

export const SECURE_COOKIE = "__Host-jj_session";
export const PLAIN_COOKIE = "jj_session";

export interface SessionCookie {
  name: string;
  secure: boolean;
}

/** The cookie for users opening the app at `publicUrl` (default: plain http on loopback). */
export function sessionCookie(publicUrl: string | undefined): SessionCookie {
  const secure =
    publicUrl !== undefined && new URL(publicUrl).protocol === "https:";
  return { name: secure ? SECURE_COOKIE : PLAIN_COOKIE, secure };
}

const attributes = (cookie: SessionCookie, maxAgeSeconds: number) =>
  [
    "Path=/",
    `Max-Age=${maxAgeSeconds}`,
    "HttpOnly",
    "SameSite=Strict",
    ...(cookie.secure ? ["Secure"] : []),
  ].join("; ");

/** `Set-Cookie` for a session that ends in `maxAgeMs`. */
export const setSessionCookie = (
  cookie: SessionCookie,
  secret: string,
  maxAgeMs: number,
) =>
  `${cookie.name}=${secret}; ${attributes(cookie, Math.max(0, Math.floor(maxAgeMs / 1000)))}`;

/** `Set-Cookie` that removes the session cookie. */
export const clearSessionCookie = (cookie: SessionCookie) =>
  `${cookie.name}=; ${attributes(cookie, 0)}`;

/** The session cookie's value in a `Cookie` header, if it has one. */
export function readSessionCookie(
  cookie: SessionCookie,
  header: string | undefined,
): string | undefined {
  for (const pair of (header ?? "").split(";")) {
    const at = pair.indexOf("=");
    if (at < 0 || pair.slice(0, at).trim() !== cookie.name) continue;
    const value = pair.slice(at + 1).trim();
    // A session secret is 43 base64url characters; anything else is no session.
    return /^[A-Za-z0-9_-]{16,128}$/.test(value) ? value : undefined;
  }
  return undefined;
}
