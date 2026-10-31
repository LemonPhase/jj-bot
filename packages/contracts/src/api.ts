import { z } from "zod";
import { botSchema } from "./bots";
import { idSchema, modelRefSchema } from "./common";
import { runtimeProfileSchema } from "./profiles";
import { taskSummarySchema } from "./tasks";

/** What this server can really do. Never report a capability that is not real. */
export const capabilitiesSchema = z.object({
  /** At least one model provider is configured. */
  agentExecution: z.boolean(),
  persistence: z.boolean(),
  streaming: z.boolean(),
  /** Verification plans are enforced. False in 1.0: plans are rejected. */
  verification: z.boolean(),
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
  "MODEL_NOT_CONFIGURED",
  "PROFILE_UNSUPPORTED",
  "PROFILE_IN_USE",
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
]);

export type Capabilities = z.infer<typeof capabilitiesSchema>;
export type Bootstrap = z.infer<typeof bootstrapSchema>;
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;
export type ApiError = z.infer<typeof apiErrorSchema>;
export type WorkspaceHint = z.infer<typeof workspaceHintSchema>;
export type WorkspaceHintType = WorkspaceHint["type"];
