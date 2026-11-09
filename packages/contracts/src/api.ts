import { z } from "zod";
import { botSchema } from "./bots";
import { idSchema, modelRefSchema } from "./common";
import { runtimeProfileSchema } from "./profiles";
import { taskSummarySchema } from "./tasks";
import { uploadLimitsSchema } from "./uploads";

/** What this server can really do. Never report a capability that is not real. */
export const capabilitiesSchema = z.object({
  /** At least one model provider is configured. */
  agentExecution: z.boolean(),
  persistence: z.boolean(),
  streaming: z.boolean(),
  /**
   * Verification plans are accepted and enforced: a task with a plan
   * completes only when every check passes. While false, a plan is refused
   * with VERIFICATION_UNAVAILABLE.
   */
  verification: z.boolean(),
  /** Keys and sandbox secrets can be stored encrypted: the server has `JJ_SECRET_KEY`. */
  secretStore: z.boolean().default(false),
  /**
   * Per kind, whether sessions can use MCP servers of that kind: `stdio`
   * ones run in a task's sandbox (where its driver can spawn processes),
   * `remote` (http) ones are called by the worker. While false, servers of
   * that kind may still be stored and discovered, but they reach no session.
   */
  mcp: z
    .object({ stdio: z.boolean(), remote: z.boolean() })
    .default({ stdio: false, remote: false }),
  /** The skills library exists and granted skills reach sessions. While false, a grant is refused with MCP_UNAVAILABLE. */
  skills: z.boolean().default(false),
  /**
   * Schedules are served (`/api/schedules`) and a worker's scheduler starts
   * them. While false, the schedule routes answer 404.
   */
  schedules: z.boolean().default(false),
  /**
   * Files can be uploaded into tasks, within these limits. Null: uploads
   * are not served, and the upload routes answer 404. Parsed as null from
   * servers before uploads.
   */
  uploads: uploadLimitsSchema.nullable().default(null),
  drivers: z.array(
    z.object({ id: idSchema, available: z.boolean(), isolated: z.boolean() }),
  ),
});

/** `GET /api/bootstrap`. */
export const bootstrapSchema = z.object({
  mode: z.enum(["backend", "scaffold"]),
  /** The server's CONTRACT_VERSION; a client compares it with its own. */
  contractVersion: z.string().min(1),
  capabilities: capabilitiesSchema,
  defaultModel: modelRefSchema.nullable(),
  /**
   * `JJ_EVENT_RETENTION_DAYS`: a finished task's events are compacted this
   * many days after it finished; 0 means never. Absent from servers before
   * event retention.
   */
  eventRetentionDays: z.number().int().min(0).max(3650).optional(),
  bots: z.array(botSchema),
  tasks: z.array(taskSummarySchema),
  profiles: z.array(runtimeProfileSchema),
});

export const API_ERROR_CODES = [
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "CONFLICT",
  "TASK_TERMINAL",
  "STALE_GOAL_VERSION",
  "GOAL_VERSION_BUDGET",
  "VERIFICATION_UNAVAILABLE",
  "RATE_LIMITED",
  "SPEND_CAP_REACHED",
  "APPROVAL_NOT_PENDING",
  "MODEL_NOT_CONFIGURED",
  "PROFILE_UNSUPPORTED",
  "PROFILE_IN_USE",
  "SECRET_STORE_UNAVAILABLE",
  /** A profile asks for MCP servers or skills this server or its driver cannot run. */
  "MCP_UNAVAILABLE",
  /** A server's pinned snapshot was discovered for another configuration: discover it again. */
  "MCP_SNAPSHOT_MISMATCH",
  /** A task template cannot start now: `details.problems` (`templateUnusableDetailsSchema`) says why. */
  "TEMPLATE_UNUSABLE",
  /** A task template a schedule starts cannot be deleted: `details.schedules` (`templateInUseDetailsSchema`) names them. */
  "TEMPLATE_IN_USE",
  /**
   * 413: an upload over the server's limits: a file, a command's files, a
   * task's uploads in all, or the server's staging space.
   */
  "UPLOAD_TOO_LARGE",
  "UNAUTHORIZED",
  "INTERNAL",
] as const;
export const apiErrorCodeSchema = z.enum(API_ERROR_CODES);

/** Every non-2xx JSON response. */
export const apiErrorSchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

/**
 * `GET /api/stream`: server-sent workspace hints telling clients what to
 * refetch. Not resumable; clients refetch what they show on (re)connect.
 *
 * The task stream is separate: `GET /api/tasks/:taskId/stream` sends one SSE
 * frame per task event with `id:` = event sequence, `event:` = event type and
 * `data:` = the TaskEvent JSON, resuming after `Last-Event-ID` or `?after=`.
 */
export const workspaceHintSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bots.changed"), botId: idSchema.optional() }),
  z.object({ type: z.literal("tasks.changed"), taskId: idSchema }),
  z.object({ type: z.literal("conversation.changed"), botId: idSchema }),
  z.object({ type: z.literal("profiles.changed") }),
  /** A sandbox secret or a stored provider key changed: refetch secrets and models. */
  z.object({ type: z.literal("secrets.changed") }),
  /** A task template was saved, changed or deleted: refetch the templates. */
  z.object({ type: z.literal("templates.changed") }),
  /** A schedule was saved, changed, deleted, fired or paused: refetch the schedules. */
  z.object({ type: z.literal("schedules.changed") }),
]);

export type Capabilities = z.infer<typeof capabilitiesSchema>;
export type Bootstrap = z.infer<typeof bootstrapSchema>;
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
export type WorkspaceHint = z.infer<typeof workspaceHintSchema>;
export type WorkspaceHintType = WorkspaceHint["type"];
