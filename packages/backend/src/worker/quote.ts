// Quoting stored text into a session's input. Engine-written inputs (the
// handoff note, a child session's first input) carry text other bots or the
// user wrote: every line of it starts with "> ", so it cannot pass for the
// engine's own lines. A line ends at any break a model may read as one, not
// only "\n". A long quote keeps its start and its end around a line that
// counts what it leaves out.

/** Starts every quoted line. */
export const QUOTE = "> ";

/** Line breaks a model may read as one: CRLF, CR, LF, NEL, LS and PS. */
const LINE_BREAK = /\r\n?|\n|\u0085|\u2028|\u2029/;

/** `text` with every line break as "\n". */
const normalizeBreaks = (text: string) =>
  text.replace(new RegExp(LINE_BREAK, "g"), "\n");

/** `text` quoted line by line, each line, whatever ended it, after "> ". */
export const quoteLines = (text: string) =>
  text
    .split(LINE_BREAK)
    .map((line) => `${QUOTE}${line}`)
    .join("\n");

/** What `text`, with its breaks normalized, takes once quoted. */
const sizeOf = (text: string) =>
  text.length + QUOTE.length * text.split("\n").length;

/** What `text`, trimmed, takes quoted whole: what `quoteClipped` needs to keep all of it. */
export const quotedSize = (text: string) =>
  sizeOf(normalizeBreaks(text).trim());

/** Stands for the middle a clipped quote leaves out. */
const elision = (count: number) => `[… ${count} characters left out …]`;

/** The share of a clipped quote's room kept from its start; its end gets the rest. */
const HEAD_SHARE = 0.6;

/**
 * The longest start (or end) of `text` (breaks normalized) whose quote fits
 * in `budget` characters, never splitting a surrogate pair.
 */
function fit(text: string, budget: number, end: "start" | "end"): string {
  let cost = QUOTE.length;
  let taken = 0;
  while (taken < text.length) {
    const char = end === "start" ? text[taken] : text[text.length - 1 - taken];
    const next = cost + 1 + (char === "\n" ? QUOTE.length : 0);
    if (next > budget) break;
    cost = next;
    taken += 1;
  }
  return end === "start"
    ? text
        .slice(0, taken)
        .replace(/[\uD800-\uDBFF]$/, "")
        .trimEnd()
    : text
        .slice(text.length - taken)
        .replace(/^[\uDC00-\uDFFF]/, "")
        .trimStart();
}

/**
 * `text`, trimmed, as a quote of at most `max` characters with its "> "
 * prefixes. Its line breaks become "\n". A longer text keeps its start and
 * its end (where a report says what is left open) around a line that says
 * how many characters are left out.
 */
export function quoteClipped(text: string, max: number): string {
  const whole = normalizeBreaks(text).trim();
  if (sizeOf(whole) <= max) return quoteLines(whole);
  // Room for the start and the end: what the marker line, at its longest
  // count, and the two line breaks around it leave.
  const room = max - sizeOf(elision(whole.length)) - 2;
  const headRoom = Math.ceil(room * HEAD_SHARE);
  const head = fit(whole, headRoom, "start");
  const tail = fit(whole, room - headRoom, "end");
  const left = whole.length - head.length - tail.length;
  return [head, elision(left), tail].map(quoteLines).join("\n");
}
