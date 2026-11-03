import {
  type DriverCapabilities,
  networkModeSchema,
  sandboxLimitsSchema,
  sandboxSpecSchema,
} from "@jj/sandbox/contract";
import { z } from "zod";
import {
  hasSomeField,
  idSchema,
  modelRefSchema,
  SOME_FIELD_REQUIRED,
  spendCapUsdSchema,
  timestampSchema,
} from "./common";
import {
  mcpServersSchema,
  mcpToolSelectorSchema,
  refineMcpSecretGrants,
} from "./mcp";
import { secretGrantsSchema, storedSecretSchema } from "./secrets";
import { skillGrantsSchema } from "./skills";

// The sandbox spec is owned by the driver contract; it is re-exported, never redefined.
export {
  type NetworkMode,
  type NetworkPolicy,
  networkModeSchema,
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

/**
 * Collaboration tools. Never listed in a profile: a task session gets the ones
 * its place in the task allows (`delegate` and `message` with teammates,
 * `complete_task` for the coordinator, the read-only lookup tools always).
 */
export const COLLABORATION_TOOLS = [
  "delegate",
  "message",
  "complete_task",
  "task_state",
  "task_log",
  "read_entry",
  "read_report",
] as const;

const toolListSchema = z
  .array(toolNameSchema)
  .refine((tools) => new Set(tools).size === tools.length, {
    message: "Tools must be unique.",
  });

/** Longest `match` of an approval rule, in UTF-16 code units. */
export const APPROVAL_MATCH_LIMIT = 200;
/** Most approval rules a profile holds. */
export const MAX_APPROVAL_RULES = 50;

/**
 * A kind of call that waits for the user's approval before it runs: every
 * call of `tool`, or only those whose subject contains `match` (see
 * `approvalRuleMatches`). `tool` is a coding tool, one MCP tool
 * (`mcp__<server>__<tool>`) or every tool of an MCP server
 * (`mcp__<server>__*`). Rules guide a cooperative model; they are not a
 * security boundary: a command can reach the same effect in ways no text
 * rule foresees, such as a script it wrote. The sandbox and its network
 * policy remain the boundary. On a remote MCP server's tools a rule without
 * `match` does stop the effect, since only the worker holds that server's
 * credentials. A rule with `match` is a text check there too: a call can
 * evade it, for instance by splitting a value across keys, as with bash.
 */
export const approvalRuleSchema = z.object({
  tool: z.union([toolNameSchema, mcpToolSelectorSchema]),
  /**
   * Case-sensitive text, found anywhere in the call's subject; `*` stands
   * for any run of characters, and a run of whitespace for any other.
   */
  match: z.string().trim().min(1).max(APPROVAL_MATCH_LIMIT).optional(),
});

const approvalRulesSchema = z.array(approvalRuleSchema).max(MAX_APPROVAL_RULES);

const maxTurnsPerRunSchema = z.number().int().min(1).max(500);
const maxRunMinutesSchema = z.number().int().min(1).max(240);

/** Default spend caps, in US dollars. A stored profile without a cap key takes these on read. */
export const DEFAULT_MAX_USD_PER_TASK = 5;
export const DEFAULT_MAX_USD_PER_BOT_PER_DAY = 20;

/**
 * Turn and time budgets per run, and spend caps. `null` means no cap.
 * - `maxUsdPerTask`: the cap a task gets when this is its coordinator's
 *   profile, copied onto the task (`task.spendCapUsd`) when it is created.
 * - `maxUsdPerBotPerDay`: what each bot on this profile may spend in any
 *   rolling 24 hours, task sessions and direct chat together.
 * Caps count model calls with a listed price only (see `usageSchema`).
 */
export const profileBudgetsSchema = z.object({
  maxTurnsPerRun: maxTurnsPerRunSchema.default(60),
  maxRunMinutes: maxRunMinutesSchema.default(30),
  maxUsdPerTask: spendCapUsdSchema.nullable().default(DEFAULT_MAX_USD_PER_TASK),
  maxUsdPerBotPerDay: spendCapUsdSchema
    .nullable()
    .default(DEFAULT_MAX_USD_PER_BOT_PER_DAY),
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
  /** Calls of this profile's bots that wait for the user's approval. None by default. */
  approvals: approvalRulesSchema.default(() => []),
  /**
   * Sandbox secrets, by name, injected into every command of a sandbox
   * acquired with this profile: a task's sandbox uses its coordinator's
   * profile, so every bot in the task can use them.
   */
  secrets: z.array(z.string().min(1)).default([]),
  /**
   * MCP servers whose tools this profile's bots may call (see `mcp.ts`).
   * Parsed as empty from servers before MCP.
   */
  mcpServers: mcpServersSchema.default(() => []),
  /** Skills from the library granted to this profile's bots, by name. Parsed as empty from servers before skills. */
  skills: skillGrantsSchema.default(() => []),
  isDefault: z.boolean(),
  status: runtimeProfileStatusSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});

/**
 * Creates a runtime profile. Omitted fields take server defaults: empty
 * description, every coding tool, default budgets, no secrets, no approval
 * rules, no MCP servers, no skills, not the default profile. Granted secrets
 * must be stored, and each stdio server's `secretEnv` must name secrets the
 * same command grants.
 */
export const createRuntimeProfileCommandSchema = z
  .object({
    name: profileNameSchema,
    description: profileDescriptionSchema.optional(),
    sandbox: sandboxSpecSchema,
    tools: toolListSchema.optional(),
    budgets: profileBudgetsSchema.optional(),
    approvals: approvalRulesSchema.optional(),
    secrets: secretGrantsSchema.optional(),
    mcpServers: mcpServersSchema.optional(),
    skills: skillGrantsSchema.optional(),
    isDefault: z.boolean().optional(),
  })
  .superRefine((command, context) =>
    refineMcpSecretGrants(
      command.mcpServers ?? [],
      command.secrets ?? [],
      context,
    ),
  );

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
        maxUsdPerTask: spendCapUsdSchema.nullable(),
        maxUsdPerBotPerDay: spendCapUsdSchema.nullable(),
      })
      .partial(),
    approvals: approvalRulesSchema,
    secrets: secretGrantsSchema,
    mcpServers: mcpServersSchema,
    skills: skillGrantsSchema,
    isDefault: z.boolean(),
  })
  .partial();

/**
 * Partial update with no defaults. The server deep-merges it onto the stored
 * profile — nested objects field by field, while `tools`, `secrets`,
 * `approvals`, `mcpServers`, `skills`, `sandbox.network`, `sandbox.env` and
 * `sandbox.driverConfig` are replaced whole — then validates the merged spec
 * with the driver, and the merged `mcpServers` against the merged `secrets`,
 * before saving. A patch that carries both is checked here too.
 */
export const updateRuntimeProfileCommandSchema =
  updateRuntimeProfileCommandObjectSchema
    .refine(hasSomeField, SOME_FIELD_REQUIRED)
    .superRefine((command, context) => {
      if (command.mcpServers && command.secrets)
        refineMcpSecretGrants(command.mcpServers, command.secrets, context);
    });

export const driverCapabilitiesSchema = z.object({
  /** Network modes the driver can enforce; a spec asking for another mode is refused. */
  networkModes: z.array(networkModeSchema),
  resourceLimits: z.boolean(),
  filesystemIsolation: z.boolean(),
  exposePort: z.boolean(),
  snapshot: z.boolean(),
  metrics: z.boolean(),
  /** Long-lived processes with streamed input and output, such as stdio MCP servers. Parsed as false from servers before it. */
  spawn: z.boolean().default(false),
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

/**
 * A model provider. `envVars` names the server variables that enable it; a
 * key can also be stored through settings. The variable wins: `keySource` is
 * where the key in use comes from (null: none, or a keyless provider), and
 * `storedKey` describes a stored one, even while a variable shadows it.
 */
export const providerInfoSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  configured: z.boolean(),
  envVars: z.array(z.string().min(1)),
  keySource: z.enum(["env", "stored"]).nullable().default(null),
  storedKey: storedSecretSchema.nullable().default(null),
  models: z.array(modelInfoSchema),
});

/** `GET /api/models`. */
export const modelsViewSchema = z.object({
  defaultModel: modelRefSchema.nullable(),
  providers: z.array(providerInfoSchema),
});

export type ToolName = z.infer<typeof toolNameSchema>;
/** What an approval rule's `tool` names: a coding tool, an MCP tool or `mcp__<server>__*`. */
export type ApprovalRuleTool = z.infer<typeof approvalRuleSchema>["tool"];
export type CollaborationToolName = (typeof COLLABORATION_TOOLS)[number];
export type ProfileBudgets = z.infer<typeof profileBudgetsSchema>;
export type ApprovalRule = z.infer<typeof approvalRuleSchema>;
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
