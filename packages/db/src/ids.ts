import { randomFillSync } from "node:crypto";

/** Id prefixes, one per record type. */
export const ID_PREFIXES = {
  bot: "bot",
  runtimeProfile: "prof",
  conversationMessage: "cmsg",
  task: "task",
  session: "sess",
  run: "run",
  inboxItem: "inbox",
  taskMessage: "msg",
  taskEvent: "evt",
  artifact: "art",
  usage: "use",
  job: "job",
} as const;

export type IdKind = keyof typeof ID_PREFIXES;
export type IdPrefix = (typeof ID_PREFIXES)[IdKind];

// Crockford base32: ascending in ASCII, so equal-length ULIDs sort by time.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const TIME_LENGTH = 10;
const RANDOM_LENGTH = 16;
const MAX_TIME = 2 ** 48 - 1;

let lastTime = -1;
const lastRandom = new Uint8Array(RANDOM_LENGTH);

/**
 * A ULID: 48-bit millisecond timestamp then 80 random bits, 26 characters.
 * Monotonic within one process: ids made in the same millisecond increment the
 * random part, so they still sort in creation order.
 */
export function ulid(now: number = Date.now()): string {
  if (!Number.isSafeInteger(now) || now < 0 || now > MAX_TIME)
    throw new RangeError("ULID time must be a 48-bit millisecond timestamp.");
  if (now <= lastTime) {
    // Same (or an earlier, clock-skewed) millisecond: keep the last time and
    // increment the 80-bit random part held as 16 base32 digits.
    let index = RANDOM_LENGTH - 1;
    while (index >= 0 && lastRandom[index] === 31) {
      lastRandom[index] = 0;
      index -= 1;
    }
    if (index < 0) throw new Error("ULID random part overflowed.");
    lastRandom[index] = (lastRandom[index] ?? 0) + 1;
  } else {
    lastTime = now;
    randomFillSync(lastRandom);
    for (let index = 0; index < RANDOM_LENGTH; index += 1)
      lastRandom[index] = (lastRandom[index] ?? 0) & 31;
  }
  let time = lastTime;
  let encoded = "";
  for (let index = 0; index < TIME_LENGTH; index += 1) {
    encoded = ALPHABET.charAt(time % 32) + encoded;
    time = Math.floor(time / 32);
  }
  for (const digit of lastRandom) encoded += ALPHABET.charAt(digit);
  return encoded;
}

/** A prefixed, time-sortable id such as `task_01JD3W7Z5Q…`. */
export function newId(kind: IdKind): string {
  return `${ID_PREFIXES[kind]}_${ulid()}`;
}
