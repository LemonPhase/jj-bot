// The optional sign-in password: `JJ_PASSWORD_HASH` holds its scrypt hash,
// which `npm run auth:hash-password` produces, so the server never stores or
// sees the password itself outside a sign-in. The format is
// `scrypt:ln=<log2 N>,r=<r>,p=<p>:<salt>:<hash>`, salt and hash in base64url:
// no `$`, which compose and shells would expand.
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/** N = 2^15, r = 8, p = 1: about 32 MiB and a few tens of milliseconds per check. */
export const PASSWORD_PARAMS = { logN: 15, r: 8, p: 1 } as const;
/** Shortest password `auth:hash-password` accepts. */
export const MIN_PASSWORD_LENGTH = 12;

const SALT_BYTES = 16;
const KEY_BYTES = 32;
/** The most memory one check may take (128 · N · r · p), whatever the hash says. */
const MAX_MEMORY = 256 * 1024 * 1024;

export interface PasswordHash {
  logN: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

/** A `JJ_PASSWORD_HASH` that cannot be used. The message never repeats the value. */
export class PasswordHashError extends Error {
  override readonly name = "PasswordHashError";
}

const FORMAT =
  /^scrypt:ln=(\d{1,2}),r=(\d{1,2}),p=(\d{1,2}):([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/;

const memoryOf = ({ logN, r, p }: Pick<PasswordHash, "logN" | "r" | "p">) =>
  128 * 2 ** logN * r * p;

/** Parses a `JJ_PASSWORD_HASH`, refusing one this server would not check. */
export function parsePasswordHash(text: string): PasswordHash {
  const match = FORMAT.exec(text.trim());
  if (!match)
    throw new PasswordHashError(
      "JJ_PASSWORD_HASH is not a password hash: make one with `npm run auth:hash-password` and set its output as it is.",
    );
  const [, logN, r, p, salt, hash] = match;
  const parsed: PasswordHash = {
    logN: Number(logN),
    r: Number(r),
    p: Number(p),
    salt: Buffer.from(salt as string, "base64url"),
    hash: Buffer.from(hash as string, "base64url"),
  };
  if (
    parsed.logN < PASSWORD_PARAMS.logN ||
    parsed.logN > 20 ||
    parsed.r < 1 ||
    parsed.p < 1 ||
    memoryOf(parsed) > MAX_MEMORY
  )
    throw new PasswordHashError(
      `JJ_PASSWORD_HASH has scrypt parameters this server does not check (at least ln=${PASSWORD_PARAMS.logN}, at most ${MAX_MEMORY / 1024 / 1024} MiB per check): make one with \`npm run auth:hash-password\`.`,
    );
  if (parsed.salt.length < SALT_BYTES || parsed.hash.length < KEY_BYTES)
    throw new PasswordHashError(
      `JJ_PASSWORD_HASH has a salt or hash shorter than ${SALT_BYTES} and ${KEY_BYTES} bytes: make one with \`npm run auth:hash-password\`.`,
    );
  return parsed;
}

function derive(
  password: string,
  params: Pick<PasswordHash, "logN" | "r" | "p" | "salt">,
  length: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(
      // NFC, so the same password typed on another system checks the same.
      Buffer.from(password.normalize("NFC"), "utf8"),
      params.salt,
      length,
      {
        N: 2 ** params.logN,
        r: params.r,
        p: params.p,
        maxmem: 2 * memoryOf(params),
      },
      (error, key) => (error ? reject(error) : resolve(key)),
    ),
  );
}

/** A new `JJ_PASSWORD_HASH` for `password`, with a random salt. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, { ...PASSWORD_PARAMS, salt }, KEY_BYTES);
  const { logN, r, p } = PASSWORD_PARAMS;
  return `scrypt:ln=${logN},r=${r},p=${p}:${salt.toString("base64url")}:${key.toString("base64url")}`;
}

/** Whether `password` is the one `stored` was made from, compared in constant time. */
export async function verifyPassword(
  stored: PasswordHash,
  password: string,
): Promise<boolean> {
  const key = await derive(password, stored, stored.hash.length);
  return timingSafeEqual(key, stored.hash);
}
