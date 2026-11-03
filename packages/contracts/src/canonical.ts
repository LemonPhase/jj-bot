/**
 * Pure helpers both sides compute identically: canonical JSON and SHA-256.
 * They run in the browser and on the server alike, so they use no Node API.
 */

/** Deepest value `canonicalForm` reads; deeper ones have no canonical form. */
export const CANONICAL_DEPTH_LIMIT = 64;
/** Longest canonical JSON, in UTF-16 code units; longer values have no canonical form. */
export const CANONICAL_LENGTH_LIMIT = 1_048_576;

/** Why a value has no canonical form. */
export type CanonicalProblem = "cycle" | "depth" | "length" | "unserializable";

/**
 * A JSON value in canonical form: `json`, on one line with object keys
 * sorted by UTF-16 code units at every depth; and `words`, its keys and its
 * string and number values, unescaped, in the same order, separated by
 * spaces. Equal values give the same texts whatever their key order.
 */
export type CanonicalForm =
  | { ok: true; json: string; words: string }
  | { ok: false; problem: CanonicalProblem };

const isPlainObject = (value: object): value is Record<string, unknown> => {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

class Unreadable extends Error {
  constructor(readonly problem: CanonicalProblem) {
    super(problem);
  }
}

/**
 * The canonical form of a JSON value, or why it has none: a cycle, nesting
 * deeper than CANONICAL_DEPTH_LIMIT, JSON longer than CANONICAL_LENGTH_LIMIT,
 * or a value JSON cannot hold faithfully (a BigInt, a function, a symbol, an
 * object that is not plain, a property that throws). `undefined` is dropped
 * from objects and written as `null` in arrays, and a number that is not
 * finite as `null`, as `JSON.stringify` does. Never throws, and takes time
 * linear in the output, so it is safe on whatever a model wrote.
 */
export function canonicalForm(value: unknown): CanonicalForm {
  const json: string[] = [];
  const words: string[] = [];
  const ancestors = new Set<object>();
  let length = 0;
  const emit = (part: string) => {
    length += part.length;
    if (length > CANONICAL_LENGTH_LIMIT) throw new Unreadable("length");
    json.push(part);
  };
  // Checked before escaping, so a huge string is never copied.
  const quote = (text: string) => {
    if (length + text.length > CANONICAL_LENGTH_LIMIT)
      throw new Unreadable("length");
    return JSON.stringify(text);
  };
  const walk = (current: unknown, depth: number): void => {
    switch (typeof current) {
      case "string":
        emit(quote(current));
        words.push(current);
        return;
      case "number":
        if (Number.isFinite(current)) {
          emit(JSON.stringify(current));
          words.push(String(current));
        } else emit("null");
        return;
      case "boolean":
        emit(current ? "true" : "false");
        return;
      case "undefined":
        emit("null");
        return;
      case "object":
        break;
      default:
        throw new Unreadable("unserializable");
    }
    if (current === null) {
      emit("null");
      return;
    }
    if (depth >= CANONICAL_DEPTH_LIMIT) throw new Unreadable("depth");
    if (ancestors.has(current)) throw new Unreadable("cycle");
    ancestors.add(current);
    if (Array.isArray(current)) {
      emit("[");
      for (let index = 0; index < current.length; index += 1) {
        if (index > 0) emit(",");
        walk(current[index], depth + 1);
      }
      emit("]");
    } else if (isPlainObject(current)) {
      emit("{");
      let first = true;
      // Sorted by code units explicitly: an object would put integer-like keys first.
      for (const key of Object.keys(current).sort()) {
        const child = current[key];
        if (child === undefined) continue;
        if (!first) emit(",");
        first = false;
        emit(`${quote(key)}:`);
        words.push(key);
        walk(child, depth + 1);
      }
      emit("}");
    } else throw new Unreadable("unserializable");
    ancestors.delete(current);
  };
  try {
    walk(value, 0);
    return { ok: true, json: json.join(""), words: words.join(" ") };
  } catch (error) {
    return {
      ok: false,
      problem: error instanceof Unreadable ? error.problem : "unserializable",
    };
  }
}

/**
 * JSON on one line with object keys sorted by UTF-16 code units at every
 * depth, or undefined when the value has no canonical form (see
 * `canonicalForm`). Never throws.
 */
export function canonicalJson(value: unknown): string | undefined {
  const form = canonicalForm(value);
  return form.ok ? form.json : undefined;
}

// FIPS 180-4: the first 32 bits of the fractional parts of the cube roots of
// the first 64 primes, and of the square roots of the first 8.
const K = Uint32Array.of(
  0x428a2f98,
  0x71374491,
  0xb5c0fbcf,
  0xe9b5dba5,
  0x3956c25b,
  0x59f111f1,
  0x923f82a4,
  0xab1c5ed5,
  0xd807aa98,
  0x12835b01,
  0x243185be,
  0x550c7dc3,
  0x72be5d74,
  0x80deb1fe,
  0x9bdc06a7,
  0xc19bf174,
  0xe49b69c1,
  0xefbe4786,
  0x0fc19dc6,
  0x240ca1cc,
  0x2de92c6f,
  0x4a7484aa,
  0x5cb0a9dc,
  0x76f988da,
  0x983e5152,
  0xa831c66d,
  0xb00327c8,
  0xbf597fc7,
  0xc6e00bf3,
  0xd5a79147,
  0x06ca6351,
  0x14292967,
  0x27b70a85,
  0x2e1b2138,
  0x4d2c6dfc,
  0x53380d13,
  0x650a7354,
  0x766a0abb,
  0x81c2c92e,
  0x92722c85,
  0xa2bfe8a1,
  0xa81a664b,
  0xc24b8b70,
  0xc76c51a3,
  0xd192e819,
  0xd6990624,
  0xf40e3585,
  0x106aa070,
  0x19a4c116,
  0x1e376c08,
  0x2748774c,
  0x34b0bcb5,
  0x391c0cb3,
  0x4ed8aa4a,
  0x5b9cca4f,
  0x682e6ff3,
  0x748f82ee,
  0x78a5636f,
  0x84c87814,
  0x8cc70208,
  0x90befffa,
  0xa4506ceb,
  0xbef9a3f7,
  0xc67178f2,
);
const H0 = Uint32Array.of(
  0x6a09e667,
  0xbb67ae85,
  0x3c6ef372,
  0xa54ff53a,
  0x510e527f,
  0x9b05688c,
  0x1f83d9ab,
  0x5be0cd19,
);

const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));

/**
 * SHA-256 of the text's UTF-8 bytes, as 64 lowercase hex digits. Lone
 * surrogates encode as U+FFFD, as Node's `createHash().update(text)` does.
 * Synchronous and dependency-free, for the short inputs contract functions
 * hash; it is not meant for bulk data.
 */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const blocks = Math.ceil((bytes.length + 9) / 64);
  const padded = new Uint8Array(blocks * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = bytes.length * 8;
  view.setUint32(padded.length - 8, Math.floor(bits / 0x1_0000_0000));
  view.setUint32(padded.length - 4, bits >>> 0);

  const h = Uint32Array.from(H0);
  const w = new Uint32Array(64);
  const at = (array: Uint32Array, index: number) => array[index] ?? 0;
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const low = at(w, i - 15);
      const high = at(w, i - 2);
      const s0 = rotr(low, 7) ^ rotr(low, 18) ^ (low >>> 3);
      const s1 = rotr(high, 17) ^ rotr(high, 19) ^ (high >>> 10);
      w[i] = at(w, i - 16) + s0 + at(w, i - 7) + s1;
    }
    let a = at(h, 0);
    let b = at(h, 1);
    let c = at(h, 2);
    let d = at(h, 3);
    let e = at(h, 4);
    let f = at(h, 5);
    let g = at(h, 6);
    let k = at(h, 7);
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choice = (e & f) ^ (~e & g);
      const t1 = (k + s1 + choice + at(K, i) + at(w, i)) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) | 0;
      k = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = at(h, 0) + a;
    h[1] = at(h, 1) + b;
    h[2] = at(h, 2) + c;
    h[3] = at(h, 3) + d;
    h[4] = at(h, 4) + e;
    h[5] = at(h, 5) + f;
    h[6] = at(h, 6) + g;
    h[7] = at(h, 7) + k;
  }
  return Array.from(h, (word) => word.toString(16).padStart(8, "0")).join("");
}
