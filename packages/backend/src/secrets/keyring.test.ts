import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createKeyring, MasterKeyError, parseMasterKey } from "./keyring";

const master = () => randomBytes(32);
const AAD = "jj-bot/secret/v1\u0000local\u0000sandbox\u0000GITHUB_TOKEN";
const VALUE = "ghp_0123456789abcdefghijklmnopqrstuvwxyz";

describe("parseMasterKey", () => {
  it("decodes standard and URL-safe base64 of at least 32 bytes", () => {
    const bytes = master();
    expect(parseMasterKey(bytes.toString("base64"), "K")).toEqual(bytes);
    expect(parseMasterKey(` ${bytes.toString("base64url")}\n`, "K")).toEqual(
      bytes,
    );
  });

  it("refuses short or non-base64 keys, naming the variable and never the value", () => {
    const short = randomBytes(16).toString("base64");
    for (const value of [short, "not base64 at all!", "Q", "x".repeat(41)]) {
      let caught: unknown;
      try {
        parseMasterKey(value, "JJ_SECRET_KEY");
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(MasterKeyError);
      const message = (caught as Error).message;
      expect(message).toMatch(/^JJ_SECRET_KEY must/);
      expect(message).toContain("openssl rand -base64 32");
      expect(message).not.toContain(value);
    }
  });
});

describe("keyring", () => {
  it("opens what it sealed, with a fresh nonce every time", () => {
    const keyring = createKeyring(master());
    const first = keyring.seal(VALUE, AAD);
    const second = keyring.seal(VALUE, AAD);
    expect(first.keyId).toBe(keyring.currentKeyId);
    expect(Buffer.from(first.nonce)).toHaveLength(12);
    expect(Buffer.from(first.nonce).equals(Buffer.from(second.nonce))).toBe(
      false,
    );
    expect(
      Buffer.from(first.ciphertext).equals(Buffer.from(second.ciphertext)),
    ).toBe(false);
    // The value is nowhere in what is stored.
    expect(Buffer.from(first.ciphertext).toString("utf8")).not.toContain(
      VALUE.slice(0, 8),
    );
    expect(keyring.open(first, AAD)).toBe(VALUE);
    expect(keyring.open(second, AAD)).toBe(VALUE);
  });

  it("opens nothing under another key, with a tampered body, or bound to another row", () => {
    const keyring = createKeyring(master());
    const sealed = keyring.seal(VALUE, AAD);
    const other = createKeyring(master());
    expect(other.knows(sealed.keyId)).toBe(false);
    expect(other.open(sealed, AAD)).toBeUndefined();
    // Another key under the same id still fails authentication.
    expect(
      other.open({ ...sealed, keyId: other.currentKeyId }, AAD),
    ).toBeUndefined();
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    expect(keyring.open({ ...sealed, ciphertext: tampered }, AAD)).toBe(
      undefined,
    );
    const tag = Buffer.from(sealed.ciphertext);
    tag[tag.length - 1] = (tag[tag.length - 1] ?? 0) ^ 1;
    expect(keyring.open({ ...sealed, ciphertext: tag }, AAD)).toBeUndefined();
    // Copied onto another row (another name), it does not open.
    expect(
      keyring.open(sealed, AAD.replace("GITHUB_TOKEN", "NPM_TOKEN")),
    ).toBeUndefined();
    expect(
      keyring.open({ ...sealed, nonce: Buffer.alloc(3) }, AAD),
    ).toBeUndefined();
  });

  it("keeps opening what a previous key sealed, and seals only with the current one", () => {
    const old = master();
    const before = createKeyring(old);
    const sealed = before.seal(VALUE, AAD);
    const rotated = createKeyring(master(), [old]);
    expect(rotated.currentKeyId).not.toBe(before.currentKeyId);
    expect(rotated.knows(before.currentKeyId)).toBe(true);
    expect(rotated.open(sealed, AAD)).toBe(VALUE);
    expect(rotated.seal(VALUE, AAD).keyId).toBe(rotated.currentKeyId);
    // The id names the key: the same master key always gives the same id.
    expect(createKeyring(old).currentKeyId).toBe(before.currentKeyId);
  });
});
