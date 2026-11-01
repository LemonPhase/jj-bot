// Bearer auth on `/api/*` when API_TOKEN is set; `/health` stays open.
import { apiErrorSchema } from "@jj/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { OPEN_TIMEOUT, quietLogger, type TestApp, testApp } from "./testing";

const TOKEN = "s3cret-token-for-tests";
let t: TestApp;

beforeAll(async () => {
  t = await testApp({ app: { apiToken: TOKEN } });
}, OPEN_TIMEOUT);
afterAll(async () => {
  await t?.dispose();
});

const unauthorized = async (response: Response) => {
  expect(response.status).toBe(401);
  expect(response.headers.get("WWW-Authenticate")).toContain("Bearer");
  expect(apiErrorSchema.parse(await response.json()).error.code).toBe(
    "UNAUTHORIZED",
  );
};

describe("with API_TOKEN set", () => {
  it("refuses /api requests without the right bearer token", async () => {
    await unauthorized(await t.app.request("/api/bootstrap"));
    for (const authorization of [
      `Bearer ${TOKEN}x`,
      `Bearer ${TOKEN.slice(0, -1)}`,
      TOKEN,
      `Basic ${TOKEN}`,
      "Bearer",
    ])
      await unauthorized(
        await t.app.request("/api/bootstrap", {
          headers: { Authorization: authorization },
        }),
      );
  });

  it("guards writes, streams and unknown routes too", async () => {
    await unauthorized(
      await t.app.request("/api/bots", {
        method: "POST",
        body: JSON.stringify({ name: "Sneaky" }),
      }),
    );
    await unauthorized(await t.app.request("/api/stream"));
    await unauthorized(await t.app.request("/api/tasks/task_x/stream"));
    await unauthorized(await t.app.request("/api/nope"));
    const bots = await t.call("GET", "/api/bots", undefined, {
      Authorization: `Bearer ${TOKEN}`,
    });
    expect(bots.body.bots).toEqual([]);
  });

  it("accepts the token, with the scheme in any case", async () => {
    for (const scheme of ["Bearer", "bearer", "BEARER"]) {
      const response = await t.app.request("/api/bootstrap", {
        headers: { Authorization: `${scheme} ${TOKEN}` },
      });
      expect(response.status).toBe(200);
    }
  });

  it("leaves /health and /health/ready unauthenticated", async () => {
    expect((await t.app.request("/health")).status).toBe(200);
    expect((await t.app.request("/health/ready")).status).toBe(200);
  });
});

describe("without API_TOKEN", () => {
  it("serves /api without any header", async () => {
    const app = createApp({
      engine: t.engine,
      config: { workerEmbedded: false },
      logger: quietLogger,
    });
    expect((await app.request("/api/bootstrap")).status).toBe(200);
    expect(
      (
        await app.request("/api/bootstrap", {
          headers: { Authorization: "Bearer anything" },
        })
      ).status,
    ).toBe(200);
  });
});
