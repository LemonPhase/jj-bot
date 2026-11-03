// Settings: defaults, listeners beyond loopback, API_PUBLIC_URL, the
// refusal of settings that would expose a tokenless API or send the token
// over plain http, and the PostgreSQL requirement for a separate worker. The
// generated token is in token.test.ts.
import { createServer } from "node:net";
import { join } from "node:path";
import { bootstrapSchema } from "@jj/contracts";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  isLoopbackHost,
  loadServerConfig,
  loadWorkerConfig,
  parseDuration,
  REPO_ROOT,
  redactEndpoint,
  servesWithoutToken,
  stopGraceWarning,
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

describe("redactEndpoint", () => {
  it("masks the user, the password and every query value", () => {
    expect(
      redactEndpoint(
        "https://team:s3cret@collector.example:4318/v1/traces?api_key=k-123&region=eu",
      ),
    ).toBe(
      "https://***:***@collector.example:4318/v1/traces?api_key=***&region=***",
    );
    expect(redactEndpoint("http://collector:4318/v1/traces")).toBe(
      "http://collector:4318/v1/traces",
    );
    expect(redactEndpoint("not a url")).toBe("(unparseable URL)");
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
    // No other process can open PGlite, so no worker heartbeat is written.
    expect(config.engine.workerHeartbeat).toBe(false);
    expect(config.drainTimeoutMs).toBe(20_000);
  });

  it("reads JJ_STOP_GRACE_PERIOD as compose writes durations, and warns when it is too short for the drain", () => {
    expect(parseDuration("45s")).toBe(45_000);
    expect(parseDuration("1m10s")).toBe(70_000);
    expect(parseDuration("1h")).toBe(3_600_000);
    expect(parseDuration("1.5s")).toBe(1_500);
    expect(parseDuration("500ms")).toBe(500);
    for (const value of ["45", "s", "45 s", "-5s", "1m 10s", "1d"])
      expect(parseDuration(value), value).toBeUndefined();
    expect(() => loadServerConfig({ JJ_STOP_GRACE_PERIOD: "45" })).toThrow(
      'JJ_STOP_GRACE_PERIOD must be a duration such as 45s or 1m30s; got "45".',
    );
    expect(loadServerConfig({}).stopGracePeriodMs).toBeUndefined();
    // compose.yaml's defaults: a 20 s drain and 45 s to stop.
    const fits = loadServerConfig({ JJ_STOP_GRACE_PERIOD: "45s" });
    expect(fits.stopGracePeriodMs).toBe(45_000);
    expect(stopGraceWarning(fits)).toBeUndefined();
    expect(stopGraceWarning(loadServerConfig({}))).toBeUndefined();
    expect(
      stopGraceWarning(
        loadServerConfig({
          JJ_DRAIN_TIMEOUT_SEC: "60",
          JJ_STOP_GRACE_PERIOD: "1m",
        }),
      ),
    ).toBe(
      "JJ_STOP_GRACE_PERIOD (60 s) is less than JJ_DRAIN_TIMEOUT_SEC (60 s) plus 25 s: a stop can be killed before it drains and shuts down, and its sessions then resume only once their leases run out. Raise the stop grace period (compose: JJ_STOP_GRACE_PERIOD) or lower JJ_DRAIN_TIMEOUT_SEC.",
    );
    expect(
      stopGraceWarning(
        loadServerConfig({
          JJ_DRAIN_TIMEOUT_SEC: "60",
          JJ_STOP_GRACE_PERIOD: "1m25s",
        }),
      ),
    ).toBeUndefined();
  });

  it("reads JJ_DRAIN_TIMEOUT_SEC in whole seconds, 0 to an hour", () => {
    expect(loadServerConfig({ JJ_DRAIN_TIMEOUT_SEC: "0" }).drainTimeoutMs).toBe(
      0,
    );
    expect(
      loadWorkerConfig({
        DATABASE_URL: "postgresql://localhost/jj",
        JJ_DRAIN_TIMEOUT_SEC: " 90 ",
      }).drainTimeoutMs,
    ).toBe(90_000);
    for (const value of ["-1", "1.5", "3601", "soon"])
      expect(() => loadServerConfig({ JJ_DRAIN_TIMEOUT_SEC: value })).toThrow(
        `JJ_DRAIN_TIMEOUT_SEC must be a whole number of seconds from 0 to 3600; got "${value}".`,
      );
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
      // Another process (an API without a worker) reads its heartbeat.
      engine: { workerHeartbeat: true },
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
      loadServerConfig({
        API_ALLOWED_HOSTS: " jj.example.com, proxy:8443 ,,",
        API_TOKEN: "t",
      }).allowedHosts,
    ).toEqual(["jj.example.com", "proxy:8443"]);
  });

  describe("refuses to expose the API without a token or over plain http", () => {
    const refused = (env: Record<string, string>, message: RegExp) => {
      let error: unknown;
      try {
        loadServerConfig(env);
      } catch (thrown) {
        error = thrown;
      }
      expect(error, JSON.stringify(env)).toBeInstanceOf(ConfigError);
      expect((error as Error).message).toMatch(message);
    };

    it("keeps plain local development: loopback without a token", () => {
      for (const env of [
        {},
        { API_HOST: "localhost" },
        { API_PUBLIC_URL: "http://127.0.0.1:3001" },
        { API_PUBLIC_URL: "http://localhost:5173/" },
        { API_HOST: "[::1]", API_PUBLIC_URL: "http://[::1]:3001" },
      ])
        expect(
          servesWithoutToken(loadServerConfig(env)),
          JSON.stringify(env),
        ).toBe(true);
      // The compose stack: beyond loopback in its container, so a generated
      // token, and opened on the host's loopback.
      const compose = loadServerConfig({
        API_HOST: "0.0.0.0",
        API_PUBLIC_URL: "http://127.0.0.1:3001",
      });
      expect(servesWithoutToken(compose)).toBe(false);
    });

    it("refuses API_ALLOWED_HOSTS on a tokenless loopback API", () => {
      refused(
        { API_ALLOWED_HOSTS: "jj.example.com" },
        /^API_ALLOWED_HOSTS is set, but the API has no token: .*Set API_TOKEN/,
      );
      refused(
        { API_HOST: "::1", API_ALLOWED_HOSTS: "proxy:8443" },
        /^API_ALLOWED_HOSTS is set, but the API has no token/,
      );
      // A token, configured or generated (beyond loopback), protects it.
      expect(
        loadServerConfig({
          API_ALLOWED_HOSTS: "jj.example.com",
          API_TOKEN: "t",
        }).allowedHosts,
      ).toEqual(["jj.example.com"]);
      expect(
        loadServerConfig({
          API_HOST: "0.0.0.0",
          API_ALLOWED_HOSTS: "jj.example.com",
        }).allowedHosts,
      ).toEqual(["jj.example.com"]);
    });

    it("refuses a public URL beyond loopback on a tokenless loopback API, as behind tailscale serve", () => {
      for (const url of [
        "https://jj.tail1234.ts.net",
        "https://jj.example.com/",
        "https://192.168.1.10:8443",
      ])
        refused(
          { API_PUBLIC_URL: url },
          /^API_PUBLIC_URL names "[^"]+", beyond loopback, but the API has no token: .*Set API_TOKEN/,
        );
      expect(
        loadServerConfig({
          API_PUBLIC_URL: "https://jj.tail1234.ts.net",
          API_TOKEN: "t",
        }).publicUrl,
      ).toBe("https://jj.tail1234.ts.net");
      expect(
        loadServerConfig({
          API_HOST: "0.0.0.0",
          API_PUBLIC_URL: "https://jj.example.com",
        }).publicUrl,
      ).toBe("https://jj.example.com");
    });

    it("refuses a plain-http public URL beyond loopback unless JJ_ALLOW_INSECURE_HTTP=true", () => {
      const insecure: Record<string, string>[] = [
        { API_PUBLIC_URL: "http://jj.example.com", API_TOKEN: "t" },
        { API_PUBLIC_URL: "http://192.168.1.10:3001", API_HOST: "0.0.0.0" },
        {
          API_PUBLIC_URL: "http://jj.lan",
          API_TOKEN: "t",
          JJ_ALLOW_INSECURE_HTTP: "false",
        },
      ];
      for (const env of insecure)
        refused(
          env,
          /^API_PUBLIC_URL is plain http beyond loopback \("[^"]+"\), so the token would cross the network in the clear\..*JJ_ALLOW_INSECURE_HTTP=true/,
        );
      expect(
        loadServerConfig({
          API_PUBLIC_URL: "http://jj.lan:3001",
          API_TOKEN: "t",
          JJ_ALLOW_INSECURE_HTTP: "true",
        }).publicUrl,
      ).toBe("http://jj.lan:3001");
      // The opt-in never stands in for a token.
      refused(
        { API_PUBLIC_URL: "http://jj.lan", JJ_ALLOW_INSECURE_HTTP: "true" },
        /^API_PUBLIC_URL names "jj.lan", beyond loopback, but the API has no token/,
      );
      refused({ JJ_ALLOW_INSECURE_HTTP: "maybe" }, /JJ_ALLOW_INSECURE_HTTP/);
    });
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
    expect(() => loadServerConfig({ JJ_LOG_LEVEL: "trace" })).toThrow(
      /JJ_LOG_LEVEL must be one of debug, info, warn, error/,
    );
    expect(() =>
      loadWorkerConfig({
        DATABASE_URL: "postgresql://localhost/jj",
        JJ_LOG_FORMAT: "logfmt",
      }),
    ).toThrow(ConfigError);
    expect(loadServerConfig({ JJ_LOG_FORMAT: "pretty" }).log).toEqual({
      level: "info",
      format: "pretty",
    });
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

  it("reads JJ_MAX_USD_PER_DAY, refusing what no cap can be", () => {
    expect(loadServerConfig({}).engine.maxUsdPerDay).toBeUndefined();
    expect(
      loadServerConfig({ JJ_MAX_USD_PER_DAY: "12.5" }).engine.maxUsdPerDay,
    ).toBe(12.5);
    for (const value of ["0", "-1", "abc", "10001"])
      expect(() => loadServerConfig({ JJ_MAX_USD_PER_DAY: value })).toThrow(
        /JJ_MAX_USD_PER_DAY must be a positive number of US dollars, at most 10000/,
      );
  });

  it("passes a valid egress subnet pool to the docker driver, and none by default", () => {
    expect(loadServerConfig({}).dockerEgressSubnetPool).toBeUndefined();
    expect(
      loadServerConfig({ JJ_DOCKER_EGRESS_SUBNET_POOL: " 172.29.0.0/20 " })
        .dockerEgressSubnetPool,
    ).toBe("172.29.0.0/20");
  });

  it("reads JJ_MCP_REMOTE, on unless set off, refusing anything else", () => {
    expect(loadServerConfig({}).mcpRemote).toBe(true);
    expect(loadServerConfig({ JJ_MCP_REMOTE: "on" }).mcpRemote).toBe(true);
    expect(loadServerConfig({ JJ_MCP_REMOTE: " OFF " }).mcpRemote).toBe(false);
    expect(() => loadServerConfig({ JJ_MCP_REMOTE: "no" })).toThrow(
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

describe("JJ_DEFAULT_MODEL", () => {
  it("warns at boot when the stop grace period is too short for the drain", async () => {
    const warnings: string[] = [];
    const server = await startServer({
      logger: { ...quietLogger, warn: (message) => warnings.push(message) },
      env: {
        API_PORT: "0",
        JJ_DATABASE_PATH: "memory://",
        JJ_SANDBOX_DRIVERS: "local",
        JJ_DRAIN_TIMEOUT_SEC: "30",
        JJ_STOP_GRACE_PERIOD: "45s",
      },
    });
    try {
      expect(
        warnings.filter((line) => line.startsWith("JJ_STOP_GRACE_PERIOD")),
      ).toEqual([
        "JJ_STOP_GRACE_PERIOD (45 s) is less than JJ_DRAIN_TIMEOUT_SEC (30 s) plus 25 s: a stop can be killed before it drains and shuts down, and its sessions then resume only once their leases run out. Raise the stop grace period (compose: JJ_STOP_GRACE_PERIOD) or lower JJ_DRAIN_TIMEOUT_SEC.",
      ]);
    } finally {
      await server.close();
    }
  });

  it("warns at boot when it is not used, and bootstrap reports the default in use", async () => {
    const warnings: string[] = [];
    const server = await startServer({
      logger: { ...quietLogger, warn: (message) => warnings.push(message) },
      env: {
        API_PORT: "0",
        JJ_DATABASE_PATH: "memory://",
        JJ_SANDBOX_DRIVERS: "local",
        OPENAI_API_KEY: "sk-test",
        MISTRAL_API_KEY: "test",
        // Not in pi's catalog.
        JJ_DEFAULT_MODEL: "mistral/mistral-nemo",
      },
    });
    try {
      // The engine's own boot warnings (these keys are too short to redact)
      // go to the same logger.
      const tooShort = (line: string) =>
        /^(OPENAI|MISTRAL)_API_KEY is shorter than 16 characters/.test(line);
      expect(warnings.filter((line) => !tooShort(line))).toEqual([
        'JJ_DEFAULT_MODEL "mistral/mistral-nemo" is not used: Unknown model "mistral/mistral-nemo". Bots without a model use openai/gpt-6-luna instead.',
      ]);
      expect(warnings.filter(tooShort)).toHaveLength(2);
      const bootstrap = bootstrapSchema.parse(
        await (await fetch(`${server.url}/api/bootstrap`)).json(),
      );
      expect(bootstrap.defaultModel).toBe("openai/gpt-6-luna");
    } finally {
      await server.close();
    }
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
