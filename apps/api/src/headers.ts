// Security headers on every answer the server sends: the web app's pages and
// files, API answers and errors, the event streams, health and metrics.
//
// - The Content-Security-Policy lets a page load and connect to this origin
//   only, run no script but this origin's files and the web app's one inline
//   script (by its hash), be framed by nobody (so its buttons, such as Approve
//   on a held tool call, cannot be clickjacked), set no `<base>` and embed no
//   plugin. A route that sets a stricter policy of its own keeps it, as
//   artifact downloads do (`sandbox`).
// - `X-Frame-Options: DENY` refuses framing in browsers that predate
//   `frame-ancestors`; `Referrer-Policy: no-referrer` keeps an address that
//   carries `?token=` out of `Referer`; `X-Content-Type-Options: nosniff`
//   stops browsers guessing types, so only what is declared a script or a
//   style sheet runs as one.
// - `Strict-Transport-Security` only when the app is opened over https
//   (API_PUBLIC_URL), so a browser that has seen it uses https only.
import type { MiddlewareHandler } from "hono";

/**
 * The web app's one inline script (apps/web/index.html: before the modules
 * run, it turns off Zod's eval probe and applies the saved theme before the
 * first paint), allowed by its SHA-256: the policy's only relaxation of
 * `'self'`. headers.test.ts fails when the script changes and this does not.
 */
export const INLINE_SCRIPT_HASHES = [
  "'sha256-1r0Vl90rl4UiJ/2FKwbrMehbnLeR9GevYFJdRLN8UGA='",
] as const;

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  `script-src 'self' ${INLINE_SCRIPT_HASHES.join(" ")}`,
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join("; ");

export const STRICT_TRANSPORT_SECURITY = "max-age=31536000";

export interface SecurityHeaderOptions {
  /** Send Strict-Transport-Security: the app is opened over https. */
  strictTransportSecurity: boolean;
}

export function securityHeaders(
  options: SecurityHeaderOptions,
): MiddlewareHandler {
  const fixed: [string, string][] = [
    ["X-Frame-Options", "DENY"],
    ["Referrer-Policy", "no-referrer"],
    ["X-Content-Type-Options", "nosniff"],
  ];
  if (options.strictTransportSecurity)
    fixed.push(["Strict-Transport-Security", STRICT_TRANSPORT_SECURITY]);
  const apply = (headers: Headers) => {
    if (!headers.has("Content-Security-Policy"))
      headers.set("Content-Security-Policy", CONTENT_SECURITY_POLICY);
    for (const [name, value] of fixed) headers.set(name, value);
  };
  return async (c, next) => {
    await next();
    try {
      apply(c.res.headers);
    } catch {
      // A response with immutable headers: answer a copy that has them.
      c.res = new Response(c.res.body, c.res);
      apply(c.res.headers);
    }
  };
}

/** Whether the address users open is https, so HSTS applies. */
export const isHttpsUrl = (url: string | undefined) =>
  url !== undefined && new URL(url).protocol === "https:";
