import type { ApiErrorCode } from "@jj/contracts";
import type { z } from "zod";

/** A refusal the API returns as `{ error: { code, message, details? } }`. */
export class DomainError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "DomainError";
  }

  /** The HTTP status for this code. */
  get status(): number {
    return HTTP_STATUS[this.code];
  }
}

export const HTTP_STATUS: Record<ApiErrorCode, number> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  TASK_TERMINAL: 409,
  STALE_GOAL_VERSION: 409,
  GOAL_VERSION_BUDGET: 409,
  VERIFICATION_UNAVAILABLE: 422,
  RATE_LIMITED: 429,
  MODEL_NOT_CONFIGURED: 422,
  PROFILE_UNSUPPORTED: 422,
  PROFILE_IN_USE: 409,
  UNAUTHORIZED: 401,
  INTERNAL: 500,
};

export const notFound = (what: string, id: string) =>
  new DomainError("NOT_FOUND", `${what} ${id} was not found.`);

/** Parses a command with its contract schema; a failure is VALIDATION_FAILED with the issues. */
export function parseCommand<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
): z.output<Schema> {
  const parsed = schema.safeParse(input);
  if (parsed.success) return parsed.data;
  throw new DomainError(
    "VALIDATION_FAILED",
    parsed.error.issues
      .map((issue) =>
        issue.path.length > 0
          ? `${issue.path.join(".")}: ${issue.message}`
          : issue.message,
      )
      .join("; "),
    parsed.error.issues,
  );
}

/** A unique-constraint violation from either driver (wrapped by Drizzle or not). */
export function isUniqueViolation(error: unknown): boolean {
  for (let current = error, depth = 0; current && depth < 4; depth += 1) {
    if ((current as { code?: unknown }).code === "23505") return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
