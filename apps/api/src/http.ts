// Request parsing and the contract error envelope. Bodies are handed to the
// engine unparsed (it validates every command with its contract schema);
// params, query and headers are checked here with the contract's id schema.
import { createHash, timingSafeEqual } from "node:crypto";
import { DomainError, HTTP_STATUS, type Logger } from "@jj/backend";
import { type ApiError, type ApiErrorCode, idSchema, z } from "@jj/contracts";
import type { Context, MiddlewareHandler } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export const envelope = (
  code: ApiErrorCode,
  message: string,
  details?: unknown,
): ApiError => ({
  error: { code, message, ...(details === undefined ? {} : { details }) },
});

export function errorResponse(
  c: Context,
  status: number,
  code: ApiErrorCode,
  message: string,
  details?: unknown,
) {
  return c.json(
    envelope(code, message, details),
    status as ContentfulStatusCode,
  );
}

const isDomainError = (error: unknown): error is DomainError =>
  error instanceof DomainError ||
  (error instanceof Error &&
    error.name === "DomainError" &&
    typeof (error as { code?: unknown }).code === "string" &&
    (error as unknown as { code: string }).code in HTTP_STATUS);

/**
 * A refusal becomes its contract envelope and status. Anything else is a
 * server fault: logged here with its stack, answered without one.
 */
export function onError(logger: Logger) {
  return (error: unknown, c: Context) => {
    if (isDomainError(error))
      return errorResponse(
        c,
        HTTP_STATUS[error.code],
        error.code,
        error.message,
        error.details,
      );
    logger.error(`${c.req.method} ${c.req.path} failed`, {
      error: error instanceof Error ? (error.stack ?? error.message) : error,
    });
    return errorResponse(
      c,
      500,
      "INTERNAL",
      "The server failed to handle this request. The error is in the server log.",
    );
  };
}

const invalid = (message: string, details?: unknown) =>
  new DomainError("VALIDATION_FAILED", message, details);

/** A path parameter, checked with the contract's id schema. */
export function idParam(c: Context, name: string): string {
  const parsed = idSchema.safeParse(c.req.param(name));
  if (!parsed.success)
    throw invalid(`${name}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

const cursorSchema = z.coerce.number().int().nonnegative().max(2_147_483_647);
const limitSchema = z.coerce.number().int().min(1).max(500);

function parseNumber<Schema extends z.ZodType<number>>(
  schema: Schema,
  name: string,
  raw: string | undefined,
): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const parsed = schema.safeParse(raw.trim());
  if (!parsed.success)
    throw invalid(`${name}: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** `?after=` and `?limit=` of the event page. */
export const pageQuery = (c: Context) => ({
  after: parseNumber(cursorSchema, "after", c.req.query("after")),
  limit: parseNumber(limitSchema, "limit", c.req.query("limit")),
});

/** Where a task stream resumes: `Last-Event-ID` first, then `?after=`, else the start. */
export const resumeCursor = (c: Context): number =>
  parseNumber(cursorSchema, "Last-Event-ID", c.req.header("Last-Event-ID")) ??
  parseNumber(cursorSchema, "after", c.req.query("after")) ??
  0;

/** The JSON body, or undefined when there is none. */
export async function jsonBody(c: Context): Promise<unknown> {
  const raw = await c.req.text();
  if (raw.trim() === "") return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    throw invalid("The request body is not valid JSON.");
  }
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/**
 * Requires `Authorization: Bearer <token>`. Both tokens are hashed before the
 * constant-time compare, so neither their content nor their length leaks.
 */
export function bearerAuth(token: string): MiddlewareHandler {
  const expected = digest(token);
  return async (c, next) => {
    const match = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(
      c.req.header("Authorization") ?? "",
    );
    if (!match?.[1] || !timingSafeEqual(digest(match[1]), expected)) {
      c.header("WWW-Authenticate", 'Bearer realm="jj-bot"');
      return errorResponse(
        c,
        401,
        "UNAUTHORIZED",
        "This API requires Authorization: Bearer <API_TOKEN>.",
      );
    }
    await next();
  };
}

/**
 * `Content-Disposition` for a download: always an attachment, with an ASCII
 * fallback name and the exact name in RFC 5987 form.
 */
export function attachmentDisposition(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/^\.+/, "")
    .trim();
  const safe = base || "artifact";
  const ascii = safe.replace(/[^\x20-\x7e]/g, "_").replace(/["%;\\]/g, "_");
  const encoded = encodeURIComponent(safe).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
