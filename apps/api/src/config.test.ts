// Settings: defaults, listeners beyond loopback, API_PUBLIC_URL, and the
// PostgreSQL requirement for a separate worker. The generated token is in
// token.test.ts.
import { createServer } from "node:net";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  isLoopbackHost,
  loadServerConfig,
  loadWorkerConfig,
  REPO_ROOT,
} from "./config";
import { startServer } from "./server";
import { quietLogger } from "./testing";

describe("isLoopbackHost", () => {
  it("accepts only loopback addresses", () => {
    for (const host of [
      "127.0.0.1",
      "127.1.2.3",
      "localhost",
      "::1",
      "[::1]",
      "::ffff:127.0.0.1",
    ])
      expect(isLoopbackHost(host), host).toBe(true);
    for (const host of [
      "0.0.0.0",
      "::",
      "192.168.1.10",
      "10.0.0.1",
      "example.com",
      "127.0.0.1.example.com",
      "128.0.0.1",
    ])
      expect(isLoopbackHost(host), host).toBe(false);
  });
});

describe("loadServerConfig", () => {
  it("defaults to loopback, port 3001, PGlite at .jj-data and an embedded worker", () => {
    const config = loadServerConfig({});
    expect(config).toMatchObject({
      host: "127.0.0.1",
      port: 3001,
      embedWorker: true,
      database: { mode: "pglite", path: join(REPO_ROOT, ".jj-data") },
      drivers: ["docker", "local"],
      dockerNamespace: "jj-sandbox",
      enableScripted: false,
    });
    expect(config.apiToken).toBeUndefined();
    // The local driver's own default, outside the repository.
    expect(config.localRoot).toBeUndefined();
    expect(config.engine.persistence).toBe(true);
  });

  it("uses PostgreSQL when DATABASE_URL is set", () => {
    const config = loadServerConfig({
      DATABASE_URL: "postgresql://jj:pw@db:5432/jj",
      JJ_EMBED_WORKER: "false",
      JJ_SANDBOX_DRIVERS: "local",
      JJ_SANDBOX_ROOT: "/srv/jj/workspaces",
    });
    expect(config).toMatchObject({
      database: {
        mode: "postgres",
        connectionString: "postgresql://jj:pw@db:5432/jj",
      },
      embedWorker: false,
      drivers: ["local"],
      localRoot: "/srv/jj/workspaces",
    });
  });

  it("reports an in-memory database as not persistent, and PostgreSQL as persistent", () => {
    const config = loadServerConfig({ JJ_DATABASE_PATH: "memory://" });
    expect(config.database).toEqual({ mode: "pglite", path: "memory://" });
    expect(config.engine.persistence).toBe(false);
    expect(
      loadServerConfig({
        DATABASE_URL: "postgresql://localhost/jj",
        JJ_DATABASE_PATH: "memory://",
      }).engine.persistence,
    ).toBe(true);
  });

  it("listens beyond loopback with or without API_TOKEN", () => {
    // Without one, the server generates a token at boot (token.test.ts).
    for (const host of ["0.0.0.0", "::", "192.168.1.10"])
      expect(loadServerConfig({ API_HOST: host }).apiToken).toBeUndefined();
    expect(
      loadServerConfig({ API_HOST: "0.0.0.0", API_TOKEN: "t" }),
    ).toMatchObject({ host: "0.0.0.0", apiToken: "t" });
  });

  it("reads API_PUBLIC_URL without its trailing slash, and refuses a malformed one", () => {
    expect(loadServerConfig({}).publicUrl).toBeUndefined();
    expect(
      loadServerConfig({ API_PUBLIC_URL: "http://127.0.0.1:3101/" }).publicUrl,
    ).toBe("http://127.0.0.1:3101");
    for (const value of ["127.0.0.1:3001", "ftp://host", "http://h/?a=1"])
      expect(() => loadServerConfig({ API_PUBLIC_URL: value })).toThrow(
        /API_PUBLIC_URL/,
      );
  });

  it("listens on [::1] without the brackets, and reads API_ALLOWED_HOSTS", () => {
    expect(loadServerConfig({ API_HOST: "[::1]" }).host).toBe("::1");
    expect(loadServerConfig({}).allowedHosts).toEqual([]);
    expect(
      loadServerConfig({ API_ALLOWED_HOSTS: " jj.example.com, proxy:8443 ,," })
        .allowedHosts,
    ).toEqual(["jj.example.com", "proxy:8443"]);
  });

  it("refuses a separate worker on PGlite, and malformed settings", () => {
    expect(() => loadServerConfig({ JJ_EMBED_WORKER: "false" })).toThrow(
      /needs PostgreSQL/,
    );
    expect(() => loadServerConfig({ API_PORT: "70000" })).toThrow(ConfigError);
    expect(() => loadServerConfig({ JJ_EMBED_WORKER: "maybe" })).toThrow(
      ConfigError,
    );
    expect(() => loadServerConfig({ JJ_SANDBOX_DRIVERS: "daytona" })).toThrow(
      /JJ_SANDBOX_DRIVERS/,
    );
    expect(() => loadServerConfig({ JJ_CONCURRENCY: "0" })).toThrow(
      ConfigError,
    );
    for (const pool of [
      "10.213.0.0",
      "10.213.0.1/16",
      "8.8.0.0/16",
      "10.0.0.0/29",
    ])
      expect(() =>
        loadServerConfig({ JJ_DOCKER_EGRESS_SUBNET_POOL: pool }),
      ).toThrow(/JJ_DOCKER_EGRESS_SUBNET_POOL/);
  });

  it("passes a valid egress subnet pool to the docker driver, and none by default", () => {
    expect(loadServerConfig({}).dockerEgressSubnetPool).toBeUndefined();
    expect(
      loadServerConfig({ JJ_DOCKER_EGRESS_SUBNET_POOL: " 172.29.0.0/20 " })
        .dockerEgressSubnetPool,
    ).toBe("172.29.0.0/20");
  });
});

describe("loadWorkerConfig", () => {
  it("requires DATABASE_URL", () => {
    expect(() => loadWorkerConfig({})).toThrow(/needs PostgreSQL/);
    expect(
      loadWorkerConfig({ DATABASE_URL: "postgresql://localhost/jj" }).database
        .mode,
    ).toBe("postgres");
  });
});

const ipv6Loopback = await new Promise<boolean>((resolve) => {
  const probe = createServer()
    .once("error", () => resolve(false))
    .listen(0, "::1", () => probe.close(() => resolve(true)));
});

describe.skipIf(!ipv6Loopback)("API_HOST=[::1]", () => {
  it("listens on the IPv6 loopback", async () => {
    const server = await startServer({
      logger: quietLogger,
      env: {
        API_HOST: "[::1]",
        API_PORT: "0",
        JJ_DATABASE_PATH: "memory://",
        JJ_SANDBOX_DRIVERS: "local",
      },
    });
    try {
      expect(server.url).toMatch(/^http:\/\/\[::1\]:\d+$/);
      expect((await fetch(`${server.url}/health`)).status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
