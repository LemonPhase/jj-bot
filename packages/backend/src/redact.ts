// Redaction of the server's secret values (provider keys, the API token, the
// database password) from what the engine persists out of a run: events,
// transcript entries, spilled output, outcomes and the texts collaboration
// tools store. On an unisolated driver a command can print them
// (`cat .env`); they must not reach the task history. The runtime applies
// the same function before it caps or clips text it holds whole, so no
// fragment survives those cuts. Output an output limit cut while it was
// still arriving is redacted with its cut edges named, where what the cut
// left of a secret is masked too. Files in the workspace are the user's and
// are stored as they are.

export const REDACTED = "[redacted]";

/**
 * Shorter values are not redacted where they appear on their own: a short
 * value is too likely to be an ordinary word ("postgres"), and replacing it
 * would rewrite briefs, messages and the model's own history.
 */
export const MIN_BARE_SECRET_LENGTH = 16;

/**
 * At a cut edge, what is left of a secret is masked when at least this long.
 * A shorter piece is too likely to be ordinary text, and shows at most three
 * characters of a value at least 16 long.
 */
export const MIN_CUT_FRAGMENT_LENGTH = 4;

export interface Secret {
  /** What it is, for warnings ("OPENAI_API_KEY"). Never the value. */
  name: string;
  value: string;
  /**
   * Only where it appears as a URL password (`:<value>@`), never as a bare
   * word: database passwords are often short, common words.
   */
  inUrl?: boolean;
}

/**
 * The ends of a text where a cut went through it: output an output limit
 * stopped keeping (`end`), or a rolling tail that dropped what came before
 * it (`start`).
 */
export interface CutEdges {
  start?: boolean;
  end?: boolean;
}

/**
 * Returns a copy of `value` with every secret in its strings replaced. With
 * `cut`, `value` is a string that a cut ended or started: at those edges, a
 * leading piece of a secret (at `end`) or a trailing one (at `start`) of at
 * least `MIN_CUT_FRAGMENT_LENGTH` characters is replaced too.
 */
export type Redactor = <Value>(value: Value, cut?: CutEdges) => Value;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The secrets that cannot be redacted safely, by name, for a boot warning. */
export function tooShortToRedact(secrets: readonly Secret[]): string[] {
  return [
    ...new Set(
      secrets
        .filter(
          (secret) =>
            !secret.inUrl &&
            secret.value.length > 0 &&
            secret.value.length < MIN_BARE_SECRET_LENGTH,
        )
        .map((secret) => secret.name),
    ),
  ];
}

/** A bare secret, with what finding its pieces at a cut edge needs. */
interface Pattern {
  value: string;
  /** The KMP failure function of `value`. */
  fail: Int32Array;
  /** `value` reversed, and its failure function, for the start edge. */
  reversed: string;
  failReversed: Int32Array;
}

function failure(pattern: string): Int32Array {
  const fail = new Int32Array(pattern.length);
  let matched = 0;
  for (let index = 1; index < pattern.length; index += 1) {
    const code = pattern.charCodeAt(index);
    while (matched > 0 && code !== pattern.charCodeAt(matched))
      matched = fail[matched - 1] ?? 0;
    if (code === pattern.charCodeAt(matched)) matched += 1;
    fail[index] = matched;
  }
  return fail;
}

const reverse = (text: string) => {
  let out = "";
  for (let index = text.length - 1; index >= 0; index -= 1) out += text[index];
  return out;
};

/**
 * The length of the longest proper prefix of `pattern` that the characters
 * `at(0) … at(count - 1)` end with: one pass of Knuth–Morris–Pratt, so linear
 * in the pattern whatever the text.
 */
function overhang(
  pattern: string,
  fail: Int32Array,
  count: number,
  at: (index: number) => number,
): number {
  let matched = 0;
  for (let index = 0; index < count; index += 1) {
    const code = at(index);
    while (matched > 0 && code !== pattern.charCodeAt(matched))
      matched = fail[matched - 1] ?? 0;
    if (code === pattern.charCodeAt(matched)) matched += 1;
    if (matched === pattern.length) matched = fail[matched - 1] ?? 0;
  }
  return matched;
}

const REPLACEMENT = 0xfffd;
/** A cut through a multi-byte character decodes to replacement characters. */
const MAX_REPLACEMENTS = 3;
const COLON = 58;
const AT = 64;

/**
 * Where the span a cut at the end of `text` masks starts: before the longest
 * piece of a secret the raw text ends with (a bare secret's leading piece of
 * at least `MIN_CUT_FRAGMENT_LENGTH`, or a database password's piece of any
 * length after the colon that opens it), widened over every whole secret it
 * starts inside. `text.length` when there is nothing to mask.
 */
function endSpan(
  text: string,
  bare: readonly Pattern[],
  inUrl: readonly string[],
): number {
  let end = text.length;
  while (
    end > 0 &&
    text.length - end < MAX_REPLACEMENTS &&
    text.charCodeAt(end - 1) === REPLACEMENT
  )
    end -= 1;
  let longest = 0;
  for (const secret of bare) {
    const count = Math.min(end, secret.value.length - 1);
    const from = end - count;
    const length = overhang(secret.value, secret.fail, count, (index) =>
      text.charCodeAt(from + index),
    );
    if (length >= MIN_CUT_FRAGMENT_LENGTH && length > longest) longest = length;
  }
  for (const password of inUrl)
    for (
      let colon = Math.max(0, end - password.length - 1);
      colon < end - 1;
      colon += 1
    )
      if (
        text.charCodeAt(colon) === COLON &&
        password.startsWith(text.slice(colon + 1, end))
      ) {
        longest = Math.max(longest, end - colon - 1);
        break;
      }
  return longest > 0
    ? widenLeft(text, end - longest, bare, inUrl)
    : text.length;
}

/**
 * Moves `start` left over every whole secret it falls inside (a database
 * password with its `@`), until none: what is left before the span never
 * ends partway into one. Each round looks only at the windows around
 * `start`, a secret's length on either side.
 */
function widenLeft(
  text: string,
  start: number,
  bare: readonly Pattern[],
  inUrl: readonly string[],
): number {
  for (;;) {
    let next = start;
    for (const { value } of bare) {
      const from = Math.max(0, start - value.length + 1);
      const at = text.slice(from, start + value.length - 1).indexOf(value);
      if (at >= 0 && from + at < next) next = from + at;
    }
    for (const password of inUrl) {
      const from = Math.max(0, start - password.length - 1);
      const at = text
        .slice(from, start + password.length)
        .indexOf(`:${password}@`);
      if (at >= 0 && from + at + 1 < next) next = from + at + 1;
    }
    if (next === start) return start;
    start = next;
  }
}

/**
 * Where the span a cut at the start of `text` masks ends: after the longest
 * piece of a secret the raw text starts with (a bare secret's trailing piece
 * of at least `MIN_CUT_FRAGMENT_LENGTH`, or a database password's piece of
 * any length before the `@` that closes it), widened over every whole secret
 * it ends inside. 0 when there is nothing to mask.
 */
function startSpan(
  text: string,
  bare: readonly Pattern[],
  inUrl: readonly string[],
): number {
  let start = 0;
  while (
    start < text.length &&
    start < MAX_REPLACEMENTS &&
    text.charCodeAt(start) === REPLACEMENT
  )
    start += 1;
  let longest = 0;
  for (const secret of bare) {
    const count = Math.min(text.length - start, secret.value.length - 1);
    const last = start + count - 1;
    const length = overhang(
      secret.reversed,
      secret.failReversed,
      count,
      (index) => text.charCodeAt(last - index),
    );
    if (length >= MIN_CUT_FRAGMENT_LENGTH && length > longest) longest = length;
  }
  for (const password of inUrl)
    for (
      let at = Math.min(text.length - 1, start + password.length);
      at > start;
      at -= 1
    )
      if (
        text.charCodeAt(at) === AT &&
        password.endsWith(text.slice(start, at))
      ) {
        longest = Math.max(longest, at - start);
        break;
      }
  return longest > 0 ? widenRight(text, start + longest, bare, inUrl) : 0;
}

/** `widenLeft` for the end of a span that starts the text. */
function widenRight(
  text: string,
  end: number,
  bare: readonly Pattern[],
  inUrl: readonly string[],
): number {
  for (;;) {
    let next = end;
    for (const { value } of bare) {
      const from = Math.max(0, end - value.length + 1);
      const at = text.slice(from, end + value.length - 1).lastIndexOf(value);
      if (at >= 0 && from + at + value.length > next)
        next = from + at + value.length;
    }
    for (const password of inUrl) {
      const from = Math.max(0, end - password.length);
      const at = text
        .slice(from, end + password.length + 1)
        .lastIndexOf(`:${password}@`);
      if (at >= 0 && from + at + 1 + password.length > next)
        next = from + at + 1 + password.length;
    }
    if (next === end) return end;
    end = next;
  }
}

export function createRedactor(secrets: readonly Secret[]): Redactor {
  const bare = [
    ...new Set(
      secrets
        .filter(
          (secret) =>
            !secret.inUrl && secret.value.length >= MIN_BARE_SECRET_LENGTH,
        )
        .map((secret) => secret.value),
    ),
  ]
    // Longest first, so a secret containing another is replaced whole.
    .sort((a, b) => b.length - a.length);
  const inUrl = [
    ...new Set(
      secrets
        .filter((secret) => secret.inUrl && secret.value.length > 0)
        .map((secret) => secret.value),
    ),
  ].sort((a, b) => b.length - a.length);
  const urlPattern =
    inUrl.length > 0
      ? new RegExp(`:(?:${inUrl.map(escape).join("|")})@`, "g")
      : undefined;
  if (bare.length === 0 && !urlPattern) return <Value>(value: Value) => value;
  // Built on the first cut, which most redactors never see.
  let patterns: Pattern[] | undefined;
  const piecesOf = () => {
    patterns ??= bare.map((value) => {
      const reversed = reverse(value);
      return {
        value,
        fail: failure(value),
        reversed,
        failReversed: failure(reversed),
      };
    });
    return patterns;
  };
  const whole = (input: string) => {
    let out = input;
    for (const secret of bare)
      if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    if (urlPattern && out.includes("@"))
      out = out.replace(urlPattern, `:${REDACTED}@`);
    return out;
  };
  // The spans a cut masks are found on the raw text, before anything is
  // replaced: a secret replaced first could hide the piece of another one
  // that holds it. What lies between them is then redacted whole.
  const text = (input: string, cut?: CutEdges) => {
    if ((!cut?.start && !cut?.end) || input.length === 0) return whole(input);
    const pieces = piecesOf();
    // Cut at both ends inside one secret: all of it is a piece of that one.
    if (
      cut.start &&
      cut.end &&
      input.length >= MIN_CUT_FRAGMENT_LENGTH &&
      bare.some(
        (secret) => secret.length > input.length && secret.includes(input),
      )
    )
      return REDACTED;
    const to = cut.end ? endSpan(input, pieces, inUrl) : input.length;
    const from = cut.start ? startSpan(input, pieces, inUrl) : 0;
    if (from >= to) return REDACTED;
    return `${from > 0 ? REDACTED : ""}${whole(input.slice(from, to))}${to < input.length ? REDACTED : ""}`;
  };
  return <Value>(value: Value, cut?: CutEdges): Value =>
    typeof value === "string"
      ? (text(value, cut) as Value)
      : (redactDeep(value, (input) => text(input)) as Value);
}

function redactDeep(value: unknown, text: (input: string) => string): unknown {
  if (typeof value === "string") return text(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, text));
  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactDeep(item, text)]),
    );
  return value;
}
