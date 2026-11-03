import type { Tool } from "@earendil-works/pi-mcp";
import {
  canonicalJson,
  MAX_MCP_SNAPSHOT_TOOLS,
  MCP_SCHEMA_BYTES_LIMIT,
  MCP_SCHEMA_DEPTH_LIMIT,
  MCP_TOOL_DESCRIPTION_LIMIT,
  type McpTool,
  mcpToolNames,
  sha256Hex,
  visibleText,
} from "@jj/contracts";

/**
 * Turns the tools a server lists into what a snapshot keeps (`McpTool`):
 * text the model reads is clipped and has its invisible characters written
 * out, input schemas are reduced to a small allowlist of JSON Schema
 * keywords, and every tool is named with the contract's `mcpToolNames`.
 * Pure and linear in the size of what the server sent, so a hostile listing
 * costs little; nothing here compiles a schema or a regular expression.
 */

/** Most warnings a snapshot keeps, and the longest one (the contract's caps). */
const MAX_WARNINGS = 50;
const WARNING_LIMIT = 500;
/** Longest title a snapshot keeps. */
const TITLE_LIMIT = 200;
/** Longest tool name a snapshot keeps; `tools/call` uses it as given. */
const NAME_LIMIT = 128;

const JSON_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
]);

/** Keywords whose value is kept as it is once its shape is checked. */
const NON_NEGATIVE_INTEGERS = new Set([
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "minProperties",
  "maxProperties",
]);
const NUMBERS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
]);
/** Keywords whose value is one schema (or `true`/`false`). */
const SCHEMA_VALUED = new Set(["additionalProperties", "not"]);
/** Keywords whose value is a list of schemas. */
const SCHEMA_LISTS = new Set(["anyOf", "oneOf", "allOf", "prefixItems"]);
/** Keywords whose value maps names to schemas. */
const SCHEMA_MAPS = new Set(["properties", "$defs", "definitions"]);
/** Keywords whose value is any JSON value the model may read. */
const VALUES = new Set(["const", "default"]);
/** Text the model reads. */
const TEXTS = new Set(["title", "description"]);

class Refused extends Error {}

/** `text` cut to `max` UTF-16 code units, ending in `…`; a surrogate pair or a written-out character is never split. */
function clip(text: string, max: number): { text: string; clipped: boolean } {
  if (text.length <= max) return { text, clipped: false };
  let cut = text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, "");
  const open = cut.lastIndexOf("⟨");
  if (open !== -1 && !cut.includes("⟩", open)) cut = cut.slice(0, open);
  return { text: `${cut}…`, clipped: true };
}

/** What the model reads: invisible characters written out, then clipped. */
function readable(text: string, max: number) {
  return clip(visibleText(text), max);
}

interface Walk {
  /** Keywords left out, for one warning per tool. */
  dropped: Set<string>;
  /** Other changes worth a warning. */
  notes: Set<string>;
  /** Characters kept so far, to stop early on a schema far over the cap. */
  size: number;
}

const tooLarge = () =>
  new Refused(
    `its input schema is larger than ${MCP_SCHEMA_BYTES_LIMIT} bytes once reduced`,
  );

function grow(walk: Walk, by: number) {
  walk.size += by;
  // A rough count of the reduced schema's JSON: twice the cap is surely over it.
  if (walk.size > MCP_SCHEMA_BYTES_LIMIT * 2) throw tooLarge();
}

const deep = () =>
  new Refused(
    `its input schema nests deeper than ${MCP_SCHEMA_DEPTH_LIMIT} levels`,
  );

/** A JSON value the model may read (`const`, `default`, `enum` items), with its strings made visible. */
function value(input: unknown, depth: number, walk: Walk): unknown {
  if (depth > MCP_SCHEMA_DEPTH_LIMIT) throw deep();
  if (typeof input === "string") {
    const shown = visibleText(input);
    if (shown !== input) walk.notes.add("wrote out invisible characters");
    grow(walk, shown.length + 2);
    return shown;
  }
  if (typeof input === "number") {
    grow(walk, 8);
    return Number.isFinite(input) ? input : null;
  }
  if (typeof input === "boolean" || input === null) {
    grow(walk, 5);
    return input;
  }
  if (Array.isArray(input)) {
    grow(walk, 2);
    return input.map((item) => value(item, depth + 1, walk));
  }
  if (typeof input === "object") {
    grow(walk, 2);
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(input)) {
      const name = visibleText(key);
      if (name !== key) walk.notes.add("wrote out invisible characters");
      grow(walk, name.length + 3);
      out[name] = value(item, depth + 1, walk);
    }
    return out;
  }
  return null;
}

/** A local reference into the document (`#`, `#/$defs/x`); anything else may name a remote one. */
const isLocalRef = (ref: unknown): ref is string =>
  typeof ref === "string" && (ref === "#" || ref.startsWith("#/"));

/** One schema (an object, or `true`/`false`), reduced to the allowlist. */
function schema(input: unknown, depth: number, walk: Walk): unknown {
  if (depth > MCP_SCHEMA_DEPTH_LIMIT) throw deep();
  if (typeof input === "boolean") {
    grow(walk, 5);
    return input;
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    walk.notes.add("replaced a malformed subschema with {}");
    grow(walk, 2);
    return {};
  }
  grow(walk, 2);
  const out: Record<string, unknown> = {};
  const keep = (key: string, kept: unknown) => {
    grow(walk, key.length + 3);
    out[key] = kept;
  };
  for (const [key, raw] of Object.entries(input)) {
    if (key === "type") {
      const types = (Array.isArray(raw) ? raw : [raw]).filter(
        (type): type is string =>
          typeof type === "string" && JSON_TYPES.has(type),
      );
      if (types.length === 0) walk.dropped.add("type");
      else keep(key, Array.isArray(raw) ? [...new Set(types)] : types[0]);
    } else if (TEXTS.has(key)) {
      if (typeof raw !== "string") walk.dropped.add(key);
      else {
        const shown = readable(raw, MCP_TOOL_DESCRIPTION_LIMIT);
        if (shown.text !== raw)
          walk.notes.add(
            shown.clipped
              ? "clipped a schema description"
              : "wrote out invisible characters",
          );
        keep(key, shown.text);
        grow(walk, shown.text.length);
      }
    } else if (NON_NEGATIVE_INTEGERS.has(key)) {
      if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0)
        keep(key, raw);
      else walk.dropped.add(key);
    } else if (NUMBERS.has(key)) {
      if (typeof raw === "number" && Number.isFinite(raw)) keep(key, raw);
      else walk.dropped.add(key);
    } else if (key === "uniqueItems") {
      if (typeof raw === "boolean") keep(key, raw);
      else walk.dropped.add(key);
    } else if (key === "required") {
      if (Array.isArray(raw) && raw.every((item) => typeof item === "string"))
        keep(key, [...new Set(raw.map((item) => visibleText(item as string)))]);
      else walk.dropped.add(key);
    } else if (key === "enum") {
      if (Array.isArray(raw))
        keep(
          key,
          raw.map((item) => value(item, depth + 1, walk)),
        );
      else walk.dropped.add(key);
    } else if (VALUES.has(key)) {
      keep(key, value(raw, depth + 1, walk));
    } else if (key === "items") {
      // A list is the older tuple form, kept as it is.
      keep(
        key,
        Array.isArray(raw)
          ? raw.map((item) => schema(item, depth + 1, walk))
          : schema(raw, depth + 1, walk),
      );
    } else if (SCHEMA_VALUED.has(key)) {
      keep(key, schema(raw, depth + 1, walk));
    } else if (SCHEMA_LISTS.has(key)) {
      if (Array.isArray(raw))
        keep(
          key,
          raw.map((item) => schema(item, depth + 1, walk)),
        );
      else walk.dropped.add(key);
    } else if (SCHEMA_MAPS.has(key)) {
      if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
        const map: Record<string, unknown> = {};
        for (const [name, item] of Object.entries(raw)) {
          const shown = visibleText(name);
          if (shown !== name) walk.notes.add("wrote out invisible characters");
          grow(walk, shown.length + 3);
          map[shown] = schema(item, depth + 1, walk);
        }
        keep(key, map);
      } else walk.dropped.add(key);
    } else if (key === "$ref") {
      if (isLocalRef(raw)) {
        keep(key, raw);
        grow(walk, raw.length);
      } else walk.dropped.add("$ref (not local)");
    } else walk.dropped.add(key);
  }
  return out;
}

/** The reduced input schema of a tool, or why the tool is left out. */
export function sanitizeInputSchema(input: Record<string, unknown>): {
  schema: Record<string, unknown>;
  warnings: string[];
} {
  const walk: Walk = { dropped: new Set(), notes: new Set(), size: 0 };
  const root = input.type;
  if (root !== undefined && root !== "object")
    throw new Refused("its input schema is not an object schema");
  const reduced = schema(input, 1, walk) as Record<string, unknown>;
  if (reduced.type === undefined) {
    reduced.type = "object";
    walk.notes.add('set the missing root type to "object"');
  }
  const json = canonicalJson(reduced);
  if (json === undefined || Buffer.byteLength(json) > MCP_SCHEMA_BYTES_LIMIT)
    throw tooLarge();
  const warnings: string[] = [];
  if (walk.dropped.size > 0)
    warnings.push(
      `left out schema keywords ${[...walk.dropped].sort().join(", ")}`,
    );
  warnings.push(...[...walk.notes].sort());
  return { schema: reduced, warnings };
}

/** The tool's description as the model reads it: invisible characters written out, at most 2000 characters. */
export function sanitizeDescription(text: unknown): {
  text: string;
  clipped: boolean;
  invisible: boolean;
} {
  const raw = typeof text === "string" ? text : "";
  const shown = visibleText(raw);
  const clipped = clip(shown, MCP_TOOL_DESCRIPTION_LIMIT);
  return { ...clipped, invisible: shown !== raw };
}

/** The four hints of the contract, when the server sent them as booleans. Unverified. */
function hints(tool: Tool): McpTool["annotations"] {
  const source = tool.annotations;
  if (typeof source !== "object" || source === null) return undefined;
  const kept: NonNullable<McpTool["annotations"]> = {};
  for (const key of [
    "readOnlyHint",
    "destructiveHint",
    "idempotentHint",
    "openWorldHint",
  ] as const)
    if (typeof source[key] === "boolean") kept[key] = source[key];
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/** SHA-256 of the canonical JSON of `{ name, description, inputSchema }`, as the contract defines a tool's hash. */
export function mcpToolHash(
  tool: Pick<McpTool, "name" | "description" | "inputSchema">,
): string {
  return sha256Hex(
    canonicalJson({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }) ?? "",
  );
}

const warning = (text: string) => clip(text, WARNING_LIMIT).text;

/**
 * The tools a snapshot of `server` keeps from what the server listed, sorted
 * by name, and warnings about what was changed or left out. A tool is left
 * out (with a warning) when its name is empty, longer than 128 characters
 * or listed twice, or its input schema is not an object schema, is larger
 * than MCP_SCHEMA_BYTES_LIMIT once reduced, or nests deeper than
 * MCP_SCHEMA_DEPTH_LIMIT. At most MAX_MCP_SNAPSHOT_TOOLS are kept, the first
 * by name. Annotations are kept as the server's unverified hints.
 */
export function sanitizeTools(
  server: string,
  listed: readonly Tool[],
): { tools: McpTool[]; warnings: string[] } {
  const warnings: string[] = [];
  const kept = new Map<string, Omit<McpTool, "exposedName">>();
  for (const tool of listed) {
    const name = typeof tool.name === "string" ? tool.name : "";
    const label = visibleText(name.slice(0, 80)) || "(unnamed)";
    if (name.length === 0 || name.length > NAME_LIMIT) {
      warnings.push(
        `${label}: left out, since a tool name has 1 to ${NAME_LIMIT} characters.`,
      );
      continue;
    }
    if (kept.has(name)) {
      warnings.push(`${label}: listed more than once; the first is kept.`);
      continue;
    }
    let reduced: ReturnType<typeof sanitizeInputSchema>;
    try {
      reduced = sanitizeInputSchema(tool.inputSchema);
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      warnings.push(`${label}: left out, since ${error.message}.`);
      continue;
    }
    const description = sanitizeDescription(tool.description);
    const notes = [...reduced.warnings];
    if (description.invisible)
      notes.push("wrote out invisible characters in its description");
    if (description.clipped)
      notes.push(
        `clipped its description to ${MCP_TOOL_DESCRIPTION_LIMIT} characters`,
      );
    if (notes.length > 0) warnings.push(`${label}: ${notes.join("; ")}.`);
    const rawTitle = tool.title ?? tool.annotations?.title;
    const title =
      typeof rawTitle === "string" && rawTitle.trim() !== ""
        ? readable(rawTitle, TITLE_LIMIT).text
        : undefined;
    const annotations = hints(tool);
    const entry = {
      name,
      ...(title ? { title } : {}),
      description: description.text,
      inputSchema: reduced.schema,
      ...(annotations ? { annotations } : {}),
    };
    kept.set(name, { ...entry, hash: mcpToolHash(entry) });
  }
  const names = [...kept.keys()].sort();
  if (names.length > MAX_MCP_SNAPSHOT_TOOLS)
    warnings.push(
      `The server lists ${names.length} tools; the first ${MAX_MCP_SNAPSHOT_TOOLS} by name are kept.`,
    );
  const chosen = names.slice(0, MAX_MCP_SNAPSHOT_TOOLS);
  const exposed = mcpToolNames(server, chosen);
  const tools = chosen.map((name) => ({
    ...(kept.get(name) as Omit<McpTool, "exposedName">),
    exposedName: exposed.get(name) as string,
  }));
  const capped =
    warnings.length > MAX_WARNINGS
      ? [
          ...warnings.slice(0, MAX_WARNINGS - 1),
          `${warnings.length - MAX_WARNINGS + 1} more warnings are not shown.`,
        ]
      : warnings;
  return { tools, warnings: capped.map(warning) };
}
