// Security headers on every answer: pages, files, API answers and errors,
// streams, health and metrics; framing refused; HSTS only over https; and
// the policy's script hash matching the web app's inline script. Artifact
// downloads keep their own sandbox policy (routes.test.ts).
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type JJApp } from "./app";
import { REPO_ROOT } from "./config";
import {
  CONTENT_SECURITY_POLICY,
  INLINE_SCRIPT_HASHES,
  securityHeaders,
} from "./headers";
import { type RunningServer, startServer } from "./server";
import { OPEN_TIMEOUT, quietLogger, type TestApp, testApp } from "./testing";

const TOKEN = "headers-test-token-0123456789";

/** A policy's directives by name, each with its sources. */
const directives = (policy: string | null) =>
  new Map(
    (policy ?? "")
      .split(";")
      .map((part) => part.trim().split(/\s+/))
      .filter(([name]) => name)
      .map(([name, ...sources]) => [name as string, sources]),
  );

function expectSecured(response: Response, label: string) {
  const { headers } = response;
  expect(headers.get("Content-Security-Policy"), label).toBe(
    CONTENT_SECURITY_POLICY,
  );
  expect(headers.get("X-Frame-Options"), label).toBe("DENY");
  expect(headers.get("Referrer-Policy"), label).toBe("no-referrer");
  expect(headers.get("X-Content-Type-Options"), label).toBe("nosniff");
  expect(headers.get("Strict-Transport-Security"), label).toBeNull();
}

let t: TestApp;
let dist: string;
let app: JJApp;
let tokened: JJApp;
let https: JJApp;

beforeAll(async () => {
  t = await testApp({ startWorker: false });
  dist = await mkdtemp(join(tmpdir(), "jj-headers-dist-"));
  await mkdir(join(dist, "assets"));
  await writeFile(join(dist, "index.html"), "<!doctype html><title>JJ</title>");
  await writeFile(join(dist, "assets", "app-12345678.js"), "console.log(1)");
  await writeFile(
    join(dist, "sw.js"),
    "self.addEventListener('fetch', () => {})",
  );
  await writeFile(join(dist, "manifest.webmanifest"), "{}");
  const config = { workerEmbedded: false, webDist: dist };
  app = createApp({ engine: t.engine, config, logger: quietLogger });
  tokened = createApp({
    engine: t.engine,
    config: { ...config, apiToken: TOKEN },
    logger: quietLogger,
  });
  https = createApp({
    engine: t.engine,
    config: { ...config, strictTransportSecurity: true },
    logger: quietLogger,
  });
}, OPEN_TIMEOUT);
afterAll(async () => {
  await t?.dispose();
  if (dist) await rm(dist, { recursive: true, force: true });
});

describe("security headers", () => {
  it("are on every page and file of the web app", async () => {
    for (const path of [
      "/",
      "/index.html",
      "/tasks/task_123",
      "/assets/app-12345678.js",
      "/sw.js",
      "/manifest.webmanifest",
      "/assets/missing.js",
    ]) {
      const response = await app.request(path);
      expect(response.status, path).toBe(
        path === "/assets/missing.js" ? 404 : 200,
      );
      expectSecured(response, path);
    }
    expectSecured(await app.request("/", { method: "HEAD" }), "HEAD /");
  });

  it("are on every API answer: data, refusals, errors, streams, health and metrics", async () => {
    const answers: [string, Response | Promise<Response>, number][] = [
      ["bootstrap", app.request("/api/bootstrap"), 200],
      ["unknown route", app.request("/api/nope"), 404],
      [
        "cross-site",
        app.request("/api/bootstrap", {
          headers: { "Sec-Fetch-Site": "cross-site" },
        }),
        403,
      ],
      [
        "foreign Host",
        app.request("/api/bootstrap", {
          headers: { Host: "attacker.example" },
        }),
        403,
      ],
      [
        "not JSON",
        app.request("/api/bots", {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body: "{}",
        }),
        415,
      ],
      [
        "invalid body",
        app.request("/api/bots", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{",
        }),
        400,
      ],
      ["no token", tokened.request("/api/bootstrap"), 401],
      [
        "metrics",
        tokened.request("/metrics", {
          headers: { Authorization: `Bearer ${TOKEN}` },
        }),
        200,
      ],
      ["stream", app.request("/api/stream", { method: "HEAD" }), 200],
      ["health", app.request("/health"), 200],
    ];
    for (const [label, pending, status] of answers) {
      const response = await pending;
      expect(response.status, label).toBe(status);
      expectSecured(response, label);
    }
  });

  it("refuse framing: frame-ancestors 'none' and X-Frame-Options DENY", async () => {
    for (const path of ["/", "/tasks/task_123", "/api/bootstrap"]) {
      const response = await app.request(path);
      const policy = directives(
        response.headers.get("Content-Security-Policy"),
      );
      expect(policy.get("frame-ancestors"), path).toEqual(["'none'"]);
      expect(response.headers.get("X-Frame-Options"), path).toBe("DENY");
    }
  });

  it("allow only this origin, and no inline script but the web app's own", () => {
    const policy = directives(CONTENT_SECURITY_POLICY);
    expect(Object.fromEntries(policy)).toEqual({
      "default-src": ["'self'"],
      "script-src": ["'self'", ...INLINE_SCRIPT_HASHES],
      "connect-src": ["'self'"],
      "frame-ancestors": ["'none'"],
      "base-uri": ["'none'"],
      "object-src": ["'none'"],
    });
  });

  it("send Strict-Transport-Security only when the app is opened over https", async () => {
    for (const path of ["/", "/api/bootstrap", "/health"]) {
      const response = await https.request(path);
      expect(response.headers.get("Strict-Transport-Security"), path).toBe(
        "max-age=31536000",
      );
      expect(response.headers.get("X-Frame-Options"), path).toBe("DENY");
      expect(
        (await app.request(path)).headers.has("Strict-Transport-Security"),
      ).toBe(false);
    }
  });

  it("are set on a response whose headers are immutable", async () => {
    const bare = new Hono();
    bare.use("*", securityHeaders({ strictTransportSecurity: false }));
    bare.get("/", () => Response.redirect("http://127.0.0.1/elsewhere", 302));
    const response = await bare.request("/");
    expect(response.status).toBe(302);
    expect(response.headers.get("Location")).toBe("http://127.0.0.1/elsewhere");
    expectSecured(response, "redirect");
  });
});

/** The text of every `<script>` without `src` in an HTML file. */
const inlineScripts = (html: string) =>
  [
    ...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi),
  ].map(([, body]) => body ?? "");

const sha256Source = (text: string) =>
  `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

describe("the web app's inline script", () => {
  it("is allowed by its hash, and nothing else inline is", async () => {
    const files = [join(REPO_ROOT, "apps/web/index.html")];
    // The build keeps the script as written; check it too when it exists.
    const built = join(REPO_ROOT, "apps/web/dist/index.html");
    if (existsSync(built)) files.push(built);
    for (const file of files) {
      const scripts = inlineScripts(await readFile(file, "utf8"));
      expect(scripts.length, file).toBeGreaterThan(0);
      expect(scripts.map(sha256Source), file).toEqual([
        ...INLINE_SCRIPT_HASHES,
      ]);
    }
  });
});

describe("a real server", () => {
  const servers: RunningServer[] = [];
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "jj-headers-"));
  });
  afterAll(async () => {
    for (const server of servers) await server.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  const boot = async (env: Record<string, string>) => {
    const server = await startServer({
      logger: quietLogger,
      env: {
        API_PORT: "0",
        JJ_DATABASE_PATH: "memory://",
        JJ_SANDBOX_DRIVERS: "local",
        JJ_SANDBOX_ROOT: root,
        ...env,
      },
    });
    servers.push(server);
    return server;
  };

  it(
    "sends Strict-Transport-Security when API_PUBLIC_URL is https, and not over plain http",
    async () => {
      const local = await boot({});
      const plain = await fetch(`${local.url}/health`);
      expectSecured(plain, "loopback http");

      const proxied = await boot({
        API_TOKEN: TOKEN,
        API_PUBLIC_URL: "https://jj.example.com",
      });
      for (const path of ["/health", "/api/bootstrap"]) {
        const response = await fetch(`${proxied.url}${path}`, {
          headers: { Authorization: `Bearer ${TOKEN}` },
        });
        expect(response.status, path).toBe(200);
        expect(response.headers.get("Strict-Transport-Security"), path).toBe(
          "max-age=31536000",
        );
        expect(response.headers.get("Content-Security-Policy"), path).toBe(
          CONTENT_SECURITY_POLICY,
        );
      }
    },
    OPEN_TIMEOUT,
  );
});
