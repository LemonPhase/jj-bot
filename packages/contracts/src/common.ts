import { z } from "zod";

/**
 * The API contract version. Bump the patch for clarifications, the minor for
 * additive changes and the major for breaking ones, and record every change in
 * docs/contract-changelog.md.
 */
export const CONTRACT_VERSION = "1.0.0";

/** Longest text a command accepts (messages, goals, instructions). */
export const COMMAND_TEXT_LIMIT = 20_000;
/**
 * Longest text a stored record may carry. Records hold what the engine
 * produced, which is not bound by command limits; this only rejects runaway values.
 */
export const RECORD_TEXT_LIMIT = 200_000;

export const idSchema = z.string().min(1).max(128);
export const timestampSchema = z.iso.datetime();

/** A model reference resolved through the server's provider registry: `provider/model`. */
export const modelRefSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._-]*\/\S+$/,
    "Use a provider/model reference, for example anthropic/<model-id>.",
  );

/** Unique, non-empty list of ids. */
export const idListSchema = z
  .array(idSchema)
  .refine((ids) => new Set(ids).size === ids.length, {
    message: "Ids must be unique.",
  });

/** Refinement for PATCH-style commands: at least one field must be present. */
export const hasSomeField = (command: Record<string, unknown>): boolean =>
  Object.values(command).some((value) => value !== undefined);
export const SOME_FIELD_REQUIRED = {
  message: "Provide at least one field to change.",
};

export type Id = z.infer<typeof idSchema>;
export type ModelRef = z.infer<typeof modelRefSchema>;
