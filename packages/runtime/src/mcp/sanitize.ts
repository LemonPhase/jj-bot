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

/**
 * Sets an own property, also one named `__proto__`, which a plain
 * assignment would turn into the object's prototype instead.
 */
const put = (target: Record<string, unknown>, key: string, item: unknown) =>
  Object.defineProperty(target, key, {
    value: item,
    enumerable: true,
    writable: true,
    configurable: true,
  });

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

/**
 * Server text shown as data in a warning: as it is when it is a plain
 * name, otherwise quoted as JSON (so a newline cannot start a line of its
 * own) with invisible characters written out, at most `max` characters.
 */
function shown(text: string, max: number): string {
  if (text.length <= max && /^[A-Za-z0-9_$.-]+$/.test(text)) return text;
  const cut = text.length > max ? `${text.slice(0, max)}…` : text;
  return visibleText(JSON.stringify(cut));
}

/** Most left-out keyword names one warning lists. */
const MAX_DROPPED_SHOWN = 12;

interface Walk {
  /** Keywords left out, for one warning per tool. */
  dropped: Set<string>;
  /** Other changes worth a warning. */
  notes: Set<string>;
  /** Characters kept so far, to stop early on a schema far over the cap. */
  size: number;
  /** Set for the walk over the schema with its references expanded. */
  expanded?: boolean;
}

const once = (walk: Pick<Walk, "expanded">) =>
  walk.expanded ? "once its references are expanded" : "once reduced";

const tooLarge = (walk: Pick<Walk, "expanded">) =>
  new Refused(
    `its input schema is larger than ${MCP_SCHEMA_BYTES_LIMIT} bytes ${once(walk)}`,
  );

function grow(walk: Walk, by: number) {
  walk.size += by;
  // A rough count of the reduced schema's JSON: twice the cap is surely over it.
  if (walk.size > MCP_SCHEMA_BYTES_LIMIT * 2) throw tooLarge(walk);
}

const deep = (walk: Pick<Walk, "expanded">) =>
  new Refused(
    `its input schema nests deeper than ${MCP_SCHEMA_DEPTH_LIMIT} levels${walk.expanded ? " once its references are expanded" : ""}`,
  );

/** A JSON value the model may read (`const`, `default`, `enum` items), with its strings made visible. */
function value(input: unknown, depth: number, walk: Walk): unknown {
  if (depth > MCP_SCHEMA_DEPTH_LIMIT) throw deep(walk);
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
      put(out, name, value(item, depth + 1, walk));
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
  if (depth > MCP_SCHEMA_DEPTH_LIMIT) throw deep(walk);
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
    put(out, key, kept);
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
          put(map, shown, schema(item, depth + 1, walk));
        }
        keep(key, map);
      } else walk.dropped.add(key);
    } else if (key === "$ref") {
      if (isLocalRef(raw)) {
        keep(key, raw);
        grow(walk, raw.length);
      } else walk.dropped.add("$ref (not local)");
    } else walk.dropped.add(shown(key, 40));
  }
  return out;
}

/** The node a local JSON pointer (`#`, `#/$defs/a`) names in `root`, or undefined. */
function pointed(root: unknown, ref: string): unknown {
  if (ref === "#") return root;
  let node: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    let part: string;
    try {
      part = decodeURIComponent(raw).replace(/~1/g, "/").replace(/~0/g, "~");
    } catch {
      return undefined;
    }
    if (Array.isArray(node) && /^(?:0|[1-9]\d*)$/.test(part))
      node = node[Number(part)];
    else if (
      typeof node === "object" &&
      node !== null &&
      !Array.isArray(node) &&
      Object.hasOwn(node, part)
    )
      node = (node as Record<string, unknown>)[part];
    else return undefined;
  }
  return node;
}

interface Expansion {
  root: Record<string, unknown>;
  /** References expanded so far, with what each added to the size. */
  done: Map<string, { schema: unknown; size: number }>;
  /** References being expanded: meeting one again is a loop. */
  open: Set<string>;
  /** Characters of the expanded schema so far. */
  size: number;
  dangling: boolean;
  /** A reference led back into one being expanded; it became `{}`. */
  looped: boolean;
}

const expandedWalk = { expanded: true };

function spend(state: Expansion, by: number) {
  state.size += by;
  if (state.size > MCP_SCHEMA_BYTES_LIMIT * 2) throw tooLarge(expandedWalk);
}

/** What a reference stands for, expanded; each one is expanded once and reused, its size counted at every use. */
function expandRef(ref: string, state: Expansion): unknown {
  const done = state.done.get(ref);
  if (done) {
    spend(state, done.size);
    return done.schema;
  }
  // A loop cannot be written out: where it closes, any value is accepted.
  if (state.open.has(ref)) {
    state.looped = true;
    spend(state, 2);
    return {};
  }
  const target = pointed(state.root, ref);
  if (target === undefined) {
    state.dangling = true;
    spend(state, 5);
    return false;
  }
  state.open.add(ref);
  const before = state.size;
  const expanded = expand(target, state);
  state.open.delete(ref);
  state.done.set(ref, { schema: expanded, size: state.size - before });
  return expanded;
}

/**
 * A reduced schema with every local reference replaced by what it names,
 * and `$defs` and `definitions` dropped, so the declared schema holds no
 * reference for a validator to follow. A reference beside other keywords
 * joins them under `allOf`. Where a reference leads back into one being
 * expanded (a recursive schema), it becomes `{}`, any value. It stops as
 * soon as the result passes twice the size cap, so a small schema whose
 * references multiply (each definition naming the next twice) costs little
 * to refuse.
 */
function expand(node: unknown, state: Expansion): unknown {
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    spend(state, 5);
    return node;
  }
  spend(state, 2);
  const out: Record<string, unknown> = {};
  const set = (key: string, item: unknown) => {
    spend(state, key.length + 3);
    put(out, key, item);
  };
  for (const [key, raw] of Object.entries(node)) {
    if (key === "$ref" || key === "$defs" || key === "definitions") continue;
    if (key === "items" && Array.isArray(raw))
      set(
        key,
        raw.map((item) => expand(item, state)),
      );
    else if (key === "items" || SCHEMA_VALUED.has(key))
      set(key, expand(raw, state));
    else if (SCHEMA_LISTS.has(key) && Array.isArray(raw))
      set(
        key,
        raw.map((item) => expand(item, state)),
      );
    else if (key === "properties" && typeof raw === "object" && raw !== null) {
      const map: Record<string, unknown> = {};
      for (const [name, item] of Object.entries(raw)) {
        spend(state, name.length + 3);
        put(map, name, expand(item, state));
      }
      set(key, map);
    } else {
      // Values (types, bounds, enum, const, default, text), already reduced.
      spend(state, JSON.stringify(raw)?.length ?? 4);
      set(key, raw);
    }
  }
  const ref = (node as Record<string, unknown>).$ref;
  if (typeof ref !== "string") return out;
  const target = expandRef(ref, state);
  if (Object.keys(out).length === 0) return target;
  const all = Array.isArray(out.allOf) ? out.allOf : [];
  put(out, "allOf", [...all, target]);
  return out;
}

/**
 * The reduced input schema of a tool and warnings about what changed.
 * Throws, with the reason as its message, when the tool is to be left out.
 */
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
  const written = canonicalJson(reduced);
  if (
    written === undefined ||
    Buffer.byteLength(written) > MCP_SCHEMA_BYTES_LIMIT
  )
    throw tooLarge(walk);
  // References expanded, then held to the same caps as written out in full.
  const state: Expansion = {
    root: reduced,
    done: new Map(),
    open: new Set(["#"]),
    size: 0,
    dangling: false,
    looped: false,
  };
  const expanded = expand(reduced, state);
  const checked = schema(expanded, 1, {
    dropped: new Set(),
    notes: new Set(),
    size: 0,
    expanded: true,
  }) as Record<string, unknown>;
  const json = canonicalJson(checked);
  if (json === undefined || Buffer.byteLength(json) > MCP_SCHEMA_BYTES_LIMIT)
    throw tooLarge(expandedWalk);
  if (state.looped)
    walk.notes.add(
      "accepts any value where its schema refers to itself, since a schema that loops cannot be declared",
    );
  if (state.dangling)
    walk.notes.add(
      "a reference names nothing in the schema; no value is accepted there",
    );
  const warnings: string[] = [];
  if (walk.dropped.size > 0) {
    const names = [...walk.dropped].sort();
    const more = names.length - MAX_DROPPED_SHOWN;
    warnings.push(
      `left out schema keywords ${names.slice(0, MAX_DROPPED_SHOWN).join(", ")}${more > 0 ? ` and ${more} more` : ""}`,
    );
  }
  warnings.push(...[...walk.notes].sort());
  return { schema: checked, warnings };
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
 * by name, and warnings about what was changed or left out. Names are
 * checked and chosen first, so only the tools kept are ever sanitized: a
 * name must have 1 to 128 characters and a tool listed twice keeps its
 * first entry, and the first MAX_MCP_SNAPSHOT_TOOLS by name are chosen. A
 * chosen tool is left out (with a warning) when its input schema is not an
 * object schema, or is larger than MCP_SCHEMA_BYTES_LIMIT or deeper than
 * MCP_SCHEMA_DEPTH_LIMIT once reduced and its references expanded (a
 * reference into itself accepts any value, with a warning). Annotations are
 * kept as the server's unverified hints.
 */
export function sanitizeTools(
  server: string,
  listed: readonly Tool[],
): { tools: McpTool[]; warnings: string[] } {
  const warnings: string[] = [];
  const label = (name: string) => shown(name, 80) || "(unnamed)";
  const named = new Map<string, Tool>();
  for (const tool of listed) {
    const name = typeof tool?.name === "string" ? tool.name : "";
    if (name.length === 0 || name.length > NAME_LIMIT)
      warnings.push(
        `${label(name)}: left out, since a tool name has 1 to ${NAME_LIMIT} characters.`,
      );
    else if (named.has(name))
      warnings.push(
        `${label(name)}: listed more than once; the first is kept.`,
      );
    else named.set(name, tool);
  }
  const names = [...named.keys()].sort();
  if (names.length > MAX_MCP_SNAPSHOT_TOOLS)
    warnings.push(
      `The server lists ${names.length} tools; the first ${MAX_MCP_SNAPSHOT_TOOLS} by name are kept.`,
    );
  const kept = new Map<string, Omit<McpTool, "exposedName">>();
  for (const name of names.slice(0, MAX_MCP_SNAPSHOT_TOOLS)) {
    const tool = named.get(name) as Tool;
    let reduced: ReturnType<typeof sanitizeInputSchema>;
    try {
      reduced = sanitizeInputSchema(tool.inputSchema);
    } catch (error) {
      if (!(error instanceof Refused)) throw error;
      warnings.push(`${label(name)}: left out, since ${error.message}.`);
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
    if (notes.length > 0) warnings.push(`${label(name)}: ${notes.join("; ")}.`);
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
  // Kept in name order; exposed names among the tools kept.
  const chosen = [...kept.keys()];
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
