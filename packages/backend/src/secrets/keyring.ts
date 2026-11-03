// Encryption of stored secrets. The master key comes from the server's
// environment (`JJ_SECRET_KEY`) and is never stored, so the database alone
// reveals no value: only its last four characters, kept as a hint, and its
// length, which the ciphertext's gives away. Each value is sealed with
// AES-256-GCM under a key derived from the master key, with a fresh random
// nonce, and bound to its row (owner, kind, name) as associated data, so a
// ciphertext copied onto another row does not open. Previous master keys
// (`JJ_SECRET_KEY_PREVIOUS`) still open what they sealed, for rotation.
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  hkdfSync,
  randomBytes,
} from "node:crypto";

/** Least master key length, in bytes: `openssl rand -base64 32`. */
export const MIN_MASTER_KEY_BYTES = 32;

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const ENCRYPTION_INFO = "jj-bot secrets v1 encryption";
const KEY_ID_INFO = "jj-bot secrets v1 key id";

/** A master key that cannot be used. The message names the variable, never the value. */
export class MasterKeyError extends Error {
  override readonly name = "MasterKeyError";
}

/**
 * Decodes a master key: base64 (standard or URL-safe, padding optional) of
 * at least 32 bytes. `name` is the variable, for the message.
 */
export function parseMasterKey(text: string, name: string): Buffer {
  const value = text.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(value) || value.length % 4 === 1)
    throw new MasterKeyError(
      `${name} must be base64, such as the output of \`openssl rand -base64 32\`.`,
    );
  const bytes = Buffer.from(
    value.replaceAll("-", "+").replaceAll("_", "/"),
    "base64",
  );
  if (bytes.length < MIN_MASTER_KEY_BYTES)
    throw new MasterKeyError(
      `${name} must decode to at least ${MIN_MASTER_KEY_BYTES} random bytes; generate one with \`openssl rand -base64 32\`.`,
    );
  return bytes;
}

/** What a sealed value is stored as. */
export interface Sealed {
  /** The key that sealed it (`Keyring.currentKeyId` then). */
  keyId: string;
  nonce: Uint8Array;
  /** Ciphertext with the GCM tag appended. */
  ciphertext: Uint8Array;
}

interface DerivedKey {
  id: string;
  key: Buffer;
}

function derive(master: Buffer): DerivedKey {
  const key = Buffer.from(
    hkdfSync("sha256", master, Buffer.alloc(0), ENCRYPTION_INFO, 32),
  );
  // An HMAC of the derived key: names the key without revealing anything of it.
  const id = createHmac("sha256", key)
    .update(KEY_ID_INFO)
    .digest("hex")
    .slice(0, 16);
  return { id, key };
}

export interface Keyring {
  /** The id of the key new values are sealed with. */
  readonly currentKeyId: string;
  /** True when one of the keys (current or previous) has this id. */
  knows(keyId: string): boolean;
  seal(plaintext: string, aad: string): Sealed;
  /** The value, or undefined when no key opens it (another key, or tampered). */
  open(sealed: Sealed, aad: string): string | undefined;
}

/** A keyring over the current master key and any previous ones. */
export function createKeyring(
  current: Buffer,
  previous: readonly Buffer[] = [],
): Keyring {
  const primary = derive(current);
  const keys = new Map<string, Buffer>([[primary.id, primary.key]]);
  for (const master of previous) {
    const derived = derive(master);
    if (!keys.has(derived.id)) keys.set(derived.id, derived.key);
  }
  return {
    currentKeyId: primary.id,
    knows: (keyId) => keys.has(keyId),
    seal(plaintext, aad) {
      const nonce = randomBytes(NONCE_BYTES);
      const cipher = createCipheriv("aes-256-gcm", primary.key, nonce);
      cipher.setAAD(Buffer.from(aad, "utf8"));
      const body = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      return { keyId: primary.id, nonce, ciphertext: body };
    },
    open(sealed, aad) {
      const key = keys.get(sealed.keyId);
      if (
        !key ||
        sealed.nonce.byteLength !== NONCE_BYTES ||
        sealed.ciphertext.byteLength < TAG_BYTES
      )
        return undefined;
      const body = Buffer.from(sealed.ciphertext);
      try {
        const decipher = createDecipheriv(
          "aes-256-gcm",
          key,
          Buffer.from(sealed.nonce),
        );
        decipher.setAAD(Buffer.from(aad, "utf8"));
        decipher.setAuthTag(body.subarray(body.length - TAG_BYTES));
        return Buffer.concat([
          decipher.update(body.subarray(0, body.length - TAG_BYTES)),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        return undefined;
      }
    },
  };
}
