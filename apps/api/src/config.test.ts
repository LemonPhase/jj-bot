// Settings: defaults, the loopback-without-token refusal (in the loader and
// as a real process exit), and the PostgreSQL requirement for a separate worker.
import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  isLoopbackHost,
  loadServerConfig,
  loadWorkerConfig,
  REPO_ROOT,
} from "./config";

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
      localRoot: join(REPO_ROOT, ".jj-data", "sandbox"),
      dockerNamespace: "jj-sandbox",
      enableScripted: false,
    });
    expect(config.apiToken).toBeUndefined();
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

  it("reports an in-memory database as not persistent", () => {
    const config = loadServerConfig({ JJ_DATABASE_PATH: "memory://" });
    expect(config.database).toEqual({ mode: "pglite", path: "memory://" });
    expect(config.engine.persistence).toBe(false);
  });

  it("refuses to listen beyond loopback without API_TOKEN", () => {
    for (const host of ["0.0.0.0", "::", "192.168.1.10"])
      expect(() => loadServerConfig({ API_HOST: host })).toThrow(
        /API_TOKEN is required/,
      );
    expect(
      loadServerConfig({ API_HOST: "0.0.0.0", API_TOKEN: "t" }),
    ).toMatchObject({ host: "0.0.0.0", apiToken: "t" });
  });

  it("listens beyond loopback without a token only on the explicit API_ALLOW_UNAUTHENTICATED opt-in", () => {
    expect(loadServerConfig({}).allowUnauthenticated).toBe(false);
    for (const value of ["false", "0", ""])
      expect(() =>
        loadServerConfig({
          API_HOST: "0.0.0.0",
          API_ALLOW_UNAUTHENTICATED: value,
        }),
      ).toThrow(/API_TOKEN is required/);
    expect(() =>
      loadServerConfig({
        API_HOST: "0.0.0.0",
        API_ALLOW_UNAUTHENTICATED: "yes",
      }),
    ).toThrow(/API_ALLOW_UNAUTHENTICATED must be true or false/);
    const open = loadServerConfig({
      API_HOST: "0.0.0.0",
      API_ALLOW_UNAUTHENTICATED: "true",
    });
    expect(open).toMatchObject({ host: "0.0.0.0", allowUnauthenticated: true });
    expect(open.apiToken).toBeUndefined();
    // A token still applies when set alongside the opt-in.
    expect(
      loadServerConfig({
        API_HOST: "0.0.0.0",
        API_TOKEN: "t",
        API_ALLOW_UNAUTHENTICATED: "true",
      }).apiToken,
    ).toBe("t");
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

describe("the API process", () => {
  it("exits with a clear message instead of listening beyond loopback without a token", () => {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", join(REPO_ROOT, "apps/api/src/index.ts")],
      {
        env: {
          PATH: process.env.PATH,
          API_HOST: "0.0.0.0",
          API_PORT: "0",
          JJ_DATABASE_PATH: "memory://",
        },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("API_HOST=0.0.0.0");
    expect(result.stderr).toContain("API_TOKEN is required");
    expect(result.stdout).not.toContain("listening");
  });

  it("listens beyond loopback without a token on API_ALLOW_UNAUTHENTICATED=true, and says so", async () => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", join(REPO_ROOT, "apps/api/src/index.ts")],
      {
        env: {
          PATH: process.env.PATH,
          API_HOST: "0.0.0.0",
          API_PORT: "0",
          API_ALLOW_UNAUTHENTICATED: "true",
          JJ_DATABASE_PATH: "memory://",
          JJ_SANDBOX_DRIVERS: "local",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const exited = new Promise<number | null>((resolve) =>
      child.once("exit", (code) => resolve(code)),
    );
    try {
      const deadline = Date.now() + 30_000;
      while (!/JJ Bot API at /.test(output)) {
        if (child.exitCode !== null || Date.now() > deadline)
          throw new Error(`The API did not start:\n${output}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      const url = /JJ Bot API at (http:\/\/\S+)/.exec(output)?.[1] ?? "";
      expect(url).toMatch(/^http:\/\/0\.0\.0\.0:\d+$/);
      expect(output).toContain("auth none (API_ALLOW_UNAUTHENTICATED");
      const port = new URL(url).port;
      const response = await fetch(`http://127.0.0.1:${port}/api/bootstrap`);
      expect(response.status).toBe(200);
    } finally {
      child.kill("SIGTERM");
    }
    expect(await exited).toBe(0);
  });
});
