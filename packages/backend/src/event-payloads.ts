// Event payload limits. `emit` measures each payload's JSON. Records (task,
// session, message, artifact, approval and check snapshots, and the plans
// they hold) are bounded by their contract schemas, so they are always stored
// whole, over the cap too. What no record bounds (a tool's output preview,
// the error and stop texts, a held call's arguments) is clipped in a payload
// over the cap, and the full payload is saved as an `output` artifact. A
// clipped payload must still parse with its type's contract schema; one that
// would not is stored whole instead. The engine reads back only short fields
// of events (types, ids, tool names and summaries, outcomes, numbers), which
// clipping never touches.
import {
  type TaskEventType,
  TOOL_OUTPUT_PREVIEW_LIMIT,
  taskEventSchema,
} from "@jj/contracts";

/** Strings longer than this many UTF-8 bytes are clipped in a spilled payload. */
export const PAYLOAD_STRING_CLIP_BYTES = 4 * 1024;

/** What a held call's arguments may keep once clipping their strings was not enough. */
const FREE_FORM_BUDGET_BYTES = 16 * 1024;

/**
 * Where a payload carries what no record bounds, and may be clipped: `text`,
 * a string kept within `max` UTF-16 code units (its schema's measure) when
 * the schema has one; `json`, free-form JSON whose strings are clipped and
 * which keeps only its first entries when that is not enough. `*` is any
 * array index. Every other part of every payload is stored as it is.
 */
export const CLIPPABLE: Readonly<
  Partial<
    Record<
      TaskEventType,
      readonly (
        | { path: readonly string[]; kind: "text"; max?: number }
        | { path: readonly string[]; kind: "json" }
      )[]
    >
  >
> = {
  "tool.finished": [
    { path: ["output"], kind: "text", max: TOOL_OUTPUT_PREVIEW_LIMIT },
  ],
  "run.finished": [{ path: ["error"], kind: "text" }],
  "task.finished": [
    { path: ["result"], kind: "text" },
    { path: ["error"], kind: "text" },
  ],
  "cancellation.requested": [{ path: ["reason"], kind: "text" }],
  "cancellation.completed": [
    { path: ["stopped", "*", "command"], kind: "text" },
  ],
  "approval.requested": [{ path: ["approval", "args"], kind: "json" }],
  "approval.updated": [{ path: ["approval", "args"], kind: "json" }],
};

const PAYLOAD_SCHEMAS = new Map(
  taskEventSchema.options.map((option) => [
    option.shape.type.value as TaskEventType,
    option.shape.payload,
  ]),
);

/** Whether `payload` parses with the contract's schema for events of `type`. */
export function validPayload(type: TaskEventType, payload: unknown): boolean {
  return PAYLOAD_SCHEMAS.get(type)?.safeParse(payload).success === true;
}

/** The size of a payload as stored and streamed: the UTF-8 bytes of its JSON. */
export const payloadBytes = (payload: unknown): number =>
  Buffer.byteLength(JSON.stringify(payload) ?? "", "utf8");

/** The marker a clipped string ends with. */
export const clippedMarker = (left: number) =>
  `… [${left} more characters in the saved copy]`;

/** At most `units` UTF-16 code units of `text`, cut between code points. */
function headUnits(text: string, units: number): string {
  let end = Math.max(0, Math.min(units, text.length));
  // Never split a surrogate pair.
  const last = text.charCodeAt(end - 1);
  if (end > 0 && end < text.length && last >= 0xd800 && last <= 0xdbff)
    end -= 1;
  return text.slice(0, end);
}

/** At most `bytes` UTF-8 bytes of `text`, cut between code points. */
function headBytes(text: string, bytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= bytes) return text;
  let end = Math.max(0, bytes);
  // Back up over continuation bytes (10xxxxxx) to a character start.
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

/**
 * `text` with its start kept and a marker after it, at most `bytes` UTF-8
 * bytes of the start and, with `max`, at most `max` code units in all.
 */
function clipString(text: string, bytes: number, max?: number): string {
  if (
    Buffer.byteLength(text, "utf8") <= bytes &&
    (max === undefined || text.length <= max)
  )
    return text;
  let kept = headBytes(text, bytes);
  let marker = clippedMarker(text.length - kept.length);
  if (max !== undefined && kept.length + marker.length > max) {
    kept = headUnits(kept, max - marker.length);
    marker = clippedMarker(text.length - kept.length);
  }
  return `${kept}${marker}`;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The walks over free-form JSON below are loops, not recursion: a held
// call's arguments may nest deeper than the call stack goes.
type Container = unknown[] | Record<string, unknown>;
type Entry = [key: string | number, value: unknown];

const isContainer = (value: unknown): value is Container =>
  Array.isArray(value) || isObject(value);

const emptyLike = (value: Container): Container =>
  Array.isArray(value) ? [] : {};

const entriesOf = (value: Container): Entry[] =>
  Array.isArray(value)
    ? value.map((item, index): Entry => [index, item])
    : Object.entries(value);

/**
 * Adds an entry to a copy, in order: an own key always, `__proto__` too,
 * as `JSON.parse` reads it (an assignment would set the copy's prototype).
 */
function put(target: Container, key: string | number, value: unknown) {
  if (Array.isArray(target)) target.push(value);
  else
    Object.defineProperty(target, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
}

/** A copy with every string (not key) over `bytes` clipped and marked. */
function clipStrings(value: unknown, bytes: number): unknown {
  const copy = (item: unknown) =>
    typeof item === "string"
      ? clipString(item, bytes)
      : isContainer(item)
        ? emptyLike(item)
        : item;
  const root = copy(value);
  const pending: [Container, Container][] = isContainer(value)
    ? [[value, root as Container]]
    : [];
  for (let next = pending.pop(); next; next = pending.pop()) {
    const [source, target] = next;
    for (const [key, item] of entriesOf(source)) {
      const kept = copy(item);
      put(target, key, kept);
      if (isContainer(item)) pending.push([item, kept as Container]);
    }
  }
  return root;
}

/** A container `shrink` is filling: what it keeps of `entries`, within `budget`. */
interface Shrinking {
  entries: Entry[];
  next: number;
  kept: Container;
  used: number;
  budget: number;
  /** What the entry being filled adds beside its value: a comma, or its key. */
  overhead: number;
}

/**
 * Free-form JSON within about `budget` bytes: arrays and objects keep their
 * first entries, strings their start, and an object stays an object. Each
 * entry gets what its earlier siblings left, depth first.
 */
function shrink(value: unknown, budget: number): unknown {
  const leaf = (item: unknown, room: number) => {
    const kept =
      typeof item === "string"
        ? clipString(item, Math.max(0, room - 64))
        : item;
    return { kept, used: payloadBytes(kept ?? null) };
  };
  const open = (item: Container, room: number): Shrinking => ({
    entries: entriesOf(item),
    next: 0,
    kept: emptyLike(item),
    used: 2,
    budget: room,
    overhead: 0,
  });
  if (!isContainer(value)) return leaf(value, budget).kept;
  const root = open(value, budget);
  const stack = [root];
  for (let frame = stack.at(-1); frame; frame = stack.at(-1)) {
    const entry = frame.entries[frame.next];
    const inArray = Array.isArray(frame.kept);
    const overhead =
      entry === undefined ? 0 : inArray ? 1 : payloadBytes(entry[0]) + 2;
    const full = inArray
      ? frame.used >= frame.budget
      : frame.used + overhead >= frame.budget;
    if (entry === undefined || full) {
      // Done: its parent takes what it kept.
      stack.pop();
      const parent = stack.at(-1);
      const slot = parent?.entries[parent.next];
      if (parent && slot) {
        put(parent.kept, slot[0], frame.kept);
        parent.used += parent.overhead + frame.used;
        parent.next += 1;
      }
      continue;
    }
    const [key, item] = entry;
    const room = frame.budget - frame.used - overhead;
    if (isContainer(item)) {
      frame.overhead = overhead;
      stack.push(open(item, room));
      continue;
    }
    const small = leaf(item, room);
    put(frame.kept, key, small.kept);
    frame.used += overhead + small.used;
    frame.next += 1;
  }
  return root.kept;
}

/** Applies `fn` to every value at `path` inside `value`, returning a copy. */
function atPath(
  value: unknown,
  path: readonly string[],
  fn: (found: unknown) => unknown,
): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return fn(value);
  if (head === "*")
    return Array.isArray(value)
      ? value.map((item) => atPath(item, rest, fn))
      : value;
  if (!isObject(value) || !(head in value)) return value;
  return { ...value, [head]: atPath(value[head], rest, fn) };
}

/**
 * The clipped copy an over-cap payload of `type` is stored as, or undefined
 * when it is stored whole: its type has nothing to clip (a record snapshot,
 * whose schema bounds it), clipping changes nothing, or the clipped copy
 * would not parse with the type's schema.
 */
export function clippedPayload<Payload extends Record<string, unknown>>(
  type: TaskEventType,
  payload: Payload,
  capBytes: number,
): Payload | undefined {
  const zones = CLIPPABLE[type];
  if (!zones) return undefined;
  let clipped: unknown = payload;
  for (const zone of zones)
    clipped = atPath(clipped, zone.path, (found) =>
      zone.kind === "text"
        ? typeof found === "string"
          ? clipString(found, PAYLOAD_STRING_CLIP_BYTES, zone.max)
          : found
        : clipStrings(found, PAYLOAD_STRING_CLIP_BYTES),
    );
  if (payloadBytes(clipped) > capBytes)
    for (const zone of zones)
      if (zone.kind === "json")
        clipped = atPath(clipped, zone.path, (found) =>
          isObject(found) ? shrink(found, FREE_FORM_BUDGET_BYTES) : found,
        );
  if (payloadBytes(clipped) >= payloadBytes(payload)) return undefined;
  return validPayload(type, clipped) ? (clipped as Payload) : undefined;
}
