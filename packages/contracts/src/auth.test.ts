import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { API_ERROR_CODES } from "./api";
import {
  authSessionSchema,
  authStateSchema,
  loginCommandSchema,
  rateLimitedDetailsSchema,
  rotateTokenCommandSchema,
} from "./auth";
import { CONTRACT_VERSION } from "./common";

const session = {
  id: "auth_01",
  label: "Firefox on Linux",
  createdAt: "2026-11-09T10:00:00.000Z",
  lastSeenAt: "2026-11-09T10:00:00.000Z",
  expiresAt: "2026-11-16T10:00:00.000Z",
  current: true,
};

describe("contract version 1.15.0 (sign-in)", () => {
  it("is 1.15.0, and the changelog's newest entry records it", () => {
    expect(CONTRACT_VERSION).toBe("1.15.0");
    const changelog = readFileSync(
      new URL("../../../docs/contract-changelog.md", import.meta.url),
      "utf8",
    );
    const newest = /^## (\d+\.\d+\.\d+) — /m.exec(changelog)?.[1];
    expect(newest).toBe(CONTRACT_VERSION);
    expect(changelog).toMatch(/^## 1\.15\.0 — .* — Sign-in$/m);
  });

  it("adds no error code: sign-in refusals use UNAUTHORIZED and RATE_LIMITED", () => {
    expect(API_ERROR_CODES).toContain("UNAUTHORIZED");
    expect(API_ERROR_CODES).toContain("RATE_LIMITED");
    expect(
      rateLimitedDetailsSchema.safeParse({ retryAfterSeconds: 0 }).success,
    ).toBe(false);
    expect(rateLimitedDetailsSchema.parse({ retryAfterSeconds: 60 })).toEqual({
      retryAfterSeconds: 60,
    });
  });
});

describe("sign-in shapes", () => {
  it("takes exactly one credential per sign-in", () => {
    for (const command of [
      { token: "t" },
      { password: "correct horse" },
      { code: "abc" },
    ])
      expect(loginCommandSchema.parse(command)).toEqual(command);
    for (const command of [
      {},
      { token: "" },
      { token: "t", password: "p" },
      { code: "c", extra: true },
      { token: "x".repeat(1025) },
    ])
      expect(
        loginCommandSchema.safeParse(command).success,
        JSON.stringify(command),
      ).toBe(false);
  });

  it("rotates with the current token or the password, never a code", () => {
    expect(rotateTokenCommandSchema.parse({ current: { token: "t" } })).toEqual(
      { current: { token: "t" } },
    );
    expect(
      rotateTokenCommandSchema.safeParse({ current: { code: "c" } }).success,
    ).toBe(false);
    expect(rotateTokenCommandSchema.safeParse({ token: "t" }).success).toBe(
      false,
    );
  });

  it("reads the state and sessions", () => {
    expect(
      authStateSchema.parse({
        required: true,
        authenticated: true,
        via: "cookie",
        methods: { token: true, password: false, passkey: false },
        session,
      }).session,
    ).toEqual(session);
    expect(
      authSessionSchema.safeParse({ ...session, label: "x".repeat(81) })
        .success,
    ).toBe(false);
    expect(
      authStateSchema.safeParse({
        required: false,
        authenticated: true,
        via: "token",
        methods: { token: false, password: false, passkey: false },
        session: null,
      }).success,
    ).toBe(false);
  });
});
