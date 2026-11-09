import type { ApiErrorCode } from "@jj/contracts";
import type { z } from "zod";

/** A refusal the API returns as `{ error: { code, message, details? } }`. */
export class DomainError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
    /** A status other than the code's, where the contract names one (`VALIDATION_FAILED` with 422). */
    readonly statusOverride?: number,
  ) {
    super(message);
    this.name = "DomainError";
  }

  /** The HTTP status for this refusal: its code's, unless the contract names another. */
  get status(): number {
    return this.statusOverride ?? HTTP_STATUS[this.code];
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
  SPEND_CAP_REACHED: 409,
  APPROVAL_NOT_PENDING: 409,
  MODEL_NOT_CONFIGURED: 422,
  PROFILE_UNSUPPORTED: 422,
  PROFILE_IN_USE: 409,
  SECRET_STORE_UNAVAILABLE: 409,
  MCP_UNAVAILABLE: 422,
  MCP_SNAPSHOT_MISMATCH: 409,
  TEMPLATE_UNUSABLE: 409,
  UPLOAD_TOO_LARGE: 413,
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

/**
 * A unique-constraint violation from either driver (wrapped by Drizzle or
 * not); with `constraint`, only a violation of that constraint or index.
 */
export function isUniqueViolation(
  error: unknown,
  constraint?: string,
): boolean {
  for (let current = error, depth = 0; current && depth < 4; depth += 1) {
    const { code, constraint: violated } = current as {
      code?: unknown;
      constraint?: unknown;
    };
    if (code === "23505")
      return constraint === undefined || violated === constraint;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
