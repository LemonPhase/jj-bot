// The secrets store over HTTP: JJ_SECRET_KEY parsing, the write-only routes
// for sandbox secrets and provider keys, and that no answer, hint or log line
// carries a stored value.
import { randomBytes } from "node:crypto";
import {
  modelsViewSchema,
  secretInfoSchema,
  secretsViewSchema,
} from "@jj/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, loadServerConfig, secretKeys } from "./config";
import { OPEN_TIMEOUT, quietLogger, type TestApp, testApp } from "./testing";

const MASTER = randomBytes(32).toString("base64");
const TOKEN = "ghp_apiTestToken0123456789abcdefghijkl";
const KEY = "sk-api-test-0123456789abcdefghijklmnopq";

describe("JJ_SECRET_KEY", () => {
  it("is optional: without it the store is off", () => {
    expect(secretKeys({})).toBeUndefined();
    expect(loadServerConfig({}).secretKeys).toBeUndefined();
  });

  it("decodes the key and the previous ones, and keeps their text for redaction", () => {
    const old = randomBytes(32).toString("base64url");
    const keys = secretKeys({
      JJ_SECRET_KEY: ` ${MASTER} `,
      JJ_SECRET_KEY_PREVIOUS: `${old}, `,
    });
    expect(keys?.current).toEqual(Buffer.from(MASTER, "base64"));
    expect(keys?.previous).toEqual([Buffer.from(old, "base64url")]);
    expect(keys?.texts).toEqual([MASTER, old]);
  });

  it("stops the process on a key it cannot use, naming the variable and never the value", () => {
    const short = randomBytes(8).toString("base64");
    for (const env of [
      { JJ_SECRET_KEY: short },
      { JJ_SECRET_KEY: "correct horse battery staple" },
      { JJ_SECRET_KEY: MASTER, JJ_SECRET_KEY_PREVIOUS: short },
      { JJ_SECRET_KEY_PREVIOUS: MASTER },
    ]) {
      let caught: unknown;
      try {
        loadServerConfig(env);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      const message = (caught as Error).message;
      expect(message).toContain("JJ_SECRET_KEY");
      for (const value of Object.values(env))
        expect(message).not.toContain(value);
    }
  });
});

describe("secrets routes", () => {
  let current: TestApp | undefined;
  afterEach(async () => {
    await current?.dispose();
    current = undefined;
  });

  it(
    "store, list, replace and remove sandbox secrets without answering a value",
    async () => {
      quietLogger.lines.length = 0;
      current = await testApp({
        startWorker: false,
        secretKeys: secretKeys({ JJ_SECRET_KEY: MASTER }),
      });
      const { call } = current;
      const bodies: unknown[] = [];
      const created = await call("PUT", "/api/secrets/GITHUB_TOKEN", {
        value: TOKEN,
      });
      expect(created.status).toBe(201);
      expect(secretInfoSchema.parse(created.body.secret)).toMatchObject({
        name: "GITHUB_TOKEN",
        hint: TOKEN.slice(-4),
        readable: true,
      });
      const replaced = await call("PUT", "/api/secrets/GITHUB_TOKEN", {
        value: `${TOKEN}2`,
      });
      expect(replaced.status).toBe(200);
      const listed = await call("GET", "/api/secrets");
      expect(secretsViewSchema.parse(listed.body)).toMatchObject({
        available: true,
        secrets: [{ name: "GITHUB_TOKEN", hint: `${TOKEN}2`.slice(-4) }],
      });
      const bootstrap = await call("GET", "/api/bootstrap");
      expect(bootstrap.body.capabilities.secretStore).toBe(true);
      const refused = await call("PUT", "/api/secrets/GITHUB_TOKEN", {
        value: "too-short",
      });
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe("VALIDATION_FAILED");
      const reserved = await call("PUT", "/api/secrets/PATH", {
        value: TOKEN,
      });
      expect(reserved.status).toBe(400);
      bodies.push(created, replaced, listed, bootstrap, refused, reserved);
      const removed = await call("DELETE", "/api/secrets/GITHUB_TOKEN");
      expect(removed.status).toBe(204);
      const missing = await call("DELETE", "/api/secrets/GITHUB_TOKEN");
      expect(missing.status).toBe(404);
      const text = JSON.stringify([bodies, quietLogger.lines]);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain("too-short");
      // The master key is one of the server's secrets, so it is redacted.
      expect(
        (await current.secrets()).some(
          (secret) =>
            secret.name === "JJ_SECRET_KEY" && secret.value === MASTER,
        ),
      ).toBe(true);
    },
    OPEN_TIMEOUT,
  );

  it(
    "store a provider key that configures it, and refuse one its variable already sets",
    async () => {
      current = await testApp({
        startWorker: false,
        secretKeys: secretKeys({ JJ_SECRET_KEY: MASTER }),
        env: { ANTHROPIC_API_KEY: "sk-ant-env-0123456789abcdefghij" },
      });
      const { call } = current;
      const stored = await call("PUT", "/api/models/providers/openai/key", {
        value: KEY,
      });
      expect(stored.status).toBe(200);
      const view = modelsViewSchema.parse(stored.body);
      expect(view.providers.find((p) => p.id === "openai")).toMatchObject({
        configured: true,
        keySource: "stored",
        storedKey: { hint: KEY.slice(-4), readable: true },
      });
      const models = await call("GET", "/api/models");
      expect(JSON.stringify([stored.body, models.body])).not.toContain(KEY);
      expect(current.models.resolve("openai/gpt-6-luna").getApiKey()).toBe(KEY);
      const conflict = await call(
        "PUT",
        "/api/models/providers/anthropic/key",
        { value: KEY },
      );
      expect(conflict.status).toBe(409);
      expect(conflict.body.error.code).toBe("CONFLICT");
      const keyless = await call("PUT", "/api/models/providers/scripted/key", {
        value: KEY,
      });
      expect(keyless.status).toBe(404);
      const removed = await call("DELETE", "/api/models/providers/openai/key");
      expect(removed.status).toBe(200);
      expect(
        modelsViewSchema
          .parse(removed.body)
          .providers.find((p) => p.id === "openai")?.configured,
      ).toBe(false);
    },
    OPEN_TIMEOUT,
  );

  it(
    "refuse to store anything without JJ_SECRET_KEY, saying how to set it",
    async () => {
      current = await testApp({ startWorker: false });
      const { call } = current;
      expect((await call("GET", "/api/secrets")).body).toEqual({
        available: false,
        secrets: [],
      });
      for (const path of [
        "/api/secrets/GITHUB_TOKEN",
        "/api/models/providers/openai/key",
      ]) {
        const refused = await call("PUT", path, { value: TOKEN });
        expect(refused.status).toBe(409);
        expect(refused.body.error.code).toBe("SECRET_STORE_UNAVAILABLE");
        expect(refused.body.error.message).toContain("openssl rand -base64 32");
      }
    },
    OPEN_TIMEOUT,
  );
});
