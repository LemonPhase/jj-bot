// Where a text stops being JSON, without quoting any of it. A `json` check
// reports this position in place of the message of `JSON.parse`, which
// quotes the text around the error: a cut of the file, perhaps through a
// secret, that redaction cannot mask once it is cut.

const TAB = 9;
const LF = 10;
const CR = 13;
const SPACE = 32;
const QUOTE = 34;
const PLUS = 43;
const COMMA = 44;
const MINUS = 45;
const DOT = 46;
const ZERO = 48;
const NINE = 57;
const COLON = 58;
const BRACKET = 91;
const BACKSLASH = 92;
const CLOSE_BRACKET = 93;
const BRACE = 123;
const CLOSE_BRACE = 125;

/** The characters after a backslash that make an escape, `u` aside. */
const ESCAPES = new Set([...'"\\/bfnrt'].map((char) => char.charCodeAt(0)));
const U = "u".charCodeAt(0);

const isSpace = (code: number) =>
  code === SPACE || code === TAB || code === LF || code === CR;
const isDigit = (code: number) => code >= ZERO && code <= NINE;
const isHex = (code: number) =>
  isDigit(code) ||
  (code >= 65 && code <= 70) || // A-F
  (code >= 97 && code <= 102); // a-f

/**
 * The offset of the first character at which `text` is no longer JSON as
 * `JSON.parse` reads it (RFC 8259): `text.length` when the text ends before
 * its value does, undefined when it is JSON. Linear in the text, and
 * iterative, so nesting depth costs no stack.
 */
export function jsonErrorOffset(text: string): number | undefined {
  const length = text.length;
  let at = 0;
  const code = () => text.charCodeAt(at);
  const space = () => {
    while (at < length && isSpace(code())) at += 1;
  };
  /** From an opening quote to past its closing one; false where it fails. */
  const string = (): boolean => {
    at += 1;
    while (at < length) {
      const char = code();
      if (char === QUOTE) {
        at += 1;
        return true;
      }
      if (char < SPACE) return false;
      if (char === BACKSLASH) {
        at += 1;
        if (at >= length) return false;
        if (code() === U)
          for (let digit = 0; digit < 4; digit += 1) {
            at += 1;
            if (at >= length || !isHex(code())) return false;
          }
        else if (!ESCAPES.has(code())) return false;
      }
      at += 1;
    }
    return false;
  };
  const digits = () => {
    while (at < length && isDigit(code())) at += 1;
  };
  const number = (): boolean => {
    if (code() === MINUS) at += 1;
    if (code() === ZERO) at += 1;
    else if (isDigit(code())) digits();
    else return false;
    if (code() === DOT) {
      at += 1;
      if (!isDigit(code())) return false;
      digits();
    }
    if (code() === 101 || code() === 69) {
      // e, E
      at += 1;
      if (code() === PLUS || code() === MINUS) at += 1;
      if (!isDigit(code())) return false;
      digits();
    }
    return true;
  };
  const literal = (word: string): boolean => {
    for (let index = 0; index < word.length; index += 1, at += 1)
      if (at >= length || code() !== word.charCodeAt(index)) return false;
    return true;
  };
  /** An object's member name and its colon. */
  const name = (): boolean => {
    space();
    if (at >= length || code() !== QUOTE || !string()) return false;
    space();
    if (at >= length || code() !== COLON) return false;
    at += 1;
    return true;
  };
  /** The open containers, innermost last: true for an object. */
  const open: boolean[] = [];
  for (;;) {
    // A value.
    space();
    if (at >= length) return length;
    const first = code();
    if (first === BRACE || first === BRACKET) {
      at += 1;
      space();
      if (code() === (first === BRACE ? CLOSE_BRACE : CLOSE_BRACKET)) at += 1;
      else {
        open.push(first === BRACE);
        if (first === BRACE && !name()) return at;
        continue;
      }
    } else if (first === QUOTE) {
      if (!string()) return at;
    } else if (first === MINUS || isDigit(first)) {
      if (!number()) return at;
    } else if (
      !literal(first === 116 ? "true" : first === 102 ? "false" : "null")
    )
      return at;
    // What may follow a complete value.
    for (;;) {
      space();
      if (open.length === 0) return at < length ? at : undefined;
      if (at >= length) return length;
      const object = open[open.length - 1];
      if (code() === COMMA) {
        at += 1;
        if (object && !name()) return at;
        break;
      }
      if (code() !== (object ? CLOSE_BRACE : CLOSE_BRACKET)) return at;
      at += 1;
      open.pop();
    }
  }
}
