import {
  type DriverCapabilities,
  sandboxLimitsSchema,
  sandboxSpecSchema,
} from "@jj/sandbox/contract";
import { z } from "zod";
import {
  hasSomeField,
  idSchema,
  modelRefSchema,
  SOME_FIELD_REQUIRED,
  timestampSchema,
} from "./common";

// The sandbox spec is owned by the driver contract; it is re-exported, never redefined.
export {
  type NetworkPolicy,
  networkPolicySchema,
  type ResourceLimits,
  resourceLimitsSchema,
  type SandboxLimits,
  type SandboxSpec,
  type SandboxSpecInput,
  sandboxLimitsSchema,
  sandboxSpecSchema,
  type WorkspaceMode,
  workspaceModeSchema,
} from "@jj/sandbox/contract";

/** Coding tools a profile can grant. They run inside the task's sandbox. */
export const CODING_TOOLS = [
  "bash",
  "read",
  "edit",
  "write",
  "grep",
  "find",
  "ls",
] as const;
export const toolNameSchema = z.enum(CODING_TOOLS);

/** Collaboration tools. Always available to task sessions, never listed in a profile. */
export const COLLABORATION_TOOLS = [
  "delegate",
  "message",
  "complete_task",
] as const;

const toolListSchema = z
  .array(toolNameSchema)
  .refine((tools) => new Set(tools).size === tools.length, {
    message: "Tools must be unique.",
  });

const maxTurnsPerRunSchema = z.number().int().min(1).max(500);
const maxRunMinutesSchema = z.number().int().min(1).max(240);

export const profileBudgetsSchema = z.object({
  maxTurnsPerRun: maxTurnsPerRunSchema.default(60),
  maxRunMinutes: maxRunMinutesSchema.default(30),
});

/**
 * Computed by the server from the profile's driver. `isolated` is the driver's
 * declared filesystem isolation; clients label a profile without it "Unisolated".
 */
export const runtimeProfileStatusSchema = z.object({
  driverAvailable: z.boolean(),
  isolated: z.boolean(),
  detail: z.string().optional(),
});

const profileNameSchema = z.string().trim().min(1).max(60);
const profileDescriptionSchema = z.string().trim().max(500);

export const runtimeProfileSchema = z.object({
  id: idSchema,
  name: profileNameSchema,
  description: profileDescriptionSchema.default(""),
  sandbox: sandboxSpecSchema,
  tools: toolListSchema.default(() => [...CODING_TOOLS]),
  budgets: profileBudgetsSchema,
  isDefault: z.boolean(),
  status: runtimeProfileStatusSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

/**
 * Creates a runtime profile. Omitted fields take server defaults: empty
 * description, every coding tool, default budgets, not the default profile.
 */
export const createRuntimeProfileCommandSchema = z.object({
  name: profileNameSchema,
  description: profileDescriptionSchema.optional(),
  sandbox: sandboxSpecSchema,
  tools: toolListSchema.optional(),
  budgets: profileBudgetsSchema.optional(),
  isDefault: z.boolean().optional(),
});

const spec = sandboxSpecSchema.shape;
const limits = sandboxLimitsSchema.shape;

/**
 * A sandbox spec change: every field optional and nothing defaulted, so an
 * omitted field never resets a stored one. Bounds come from the driver contract.
 */
export const sandboxSpecPatchSchema = z
  .object({
    driver: spec.driver,
    image: spec.image,
    resources: spec.resources.unwrap(),
    network: spec.network.unwrap(),
    workspace: spec.workspace.unwrap(),
    limits: z
      .object({
        execTimeoutMs: limits.execTimeoutMs.unwrap(),
        maxOutputBytes: limits.maxOutputBytes.unwrap(),
      })
      .partial(),
    env: spec.env.unwrap(),
    driverConfig: spec.driverConfig.unwrap(),
  })
  .partial();

/** The profile update command without its at-least-one-field refinement. */
export const updateRuntimeProfileCommandObjectSchema = z
  .object({
    name: profileNameSchema,
    description: profileDescriptionSchema,
    sandbox: sandboxSpecPatchSchema,
    tools: toolListSchema,
    budgets: z
      .object({
        maxTurnsPerRun: maxTurnsPerRunSchema,
        maxRunMinutes: maxRunMinutesSchema,
      })
      .partial(),
    isDefault: z.boolean(),
  })
  .partial();

/**
 * Partial update with no defaults. The server deep-merges it onto the stored
 * profile — nested objects field by field, while `tools`, `sandbox.network`,
 * `sandbox.env` and `sandbox.driverConfig` are replaced whole — then validates
 * the merged spec with the driver before saving.
 */
export const updateRuntimeProfileCommandSchema =
  updateRuntimeProfileCommandObjectSchema.refine(
    hasSomeField,
    SOME_FIELD_REQUIRED,
  );

export const driverCapabilitiesSchema = z.object({
  networkPolicy: z.boolean(),
  resourceLimits: z.boolean(),
  filesystemIsolation: z.boolean(),
  exposePort: z.boolean(),
  snapshot: z.boolean(),
  metrics: z.boolean(),
}) satisfies z.ZodType<DriverCapabilities>;

/** A sandbox driver as settings sees it. Forms are generated from `specJsonSchema`. */
export const sandboxDriverInfoSchema = z.object({
  id: idSchema,
  label: z.string().min(1),
  available: z.boolean(),
  detail: z.string().optional(),
  capabilities: driverCapabilitiesSchema,
  /** JSON Schema of the driver's spec, produced on the server with `z.toJSONSchema`. */
  specJsonSchema: z.record(z.string(), z.unknown()),
});

export const modelInfoSchema = z.object({
  ref: modelRefSchema,
  provider: z.string().min(1),
  id: z.string().min(1),
  name: z.string().min(1),
  reasoning: z.boolean(),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  input: z.array(z.enum(["text", "image"])),
  /** US dollars per million tokens. */
  cost: z
    .object({
      inputPerMTok: z.number().nonnegative(),
      outputPerMTok: z.number().nonnegative(),
    })
    .optional(),
});

/** A model provider. Keys are never entered through the product: `envVars` names what enables it. */
export const providerInfoSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  configured: z.boolean(),
  envVars: z.array(z.string().min(1)),
  models: z.array(modelInfoSchema),
});

/** `GET /api/models`. */
export const modelsViewSchema = z.object({
  defaultModel: modelRefSchema.nullable(),
  providers: z.array(providerInfoSchema),
});

export type ToolName = z.infer<typeof toolNameSchema>;
export type CollaborationToolName = (typeof COLLABORATION_TOOLS)[number];
export type ProfileBudgets = z.infer<typeof profileBudgetsSchema>;
export type RuntimeProfileStatus = z.infer<typeof runtimeProfileStatusSchema>;
export type RuntimeProfile = z.infer<typeof runtimeProfileSchema>;
export type CreateRuntimeProfileCommand = z.input<
  typeof createRuntimeProfileCommandSchema
>;
export type SandboxSpecPatch = z.input<typeof sandboxSpecPatchSchema>;
export type UpdateRuntimeProfileCommand = z.input<
  typeof updateRuntimeProfileCommandSchema
>;
export type SandboxDriverInfo = z.infer<typeof sandboxDriverInfoSchema>;
export type ModelInfo = z.infer<typeof modelInfoSchema>;
export type ProviderInfo = z.infer<typeof providerInfoSchema>;
export type ModelsView = z.infer<typeof modelsViewSchema>;
