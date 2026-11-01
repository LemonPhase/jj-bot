// Browser protections on /api/*: cross-site requests, foreign Host values
// without a token (DNS rebinding) and non-JSON bodies are refused, while the
// web app's own requests and the bearer-token path keep working.

import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiErrorSchema } from "@jj/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp, type JJApp } from "./app";
import { hostnameOf, isAllowedHost } from "./guard";
import { type RunningServer, startServer } from "./server";
import { OPEN_TIMEOUT, quietLogger, type TestApp, testApp } from "./testing";

const TOKEN = "guard-test-token";
let t: TestApp;
let proxied: JJApp;
let tokened: JJApp;

beforeAll(async () => {
  t = await testApp({ startWorker: false });
  proxied = createApp({
    engine: t.engine,
    config: {
      workerEmbedded: false,
      allowedHosts: ["jj.example.com", "proxy.local:8443"],
    },
    logger: quietLogger,
  });
  tokened = createApp({
    engine: t.engine,
    config: { workerEmbedded: false, apiToken: TOKEN },
    logger: quietLogger,
  });
}, OPEN_TIMEOUT);
afterAll(async () => {
  await t?.dispose();
});

const refused = async (response: Response, status: number) => {
  expect(response.status).toBe(status);
  const envelope = apiErrorSchema.parse(await response.json());
  return envelope.error;
};

const json = { "Content-Type": "application/json" };
const newBot = (name: string) => JSON.stringify({ name });

describe("host checks", () => {
  it("parses Host values", () => {
    expect(hostnameOf("LocalHost:3001")).toBe("localhost");
    expect(hostnameOf("[::1]:3001")).toBe("[::1]");
    expect(hostnameOf("127.0.0.1")).toBe("127.0.0.1");
    for (const host of [
      "localhost",
      "localhost:5173",
      "127.0.0.1:3001",
      "[::1]",
      "[::1]:3001",
    ])
      expect(isAllowedHost(host, []), host).toBe(true);
    for (const host of [
      "attacker.example",
      "attacker.example:3001",
      "localhost.attacker.example",
      "127.0.0.1.nip.io",
      "",
    ])
      expect(isAllowedHost(host, []), host).toBe(false);
    const allowed = ["jj.example.com", "proxy.local:8443"];
    expect(isAllowedHost("jj.example.com:443", allowed)).toBe(true);
    expect(isAllowedHost("proxy.local:8443", allowed)).toBe(true);
    expect(isAllowedHost("proxy.local:9000", allowed)).toBe(false);
    expect(isAllowedHost("proxy.local", allowed)).toBe(false);
  });
});

describe("without API_TOKEN", () => {
  it("refuses a cross-site text/plain POST, the CSRF a page can send without a preflight", async () => {
    const response = await t.app.request("/api/bots", {
      method: "POST",
      headers: { "Content-Type": "text/plain", "Sec-Fetch-Site": "cross-site" },
      body: newBot("Csrf"),
    });
    expect((await refused(response, 403)).code).toBe("UNAUTHORIZED");
    // Without Sec-Fetch-Site (older browsers) the content type still stops it.
    const plain = await t.app.request("/api/bots", {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: newBot("Csrf"),
    });
    expect((await refused(plain, 415)).code).toBe("VALIDATION_FAILED");
    const none = await t.app.request("/api/tasks/task_x/stop", {
      method: "POST",
    });
    await refused(none, 415);
    const bots = (await (await t.app.request("/api/bots")).json()) as {
      bots: { name: string }[];
    };
    expect(bots.bots.map((bot: { name: string }) => bot.name)).not.toContain(
      "Csrf",
    );
  });

  it("refuses cross-site reads and streams too", async () => {
    for (const path of ["/api/bootstrap", "/api/stream"])
      await refused(
        await t.app.request(path, {
          headers: { "Sec-Fetch-Site": "cross-site" },
        }),
        403,
      );
  });

  it("refuses a foreign Host, as a DNS-rebinding page sends", async () => {
    const error = await refused(
      await t.app.request("/api/bots", {
        headers: { Host: "attacker.example:3001" },
      }),
      403,
    );
    expect(error.message).toContain("API_ALLOWED_HOSTS");
    await refused(
      await t.app.request("/api/bots", {
        method: "POST",
        headers: { ...json, Host: "attacker.example" },
        body: newBot("Rebound"),
      }),
      403,
    );
  });

  it("serves the web app's own requests: loopback hosts, same origin, JSON", async () => {
    for (const host of ["localhost:5173", "127.0.0.1:3001", "[::1]:3001"]) {
      const response = await t.app.request("/api/bootstrap", {
        headers: { Host: host, "Sec-Fetch-Site": "same-origin" },
      });
      expect(response.status, host).toBe(200);
    }
    const created = await t.app.request("/api/bots", {
      method: "POST",
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Sec-Fetch-Site": "same-origin",
        Host: "127.0.0.1:3001",
      },
      body: newBot("SameOrigin"),
    });
    expect(created.status).toBe(201);
    // A typed URL or curl: no Sec-Fetch-Site, or "none".
    const typed = await t.app.request("/api/bots", {
      headers: { "Sec-Fetch-Site": "none" },
    });
    expect(typed.status).toBe(200);
  });

  it("serves the names in API_ALLOWED_HOSTS, for a reverse proxy", async () => {
    for (const host of [
      "jj.example.com",
      "jj.example.com:443",
      "proxy.local:8443",
    ])
      expect(
        (await proxied.request("/api/bootstrap", { headers: { Host: host } }))
          .status,
        host,
      ).toBe(200);
    await refused(
      await proxied.request("/api/bootstrap", {
        headers: { Host: "proxy.local:9000" },
      }),
      403,
    );
  });

  it("leaves /health open to any host", async () => {
    const response = await t.app.request("/health", {
      headers: { Host: "attacker.example" },
    });
    expect(response.status).toBe(200);
  });
});

describe("with API_TOKEN", () => {
  it("keeps the bearer path: any Host with the token, 401 without it", async () => {
    const authorized = { Authorization: `Bearer ${TOKEN}` };
    const ok = await tokened.request("/api/bootstrap", {
      headers: { ...authorized, Host: "jj.internal:8080" },
    });
    expect(ok.status).toBe(200);
    await refused(
      await tokened.request("/api/bootstrap", {
        headers: { Host: "jj.internal:8080" },
      }),
      401,
    );
    await refused(
      await tokened.request("/api/bots", {
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: newBot("NoToken"),
      }),
      401,
    );
    const created = await tokened.request("/api/bots", {
      method: "POST",
      headers: { ...authorized, ...json },
      body: newBot("Tokened"),
    });
    expect(created.status).toBe(201);
    await refused(
      await tokened.request("/api/bots", {
        method: "POST",
        headers: { ...authorized, "Content-Type": "text/plain" },
        body: newBot("Typed"),
      }),
      415,
    );
    await refused(
      await tokened.request("/api/bootstrap", {
        headers: { ...authorized, "Sec-Fetch-Site": "cross-site" },
      }),
      403,
    );
  });
});

describe("a real server without a token", () => {
  let server: RunningServer;
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "jj-guard-"));
    server = await startServer({
      logger: quietLogger,
      env: {
        API_PORT: "0",
        JJ_DATABASE_PATH: "memory://",
        JJ_SANDBOX_DRIVERS: "local",
        JJ_SANDBOX_ROOT: root,
        JJ_EMBED_WORKER: "true",
      },
    });
  }, OPEN_TIMEOUT);
  afterAll(async () => {
    await server?.close();
    if (root) await rm(root, { recursive: true, force: true });
  });

  /** A raw request, so the Host header is exactly what a browser would send. */
  const raw = (host: string, path = "/api/bootstrap") =>
    new Promise<number>((resolve, reject) => {
      const url = new URL(server.url);
      const request = httpRequest(
        {
          host: url.hostname,
          port: url.port,
          path,
          headers: { Host: host },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode ?? 0);
        },
      );
      request.on("error", reject);
      request.end();
    });

  it("answers loopback hosts and refuses a rebound name", async () => {
    const port = new URL(server.url).port;
    expect(await raw(`127.0.0.1:${port}`)).toBe(200);
    expect(await raw(`localhost:${port}`)).toBe(200);
    expect(await raw(`attacker.example:${port}`)).toBe(403);
    expect(await raw(`attacker.example:${port}`, "/health")).toBe(200);
  });
});
