// Request ids and the request log. Every request gets an id: a well-formed
// `X-Request-Id` from a proxy in front, else a new one. It is answered in
// `X-Request-Id` and carried by every line logged while the request is
// handled, the engine's included. Each request is logged once its response
// starts: a health probe at debug whatever it answers (its checks log their
// own failures), a failure (5xx) as a warning, a refusal (4xx) or a change
// (any method but GET, HEAD and OPTIONS) at info, and a read that succeeded,
// a scrape included, at debug. The path is logged without its query, which
// can carry `?token=`.
import { randomBytes } from "node:crypto";
import { type Logger, withLogFields } from "@jj/backend";
import type { MiddlewareHandler } from "hono";

/** What a proxy's id may look like to be kept; anything else is replaced. */
const INCOMING_ID = /^[A-Za-z0-9._:-]{1,64}$/;

export const newRequestId = () =>
  `req_${randomBytes(12).toString("base64url")}`;

const READS = new Set(["GET", "HEAD", "OPTIONS"]);

const isHealth = (path: string) =>
  path === "/health" || path.startsWith("/health/");

export function requestLog(logger: Logger): MiddlewareHandler {
  return async (c, next) => {
    const incoming = c.req.header("X-Request-Id")?.trim();
    const requestId =
      incoming && INCOMING_ID.test(incoming) ? incoming : newRequestId();
    const startedAt = performance.now();
    await withLogFields({ requestId }, () => next(), true);
    try {
      c.res.headers.set("X-Request-Id", requestId);
    } catch {
      // A response with immutable headers keeps its own.
    }
    const { method, path } = c.req;
    const status = c.res.status;
    const fields = {
      method,
      path,
      status,
      durationMs: Math.round(performance.now() - startedAt),
    };
    const message = `${method} ${path} ${status}`;
    withLogFields(
      { requestId },
      () => {
        if (isHealth(path)) logger.debug?.(message, fields);
        else if (status >= 500) logger.warn(message, fields);
        else if (status < 400 && READS.has(method))
          logger.debug?.(message, fields);
        else logger.info(message, fields);
      },
      true,
    );
  };
}
