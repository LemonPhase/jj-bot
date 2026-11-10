// Security headers on every answer the server sends: the web app's pages and
// files, API answers and errors, the event streams, health and metrics.
//
// - The Content-Security-Policy lets a page load and connect to this origin
//   only, run no script but this origin's files and the web app's one inline
//   script (by its hash), be framed by nobody (so its buttons, such as Approve
//   on a held tool call, cannot be clickjacked), set no `<base>`, embed no
//   plugin and submit no form natively (the app's forms submit by script).
//   A route that sets a stricter policy of its own keeps it, as artifact
//   downloads do (`sandbox`).
// - `X-Frame-Options: DENY` refuses framing in browsers that predate
//   `frame-ancestors`; `Referrer-Policy: no-referrer` keeps the app's addresses
//   out of `Referer` (an old link's `?token=` too); `X-Content-Type-Options: nosniff`
//   stops browsers guessing types, so only what is declared a script or a
//   style sheet runs as one.
// - `Strict-Transport-Security` only when the app is opened over https
//   beyond loopback (API_PUBLIC_URL), so a browser that has seen it uses
//   https only.
import type { MiddlewareHandler } from "hono";
import { isLoopbackHost } from "./config";

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
  "form-action 'none'",
].join("; ");

export const STRICT_TRANSPORT_SECURITY = "max-age=31536000";

export interface SecurityHeaderOptions {
  /** Send Strict-Transport-Security: the app is opened over https. */
  strictTransportSecurity: boolean;
}

/** The headers every answer carries but its Content-Security-Policy. */
function fixedHeaders(options: SecurityHeaderOptions): [string, string][] {
  const fixed: [string, string][] = [
    ["X-Frame-Options", "DENY"],
    ["Referrer-Policy", "no-referrer"],
    ["X-Content-Type-Options", "nosniff"],
  ];
  if (options.strictTransportSecurity)
    fixed.push(["Strict-Transport-Security", STRICT_TRANSPORT_SECURITY]);
  return fixed;
}

/**
 * Every security header, for an answer written outside the app: deadlines.ts
 * writes a request's timeout straight to its socket.
 */
export const securityHeaderList = (
  options: SecurityHeaderOptions,
): [string, string][] => [
  ["Content-Security-Policy", CONTENT_SECURITY_POLICY],
  ...fixedHeaders(options),
];

export function securityHeaders(
  options: SecurityHeaderOptions,
): MiddlewareHandler {
  const fixed = fixedHeaders(options);
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

/**
 * Whether HSTS applies: users open the app at an https address beyond
 * loopback. Never for `https://localhost`, which would pin every local
 * service on that name, such as the Vite dev server, to https for a year.
 */
export function sendsHsts(url: string | undefined): boolean {
  if (url === undefined) return false;
  const { protocol, hostname } = new URL(url);
  return protocol === "https:" && !isLoopbackHost(hostname);
}
