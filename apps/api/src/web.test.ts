// Serving the built web app: files, the SPA fallback, and never shadowing
// `/api` or `/health`.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type JJApp } from "./app";
import { OPEN_TIMEOUT, quietLogger, type TestApp, testApp } from "./testing";

const json = (response: Response): Promise<any> => response.json();
let t: TestApp;
let dist: string;
let app: JJApp;

beforeAll(async () => {
  t = await testApp({ startWorker: false });
  dist = await mkdtemp(join(tmpdir(), "jj-web-dist-"));
  await mkdir(join(dist, "assets"));
  await writeFile(join(dist, "index.html"), "<!doctype html><title>JJ</title>");
  await writeFile(join(dist, "assets", "app-1234.js"), "console.log(1)");
  // Files that would shadow API paths if static serving came first.
  await mkdir(join(dist, "api"));
  await writeFile(join(dist, "api", "bootstrap"), "shadowed");
  await writeFile(join(dist, "health"), "shadowed");
  app = createApp({
    engine: t.engine,
    config: { workerEmbedded: false, webDist: dist },
    logger: quietLogger,
  });
}, OPEN_TIMEOUT);
afterAll(async () => {
  await t?.dispose();
  if (dist) await rm(dist, { recursive: true, force: true });
});

describe("the built web app", () => {
  it("serves index.html at / and hashed assets with long caching", async () => {
    const index = await app.request("/");
    expect(index.status).toBe(200);
    expect(await index.text()).toContain("<title>JJ</title>");
    const asset = await app.request("/assets/app-1234.js");
    expect(asset.status).toBe(200);
    expect(asset.headers.get("Content-Type")).toContain("javascript");
    expect(asset.headers.get("Cache-Control")).toContain("immutable");
  });

  it("falls back to index.html for client routes, but not for missing files", async () => {
    const route = await app.request("/tasks/task_123");
    expect(route.status).toBe(200);
    expect(route.headers.get("Content-Type")).toContain("text/html");
    expect(await route.text()).toContain("<title>JJ</title>");
    const missing = await app.request("/assets/missing.js");
    expect(missing.status).toBe(404);
    const post = await app.request("/tasks", { method: "POST" });
    expect(post.status).toBe(404);
  });

  it("never answers /api or /health from static files", async () => {
    const bootstrap = await app.request("/api/bootstrap");
    expect(bootstrap.headers.get("Content-Type")).toContain("application/json");
    expect((await json(bootstrap)).mode).toBe("backend");
    const health = await app.request("/health");
    expect((await json(health)).status).toBe("ok");
    const unknown = await app.request("/api/unknown-page");
    expect(unknown.status).toBe(404);
    expect((await json(unknown)).error.code).toBe("NOT_FOUND");
  });

  it("is off when there is no build", async () => {
    const response = await t.app.request("/");
    expect(response.status).toBe(404);
    expect((await json(response)).error.code).toBe("NOT_FOUND");
  });
});
