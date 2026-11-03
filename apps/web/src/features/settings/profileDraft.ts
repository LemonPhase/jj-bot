import {
  CODING_TOOLS,
  type CreateRuntimeProfileCommand,
  DEFAULT_MAX_USD_PER_BOT_PER_DAY,
  DEFAULT_MAX_USD_PER_TASK,
  MAX_SPEND_CAP_USD,
  type RuntimeProfile,
  type SandboxSpecPatch,
  type ToolName,
  type UpdateRuntimeProfileCommand,
} from "@jj/contracts";
import {
  draftFromSpec,
  type FieldErrors,
  readSpecDraft,
  type SpecDraft,
  type SpecField,
} from "./specForm";

/**
 * The runtime-profile form: its text draft, validation, the create command,
 * and the PATCH for an edit. The server deep-merges a PATCH onto the stored
 * profile (nested objects field by field; `tools`, `secrets`,
 * `sandbox.network`, `sandbox.env` and `sandbox.driverConfig` replaced
 * whole; a driver change
 * drops the old image and driverConfig), so the patch carries only what
 * changed, at that granularity, and never a default.
 */

export interface ProfileDraft {
  name: string;
  description: string;
  driver: string;
  /** The generated sandbox fields; see specForm.ts. */
  spec: SpecDraft;
  tools: readonly ToolName[];
  /** Granted sandbox secrets, by name. */
  secrets: readonly string[];
  maxTurnsPerRun: string;
  maxRunMinutes: string;
  /** US dollars; empty for no cap. */
  maxUsdPerTask: string;
  maxUsdPerBotPerDay: string;
  /** Create only: make the new profile the default. */
  isDefault: boolean;
}

/** Budget bounds and defaults, as in the contract's `profileBudgetsSchema`. */
export const BUDGETS = {
  maxTurnsPerRun: { label: "Max turns per run", min: 1, max: 500, default: 60 },
  maxRunMinutes: {
    label: "Max minutes per run",
    min: 1,
    max: 240,
    default: 30,
  },
} as const;

export type BudgetKey = keyof typeof BUDGETS;

/** Spend caps, as in the contract's `profileBudgetsSchema`: US dollars, null for no cap. */
export const SPEND_CAPS = {
  maxUsdPerTask: {
    label: "Spend cap per task (USD)",
    hint: `What one task this profile coordinates may spend; it is copied onto the task when it starts. Empty for no cap. Default $${DEFAULT_MAX_USD_PER_TASK}.`,
    default: DEFAULT_MAX_USD_PER_TASK,
  },
  maxUsdPerBotPerDay: {
    label: "Spend cap per bot per day (USD)",
    hint: `What each bot on this profile may spend in any 24 hours, tasks and chat together. Empty for no cap. Default $${DEFAULT_MAX_USD_PER_BOT_PER_DAY}.`,
    default: DEFAULT_MAX_USD_PER_BOT_PER_DAY,
  },
} as const;

export type SpendCapKey = keyof typeof SPEND_CAPS;

/** A valid draft: what the profile should be once saved. */
export interface DesiredProfile {
  name: string;
  description: string;
  sandbox: { driver: string } & Record<string, unknown>;
  tools: ToolName[];
  secrets: string[];
  budgets: Record<BudgetKey, number> & Record<SpendCapKey, number | null>;
  isDefault: boolean;
}

export type ProfileErrors = FieldErrors;

export function newProfileDraft(
  driver: string,
  fields: readonly SpecField[],
): ProfileDraft {
  return {
    name: "",
    description: "",
    driver,
    spec: draftFromSpec(fields),
    tools: [...CODING_TOOLS],
    secrets: [],
    maxTurnsPerRun: String(BUDGETS.maxTurnsPerRun.default),
    maxRunMinutes: String(BUDGETS.maxRunMinutes.default),
    maxUsdPerTask: String(SPEND_CAPS.maxUsdPerTask.default),
    maxUsdPerBotPerDay: String(SPEND_CAPS.maxUsdPerBotPerDay.default),
    isDefault: false,
  };
}

export function draftFromProfile(
  profile: RuntimeProfile,
  fields: readonly SpecField[],
): ProfileDraft {
  return {
    name: profile.name,
    description: profile.description,
    driver: profile.sandbox.driver,
    spec: draftFromSpec(fields, profile.sandbox),
    tools: [...profile.tools],
    secrets: [...profile.secrets],
    maxTurnsPerRun: String(profile.budgets.maxTurnsPerRun),
    maxRunMinutes: String(profile.budgets.maxRunMinutes),
    maxUsdPerTask: capText(profile.budgets.maxUsdPerTask),
    maxUsdPerBotPerDay: capText(profile.budgets.maxUsdPerBotPerDay),
    isDefault: profile.isDefault,
  };
}

const capText = (cap: number | null) => (cap === null ? "" : String(cap));

/** A spend cap from its input: empty is no cap (null). */
function readSpendCap(
  key: SpendCapKey,
  text: string,
  errors: Record<string, string>,
): number | null {
  if (!text.trim()) return null;
  const value = Number(text.trim());
  if (!Number.isFinite(value) || value <= 0 || value > MAX_SPEND_CAP_USD)
    errors[key] =
      `Enter an amount above 0 and at most ${MAX_SPEND_CAP_USD}, or leave it empty for no cap.`;
  return value;
}

/** Tools in the contract's order, without duplicates. */
const orderedTools = (tools: readonly ToolName[]): ToolName[] =>
  CODING_TOOLS.filter((tool) => tools.includes(tool));

function readBudget(
  key: BudgetKey,
  text: string,
  errors: Record<string, string>,
): number {
  const { min, max } = BUDGETS[key];
  const value = Number(text.trim());
  if (!text.trim() || !Number.isInteger(value) || value < min || value > max)
    errors[key] = `Enter a whole number from ${min} to ${max}.`;
  return value;
}

/** Validates the draft. `value` is set only when there are no errors. */
export function readProfileDraft(
  draft: ProfileDraft,
  fields: readonly SpecField[],
): { value?: DesiredProfile; errors: ProfileErrors } {
  const errors: Record<string, string> = {};
  const name = draft.name.trim();
  if (!name) errors.name = "Give the profile a name.";
  else if (name.length > 60) errors.name = "At most 60 characters.";
  const description = draft.description.trim();
  if (description.length > 500) errors.description = "At most 500 characters.";
  if (!draft.driver) errors.driver = "Choose a driver.";
  const spec = readSpecDraft(fields, draft.spec);
  Object.assign(errors, spec.errors);
  const budgets = {
    maxTurnsPerRun: readBudget("maxTurnsPerRun", draft.maxTurnsPerRun, errors),
    maxRunMinutes: readBudget("maxRunMinutes", draft.maxRunMinutes, errors),
    maxUsdPerTask: readSpendCap("maxUsdPerTask", draft.maxUsdPerTask, errors),
    maxUsdPerBotPerDay: readSpendCap(
      "maxUsdPerBotPerDay",
      draft.maxUsdPerBotPerDay,
      errors,
    ),
  };
  if (Object.keys(errors).length > 0) return { errors };
  return {
    errors,
    value: {
      name,
      description,
      sandbox: { ...spec.value, driver: draft.driver },
      tools: orderedTools(draft.tools),
      secrets: [...draft.secrets].sort(),
      budgets,
      isDefault: draft.isDefault,
    },
  };
}

/** `POST /api/runtime-profiles`: everything the form holds; empty inputs take server defaults. */
export function createProfileCommand(
  value: DesiredProfile,
): CreateRuntimeProfileCommand {
  return {
    name: value.name,
    ...(value.description ? { description: value.description } : {}),
    sandbox: value.sandbox,
    tools: value.tools,
    budgets: value.budgets,
    ...(value.secrets.length > 0 ? { secrets: value.secrets } : {}),
    ...(value.isDefault ? { isDefault: true } : {}),
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Structural equality for JSON values (key order ignored). */
export function sameJson(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((item, index) => sameJson(item, b[index]))
    );
  if (isRecord(a) && isRecord(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].every((key) => sameJson(a[key], b[key]));
  }
  return a === b;
}

const CANNOT_REMOVE =
  "A saved value can't be removed, only changed. Create a new profile to drop it.";

/**
 * Diffs one level of generated fields. Groups recurse because the server
 * merges them key by key; variants, maps and lists are compared and sent
 * whole because the server replaces them. An emptied input means the schema
 * default when there is one; without a default it cannot be expressed in a
 * PATCH (the contract has no "unset"), which is reported as an error.
 */
function diffFields(
  fields: readonly SpecField[],
  stored: Record<string, unknown>,
  desired: Record<string, unknown>,
  patch: Record<string, unknown>,
  errors: Record<string, string>,
): void {
  for (const field of fields) {
    const name = field.path[field.path.length - 1] ?? field.key;
    if (field.kind === "group") {
      const child: Record<string, unknown> = {};
      diffFields(
        field.fields,
        isRecord(stored[name]) ? stored[name] : {},
        isRecord(desired[name]) ? desired[name] : {},
        child,
        errors,
      );
      if (Object.keys(child).length > 0) patch[name] = child;
      continue;
    }
    const before = stored[name] ?? field.defaultValue;
    const after = desired[name] ?? field.defaultValue;
    if (sameJson(before, after)) continue;
    if (after === undefined) errors[field.key] = CANNOT_REMOVE;
    else patch[name] = after;
  }
}

/**
 * `PATCH /api/runtime-profiles/:id` for an edit: only what changed, or null
 * when nothing did. `fields` are the generated fields of the desired driver.
 */
export function profilePatch(
  stored: RuntimeProfile,
  desired: DesiredProfile,
  fields: readonly SpecField[],
): { patch: UpdateRuntimeProfileCommand | null; errors: ProfileErrors } {
  const patch: UpdateRuntimeProfileCommand = {};
  const errors: Record<string, string> = {};

  if (desired.name !== stored.name) patch.name = desired.name;
  if (desired.description !== stored.description)
    patch.description = desired.description;

  const switching = desired.sandbox.driver !== stored.sandbox.driver;
  // Changing the driver drops the stored image and driverConfig on the server.
  const base: Record<string, unknown> = switching
    ? { ...stored.sandbox, image: undefined, driverConfig: {} }
    : { ...stored.sandbox };
  const sandbox: Record<string, unknown> = {};
  if (switching) sandbox.driver = desired.sandbox.driver;
  diffFields(fields, base, desired.sandbox, sandbox, errors);
  if (Object.keys(sandbox).length > 0)
    patch.sandbox = sandbox as SandboxSpecPatch;

  if (!sameJson(orderedTools(stored.tools), orderedTools(desired.tools)))
    patch.tools = orderedTools(desired.tools);

  if (!sameJson([...stored.secrets].sort(), desired.secrets))
    patch.secrets = desired.secrets;

  const budgets: Partial<DesiredProfile["budgets"]> = {};
  for (const key of Object.keys(BUDGETS) as BudgetKey[])
    if (desired.budgets[key] !== stored.budgets[key])
      budgets[key] = desired.budgets[key];
  for (const key of Object.keys(SPEND_CAPS) as SpendCapKey[])
    if (desired.budgets[key] !== stored.budgets[key])
      budgets[key] = desired.budgets[key];
  if (Object.keys(budgets).length > 0) patch.budgets = budgets;

  // The default moves by making another profile the default, never by unsetting it.
  if (desired.isDefault && !stored.isDefault) patch.isDefault = true;

  if (Object.keys(errors).length > 0) return { patch: null, errors };
  return { patch: Object.keys(patch).length > 0 ? patch : null, errors };
}
