import type { SandboxDriverInfo } from "@jj/contracts";

/**
 * Generates the sandbox part of the runtime-profile form from a driver's
 * `specJsonSchema` (JSON Schema 2020-12, produced on the server with
 * `z.toJSONSchema(spec, { io: "input" })`), and converts between the form's
 * text draft and spec values.
 *
 * The schema decides which fields exist, their kinds, bounds and defaults;
 * `SPEC_PRESENTATION` only adds labels, hints and units, and the driver's
 * `capabilities` narrow the choices (network modes). Kinds:
 *
 *   string                          → text
 *   string + enum                   → choice
 *   number | integer                → number (bounds from minimum/maximum/exclusive*)
 *   array of strings                → list (one item per line)
 *   object + properties             → group (fields merged one by one on save)
 *   object + additionalProperties   → map ("KEY=value" per line; string values only)
 *   oneOf objects sharing a `const` → variant (a choice plus each variant's fields)
 *
 * Anything else (free-form objects such as `driverConfig`) is left out: the UI
 * never sends what it cannot describe.
 */

export type DriverCapabilities = SandboxDriverInfo["capabilities"];
type JsonSchema = Readonly<Record<string, unknown>>;

interface FieldBase {
  /** Dotted path, the draft key: "resources.cpus". */
  key: string;
  path: readonly string[];
  label: string;
  hint?: string;
  /** The schema's `default`, raw. An empty input stands for it. */
  defaultValue?: unknown;
}

export interface TextField extends FieldBase {
  kind: "text";
  minLength: number;
  maxLength?: number;
  required: boolean;
  placeholder?: string;
}

export interface NumberField extends FieldBase {
  kind: "number";
  integer: boolean;
  minimum?: number;
  exclusiveMinimum?: number;
  maximum?: number;
  exclusiveMaximum?: number;
  unit?: string;
}

export interface ChoiceOption {
  value: string;
  label: string;
}

export interface ChoiceField extends FieldBase {
  kind: "choice";
  /** What the form offers: the schema's enum narrowed by the driver. */
  options: ChoiceOption[];
  /** Every value the schema accepts, offered or not (a stored value may be outside `options`). */
  values: string[];
}

export interface VariantOption extends ChoiceOption {
  fields: SpecField[];
}

export interface VariantField extends FieldBase {
  kind: "variant";
  /** The property whose `const` tells the variants apart ("mode"). */
  discriminator: string;
  options: VariantOption[];
  /** Every variant, offered or not. */
  variants: VariantOption[];
}

export interface ListField extends FieldBase {
  kind: "list";
  minItems: number;
  maxItems?: number;
  itemMinLength: number;
}

export interface MapField extends FieldBase {
  kind: "map";
  keyMinLength: number;
}

export interface GroupField extends FieldBase {
  kind: "group";
  fields: SpecField[];
  /** Shown above the group, e.g. when the driver cannot enforce it. */
  note?: string;
}

export type SpecField =
  | TextField
  | NumberField
  | ChoiceField
  | VariantField
  | ListField
  | MapField
  | GroupField;

/** Labels and narrowing for the spec fields JJ Bot knows; unknown fields get a humanised label. */
interface Presentation {
  label?: string;
  hint?: string;
  unit?: string;
  placeholder?: string;
  optionLabels?: Readonly<Record<string, string>>;
  /** Values never offered (still accepted when already stored). */
  exclude?: readonly string[];
  /** Values the driver can enforce; others are not offered. */
  allowed?: (capabilities: DriverCapabilities) => readonly string[];
  /** Leave the field out of the form entirely. */
  hidden?: boolean;
  /** A note for a group, given the driver. */
  note?: (capabilities: DriverCapabilities) => string | undefined;
}

export const SPEC_PRESENTATION: Readonly<Record<string, Presentation>> = {
  // Chosen in its own select above the generated fields.
  driver: { hidden: true },
  image: {
    label: "Image",
    hint: "The driver's image reference. Empty uses the driver's default; a driver without images refuses one.",
    placeholder: "e.g. node:22-bookworm-slim",
  },
  network: {
    label: "Network",
    optionLabels: { none: "None", allowlist: "Allowlist", open: "Open" },
    allowed: (capabilities) => capabilities.networkModes,
  },
  "network.hosts": { label: "Allowed hosts", hint: "One host per line." },
  resources: {
    label: "Resources",
    hint: "Empty means no limit.",
    note: (capabilities) =>
      capabilities.resourceLimits
        ? undefined
        : "This driver cannot enforce resource limits; leave them empty.",
  },
  "resources.cpus": { label: "CPUs" },
  "resources.memoryMb": { label: "Memory", unit: "MB" },
  // No in-tree driver enforces a disk size (Docker refuses it: named volumes have no size limit).
  "resources.diskMb": { hidden: true },
  "resources.processes": { label: "Processes" },
  workspace: {
    label: "Workspace",
    optionLabels: { task: "Task", ephemeral: "Ephemeral" },
    // A bot workspace would expose a coordinator's files from earlier tasks
    // to every participant of a later one; task execution never uses it.
    exclude: ["bot"],
    hint: "Task: kept for the task and shared by its sessions. Ephemeral: fresh for every run, then discarded.",
  },
  limits: { label: "Limits", hint: "Empty uses the default." },
  "limits.execTimeoutMs": { label: "Command timeout", unit: "ms" },
  "limits.maxOutputBytes": { label: "Output cap", unit: "bytes" },
  env: {
    label: "Environment",
    hint: "One KEY=value per line. Stored with the profile, so never put secrets here.",
    placeholder: "NODE_ENV=test",
  },
};

/** Draft fields that belong to one driver and are cleared when the driver changes. */
export const DRIVER_SPECIFIC_KEYS: readonly string[] = ["image"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

const humanise = (key: string) => {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

function optionsFor(
  values: readonly string[],
  presentation: Presentation,
  capabilities: DriverCapabilities,
): ChoiceOption[] {
  const allowed = presentation.allowed?.(capabilities);
  return values
    .filter((value) => !presentation.exclude?.includes(value))
    .filter((value) => !allowed || allowed.includes(value))
    .map((value) => ({
      value,
      label: presentation.optionLabels?.[value] ?? value,
    }));
}

/** The const value of `property` in every branch, or null if any branch lacks one. */
function discriminatorOf(branches: readonly JsonSchema[]): string | null {
  const first = branches[0]?.properties;
  if (!isRecord(first)) return null;
  for (const key of Object.keys(first)) {
    const consts = branches.map((branch) => {
      const props = branch.properties;
      const prop = isRecord(props) ? props[key] : undefined;
      return isRecord(prop) && typeof prop.const === "string"
        ? prop.const
        : null;
    });
    if (consts.every((value) => value !== null)) return key;
  }
  return null;
}

function mapField(
  key: string,
  path: readonly string[],
  schema: JsonSchema,
  capabilities: DriverCapabilities,
  presentations: Readonly<Record<string, Presentation>>,
): SpecField | null {
  const presentation = presentations[key] ?? {};
  if (presentation.hidden) return null;
  const base = {
    key,
    path,
    label: presentation.label ?? humanise(path[path.length - 1] ?? key),
    hint: presentation.hint,
    defaultValue: schema.default,
  };

  if (Array.isArray(schema.oneOf)) {
    const branches = schema.oneOf.filter(isRecord);
    const discriminator = discriminatorOf(branches);
    if (!discriminator || branches.length !== schema.oneOf.length) return null;
    const variants: VariantOption[] = branches.map((branch) => {
      const props = isRecord(branch.properties) ? branch.properties : {};
      const tag = props[discriminator];
      const value = isRecord(tag) ? String(tag.const) : "";
      return {
        value,
        label: presentation.optionLabels?.[value] ?? value,
        fields: childFields(
          props,
          path,
          capabilities,
          presentations,
          new Set([discriminator]),
        ),
      };
    });
    const offered = new Set(
      optionsFor(
        variants.map((variant) => variant.value),
        presentation,
        capabilities,
      ).map((option) => option.value),
    );
    return {
      ...base,
      kind: "variant",
      discriminator,
      variants,
      options: variants.filter((variant) => offered.has(variant.value)),
    };
  }

  switch (schema.type) {
    case "string": {
      if (Array.isArray(schema.enum)) {
        const values = schema.enum.filter(
          (value): value is string => typeof value === "string",
        );
        return {
          ...base,
          kind: "choice",
          values,
          options: optionsFor(values, presentation, capabilities),
        };
      }
      return {
        ...base,
        kind: "text",
        minLength: num(schema.minLength) ?? 0,
        maxLength: num(schema.maxLength),
        required: false,
        placeholder: presentation.placeholder,
      };
    }
    case "number":
    case "integer":
      return {
        ...base,
        kind: "number",
        integer: schema.type === "integer",
        minimum: num(schema.minimum),
        exclusiveMinimum: num(schema.exclusiveMinimum),
        maximum: num(schema.maximum),
        exclusiveMaximum: num(schema.exclusiveMaximum),
        unit: presentation.unit,
      };
    case "array": {
      const items = isRecord(schema.items) ? schema.items : {};
      if (items.type !== "string") return null;
      return {
        ...base,
        kind: "list",
        minItems: num(schema.minItems) ?? 0,
        maxItems: num(schema.maxItems),
        itemMinLength: num(items.minLength) ?? 0,
      };
    }
    case "object": {
      if (isRecord(schema.properties))
        return {
          ...base,
          kind: "group",
          note: presentation.note?.(capabilities),
          fields: childFields(
            schema.properties,
            path,
            capabilities,
            presentations,
          ),
        };
      const values = schema.additionalProperties;
      if (isRecord(values) && values.type === "string") {
        const names = isRecord(schema.propertyNames)
          ? schema.propertyNames
          : {};
        return {
          ...base,
          kind: "map",
          keyMinLength: num(names.minLength) ?? 0,
        };
      }
      return null;
    }
    default:
      return null;
  }
}

function childFields(
  properties: Readonly<Record<string, unknown>>,
  parent: readonly string[],
  capabilities: DriverCapabilities,
  presentations: Readonly<Record<string, Presentation>>,
  skip: ReadonlySet<string> = new Set(),
): SpecField[] {
  const fields: SpecField[] = [];
  for (const [name, schema] of Object.entries(properties)) {
    if (skip.has(name) || !isRecord(schema)) continue;
    const path = [...parent, name];
    const field = mapField(
      path.join("."),
      path,
      schema,
      capabilities,
      presentations,
    );
    if (field) fields.push(field);
  }
  return fields;
}

/** The form fields for a driver's spec schema, in schema order. */
export function specFormFields(
  schema: Readonly<Record<string, unknown>>,
  capabilities: DriverCapabilities,
  presentations: Readonly<Record<string, Presentation>> = SPEC_PRESENTATION,
): SpecField[] {
  if (!isRecord(schema.properties)) return [];
  const required = Array.isArray(schema.required) ? schema.required : [];
  return childFields(schema.properties, [], capabilities, presentations).map(
    (field) =>
      field.kind === "text" && required.includes(field.key)
        ? { ...field, required: true }
        : field,
  );
}

// ── Draft ↔ value ──────────────────────────────────────────────────────────

/** The form's text state, keyed by field key. A variant's key holds its tag. */
export type SpecDraft = Readonly<Record<string, string>>;

/** Validation messages keyed by field key. */
export type FieldErrors = Readonly<Record<string, string>>;

const at = (source: unknown, path: readonly string[]): unknown =>
  path.reduce<unknown>(
    (value, key) => (isRecord(value) ? value[key] : undefined),
    source,
  );

const firstOption = (options: readonly ChoiceOption[]) =>
  options[0]?.value ?? "";

function draftEntries(
  fields: readonly SpecField[],
  source: unknown,
  out: Record<string, string>,
): void {
  for (const field of fields) {
    const value = at(source, field.path);
    switch (field.kind) {
      case "text":
        out[field.key] = typeof value === "string" ? value : "";
        break;
      case "number":
        out[field.key] = typeof value === "number" ? String(value) : "";
        break;
      case "choice":
        out[field.key] =
          typeof value === "string"
            ? value
            : typeof field.defaultValue === "string" &&
                field.options.some((o) => o.value === field.defaultValue)
              ? field.defaultValue
              : firstOption(field.options);
        break;
      case "variant": {
        const stored = isRecord(value) ? value[field.discriminator] : undefined;
        const fallback = isRecord(field.defaultValue)
          ? field.defaultValue[field.discriminator]
          : undefined;
        const tag =
          typeof stored === "string"
            ? stored
            : typeof fallback === "string" &&
                field.options.some((o) => o.value === fallback)
              ? fallback
              : firstOption(field.options);
        out[field.key] = tag;
        for (const variant of field.variants)
          draftEntries(variant.fields, source, out);
        break;
      }
      case "list":
        out[field.key] = Array.isArray(value)
          ? value.filter((item) => typeof item === "string").join("\n")
          : "";
        break;
      case "map":
        out[field.key] = isRecord(value)
          ? Object.entries(value)
              .map(([name, item]) => `${name}=${String(item)}`)
              .join("\n")
          : "";
        break;
      case "group":
        draftEntries(field.fields, source, out);
        break;
    }
  }
}

/**
 * The draft for a stored spec, or for a new one when `spec` is undefined:
 * schema defaults for choices and variants, everything else empty.
 */
export function draftFromSpec(
  fields: readonly SpecField[],
  spec?: unknown,
): SpecDraft {
  const out: Record<string, string> = {};
  draftEntries(fields, spec ?? {}, out);
  return out;
}

const describeBound = (field: NumberField): string | null => {
  const parts: string[] = [];
  if (field.exclusiveMinimum !== undefined)
    parts.push(`more than ${field.exclusiveMinimum}`);
  else if (field.minimum !== undefined) parts.push(`at least ${field.minimum}`);
  if (field.exclusiveMaximum !== undefined)
    parts.push(`less than ${field.exclusiveMaximum}`);
  else if (field.maximum !== undefined)
    parts.push(`at most ${field.maximum.toLocaleString("en-US")}`);
  return parts.length ? `Must be ${parts.join(" and ")}.` : null;
};

function readNumber(field: NumberField, text: string): number | string {
  const value = Number(text);
  if (!Number.isFinite(value)) return "Enter a number.";
  if (field.integer && !Number.isInteger(value)) return "Enter a whole number.";
  const outside =
    (field.exclusiveMinimum !== undefined && value <= field.exclusiveMinimum) ||
    (field.minimum !== undefined && value < field.minimum) ||
    (field.exclusiveMaximum !== undefined && value >= field.exclusiveMaximum) ||
    (field.maximum !== undefined && value > field.maximum);
  if (outside) return describeBound(field) ?? "Out of range.";
  return value;
}

const lines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

/** Reads one field into `target`, or records why it cannot. */
function readField(
  field: SpecField,
  draft: SpecDraft,
  target: Record<string, unknown>,
  errors: Record<string, string>,
): void {
  const name = field.path[field.path.length - 1] ?? field.key;
  const text = draft[field.key] ?? "";
  switch (field.kind) {
    case "text": {
      const value = text.trim();
      if (!value) {
        if (field.required) errors[field.key] = "Required.";
        return;
      }
      if (value.length < field.minLength)
        errors[field.key] = `At least ${field.minLength} characters.`;
      else if (field.maxLength !== undefined && value.length > field.maxLength)
        errors[field.key] = `At most ${field.maxLength} characters.`;
      else target[name] = value;
      return;
    }
    case "number": {
      if (!text.trim()) return;
      const value = readNumber(field, text.trim());
      if (typeof value === "string") errors[field.key] = value;
      else target[name] = value;
      return;
    }
    case "choice":
      if (field.values.includes(text)) target[name] = text;
      else errors[field.key] = "Choose an option.";
      return;
    case "variant": {
      const variant = field.variants.find((option) => option.value === text);
      if (!variant) {
        errors[field.key] = "Choose an option.";
        return;
      }
      const value: Record<string, unknown> = { [field.discriminator]: text };
      for (const child of variant.fields)
        readField(child, draft, value, errors);
      target[name] = value;
      return;
    }
    case "list": {
      const items = lines(text);
      if (items.length < field.minItems)
        errors[field.key] =
          field.minItems === 1
            ? "Add at least one."
            : `Add at least ${field.minItems}.`;
      else if (field.maxItems !== undefined && items.length > field.maxItems)
        errors[field.key] = `At most ${field.maxItems}.`;
      else if (items.some((item) => item.length < field.itemMinLength))
        errors[field.key] = "Every line needs a value.";
      else if (items.length > 0) target[name] = items;
      return;
    }
    case "map": {
      const value: Record<string, string> = {};
      for (const [index, raw] of text.split(/\r?\n/).entries()) {
        if (!raw.trim()) continue;
        const split = raw.indexOf("=");
        const key = (split === -1 ? raw : raw.slice(0, split)).trim();
        if (split === -1 || key.length < Math.max(1, field.keyMinLength)) {
          errors[field.key] = `Line ${index + 1}: write KEY=value.`;
          return;
        }
        if (key in value) {
          errors[field.key] = `Line ${index + 1}: ${key} is set twice.`;
          return;
        }
        value[key] = raw.slice(split + 1);
      }
      if (Object.keys(value).length > 0) target[name] = value;
      return;
    }
    case "group": {
      const value: Record<string, unknown> = {};
      for (const child of field.fields) readField(child, draft, value, errors);
      if (Object.keys(value).length > 0) target[name] = value;
      return;
    }
  }
}

/**
 * Reads the draft into spec values. Empty inputs are left out, so the
 * server's defaults apply; `errors` is empty when the draft is valid.
 */
export function readSpecDraft(
  fields: readonly SpecField[],
  draft: SpecDraft,
): { value: Record<string, unknown>; errors: FieldErrors } {
  const value: Record<string, unknown> = {};
  const errors: Record<string, string> = {};
  for (const field of fields) readField(field, draft, value, errors);
  return { value, errors };
}

/**
 * The draft after switching driver: values for fields the new driver also has
 * are kept (a stored network mode the new driver cannot enforce stays, so the
 * server can say so), driver-specific ones such as the image are cleared, and
 * fields new to this driver start from their defaults.
 */
export function carryDraft(
  draft: SpecDraft,
  fields: readonly SpecField[],
): SpecDraft {
  const fresh = draftFromSpec(fields);
  const next: Record<string, string> = { ...fresh };
  for (const key of Object.keys(fresh))
    if (key in draft && !DRIVER_SPECIFIC_KEYS.includes(key))
      next[key] = draft[key] ?? "";
  return next;
}
