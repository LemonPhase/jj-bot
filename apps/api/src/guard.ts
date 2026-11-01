// Keeps web pages the user happens to visit from driving the API through
// their browser. Applied to every `/api/*` request (the JSON check after auth):
//
// - `Sec-Fetch-Site: cross-site` is refused (403).
// - Without API_TOKEN, only loopback `Host` values (`localhost`, `127.0.0.1`,
//   `[::1]`, any port) and API_ALLOWED_HOSTS pass (403 otherwise). A page that
//   rebinds its own name to 127.0.0.1 still sends that name as `Host`.
// - POST, PUT and PATCH need `Content-Type: application/json` (415 otherwise).
//   A cross-origin JSON request needs a CORS preflight, and the API sends no
//   CORS headers, so the browser never sends it.
import type { Context, MiddlewareHandler } from "hono";
import { errorResponse } from "./http";

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

/** The hostname of a `Host` value, lowercased, IPv6 kept in brackets. */
export function hostnameOf(host: string): string {
  const value = host.trim().toLowerCase();
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    return end < 0 ? value : value.slice(0, end + 1);
  }
  const colon = value.indexOf(":");
  return colon < 0 ? value : value.slice(0, colon);
}

/**
 * Whether a request's `Host` may reach an API without a token: a loopback
 * name with any port, or an API_ALLOWED_HOSTS entry (a hostname, any port, or
 * an exact `host:port`).
 */
export function isAllowedHost(
  host: string,
  allowedHosts: readonly string[],
): boolean {
  const value = host.trim().toLowerCase();
  if (!value) return false;
  const hostname = hostnameOf(value);
  if (LOOPBACK_HOSTNAMES.has(hostname)) return true;
  return allowedHosts.some((entry) => {
    const allowed = entry.trim().toLowerCase();
    return allowed === value || (allowed === hostname && !hasPort(allowed));
  });
}

const hasPort = (host: string) =>
  host.startsWith("[") ? host.includes("]:") : host.includes(":");

/** The request's `Host`: the header, else the URL's host (in-process requests). */
const requestHost = (c: Context) =>
  c.req.header("Host") ?? new URL(c.req.url).host;

const mediaType = (contentType: string | undefined) =>
  (contentType ?? "").split(";")[0]?.trim().toLowerCase() ?? "";

export interface GuardOptions {
  /** With a token, the bearer check protects the API and Host is not checked. */
  tokenRequired: boolean;
  /** API_ALLOWED_HOSTS: names a reverse proxy forwards as `Host`. */
  allowedHosts: readonly string[];
}

/** Refuses cross-site requests and, without a token, hosts that are not allowed. */
export function originGuard(options: GuardOptions): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.header("Sec-Fetch-Site")?.trim().toLowerCase() === "cross-site")
      return errorResponse(
        c,
        403,
        "UNAUTHORIZED",
        "Cross-site requests are refused: the JJ Bot API only serves its own web app.",
      );
    if (!options.tokenRequired) {
      const host = requestHost(c);
      if (!isAllowedHost(host, options.allowedHosts))
        return errorResponse(
          c,
          403,
          "UNAUTHORIZED",
          `Host "${host}" is not allowed. Without API_TOKEN the API answers only loopback hosts (localhost, 127.0.0.1, [::1]); add the name clients use to API_ALLOWED_HOSTS, or set API_TOKEN.`,
        );
    }
    await next();
  };
}

/** POST, PUT and PATCH need `Content-Type: application/json`, body or not. */
export function requireJson(): MiddlewareHandler {
  return async (c, next) => {
    if (
      BODY_METHODS.has(c.req.method) &&
      mediaType(c.req.header("Content-Type")) !== "application/json"
    )
      return errorResponse(
        c,
        415,
        "VALIDATION_FAILED",
        `${c.req.method} requests need Content-Type: application/json.`,
      );
    await next();
  };
}
