// Event payload limits. `emit` measures each payload's JSON; one over the
// engine's cap is stored in full as an `output` artifact, and the event keeps
// a clipped copy of the same shape: every string over 4 KiB keeps its start
// and a marker. The engine reads back only short fields of events (types,
// ids, tool names and summaries, outcomes, numbers), which clipping never
// touches.

/** Strings longer than this many UTF-8 bytes are clipped in a spilled payload. */
export const PAYLOAD_STRING_CLIP_BYTES = 4 * 1024;

/**
 * Free-form JSON inside payloads, which no schema bounds: a held call's
 * arguments and the JSON Schemas of verification criteria. When clipping
 * strings is not enough, these keep only their first entries (`*` is any
 * array index or key).
 */
const FREE_FORM_PATHS: readonly (readonly string[])[] = [
  ["approval", "args"],
  ["task", "verificationPlan", "*", "schema"],
  ["verificationPlan", "*", "schema"],
];

/** What a free-form value may keep once strings alone did not bring it under the cap. */
const FREE_FORM_BUDGET_BYTES = 4 * 1024;

/** The size of a payload as stored and streamed: the UTF-8 bytes of its JSON. */
export const payloadBytes = (payload: unknown): number =>
  Buffer.byteLength(JSON.stringify(payload) ?? "", "utf8");

/** The marker a clipped string ends with. */
export const clippedMarker = (left: number) =>
  `… [${left} more characters in the saved copy]`;

/** At most `bytes` UTF-8 bytes of `text`, cut between code points. */
function headBytes(text: string, bytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.byteLength <= bytes) return text;
  let end = Math.max(0, bytes);
  // Back up over continuation bytes (10xxxxxx) to a character start.
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

function clipString(text: string, bytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= bytes) return text;
  const kept = headBytes(text, bytes);
  return `${kept}${clippedMarker(text.length - kept.length)}`;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A copy with every string (not key) over `bytes` clipped and marked. */
function clipStrings(value: unknown, bytes: number): unknown {
  if (typeof value === "string") return clipString(value, bytes);
  if (Array.isArray(value))
    return value.map((item) => clipStrings(item, bytes));
  if (isObject(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        clipStrings(entry, bytes),
      ]),
    );
  return value;
}

/**
 * A JSON value within about `budget` bytes: arrays and objects keep their
 * first entries, strings their start. Only for free-form values, whose shape
 * no schema fixes.
 */
function shrink(
  value: unknown,
  budget: number,
): { value: unknown; used: number } {
  if (typeof value === "string") {
    const text = clipString(value, Math.max(0, budget - 64));
    return { value: text, used: payloadBytes(text) };
  }
  if (Array.isArray(value)) {
    const kept: unknown[] = [];
    let used = 2;
    for (const item of value) {
      if (used >= budget) break;
      const next = shrink(item, budget - used - 1);
      kept.push(next.value);
      used += next.used + 1;
    }
    return { value: kept, used };
  }
  if (isObject(value)) {
    const kept: Record<string, unknown> = {};
    let used = 2;
    for (const [key, entry] of Object.entries(value)) {
      const keyBytes = payloadBytes(key) + 2;
      if (used + keyBytes >= budget) break;
      const next = shrink(entry, budget - used - keyBytes);
      kept[key] = next.value;
      used += keyBytes + next.used;
    }
    return { value: kept, used };
  }
  return { value, used: payloadBytes(value ?? null) };
}

/** Applies `fn` to every value at `path` inside `value`, returning a copy. */
function atPath(
  value: unknown,
  path: readonly string[],
  fn: (found: unknown) => unknown,
): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return fn(value);
  if (Array.isArray(value) && head === "*")
    return value.map((item) => atPath(item, rest, fn));
  if (!isObject(value)) return value;
  if (head === "*")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        atPath(entry, rest, fn),
      ]),
    );
  if (!(head in value)) return value;
  return { ...value, [head]: atPath(value[head], rest, fn) };
}

/**
 * The clipped copy an over-cap payload is stored as: the same shape, every
 * string over 4 KiB clipped and marked. When that is still over `capBytes`
 * (a held call's arguments that are mostly not strings, very large check
 * schemas), free-form values keep only their first 4 KiB of entries too.
 */
export function clipPayload<Payload extends Record<string, unknown>>(
  payload: Payload,
  capBytes: number,
): Payload {
  const clipped = clipStrings(payload, PAYLOAD_STRING_CLIP_BYTES) as Payload;
  if (payloadBytes(clipped) <= capBytes) return clipped;
  let shrunk: unknown = clipped;
  for (const path of FREE_FORM_PATHS)
    shrunk = atPath(
      shrunk,
      path,
      (found) => shrink(found, FREE_FORM_BUDGET_BYTES).value,
    );
  return shrunk as Payload;
}
