// The generated API token: created on the first boot beyond loopback without
// API_TOKEN, kept in the database and reused on later boots, required on
// /api/*, and printed only in the one "Open JJ Bot" line. Loopback without a
// token and a configured API_TOKEN are unchanged.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@jj/backend";
import { instanceSettings } from "@jj/db";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { REPO_ROOT } from "./config";
import { type RunningServer, startServer } from "./server";
import { OPEN_TIMEOUT } from "./testing";
import { GENERATED_TOKEN_KEY } from "./token";
import { databasePassword } from "./wiring";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "jj-token-test-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Every line the server and the engine log, the console included. */
function capture() {
  const lines: string[] = [];
  const line = (message: string, details?: unknown) =>
    lines.push(
      details === undefined ? message : `${message} ${JSON.stringify(details)}`,
    );
  const logger: Logger = { info: line, warn: line, error: line };
  const record = (...args: unknown[]) => {
    lines.push(args.map((arg) => String(arg)).join(" "));
  };
  for (const level of ["log", "info", "warn", "error"] as const)
    vi.spyOn(console, level).mockImplementation(record);
  return { lines, logger };
}

const servers: RunningServer[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  vi.restoreAllMocks();
});

async function boot(env: Record<string, string>, logger: Logger) {
  const server = await startServer({
    logger,
    env: {
      API_PORT: "0",
      JJ_SANDBOX_DRIVERS: "local",
      JJ_SANDBOX_ROOT: join(dir, "sandbox"),
      ...env,
    },
  });
  servers.push(server);
  return server;
}

/** The server's port on 127.0.0.1, whatever address it listens on. */
const local = (server: RunningServer) =>
  `http://127.0.0.1:${new URL(server.url).port}`;

const status = async (url: string, headers: Record<string, string> = {}) =>
  (await fetch(url, { headers })).status;

describe("beyond loopback without API_TOKEN", () => {
  it(
    "generates a token on first boot, requires it, and keeps it across restarts",
    async () => {
      const env = { API_HOST: "0.0.0.0", JJ_DATABASE_PATH: join(dir, "db") };
      const first = capture();
      const server = await boot(env, first.logger);
      expect(server.auth.kind).toBe("generated");
      if (server.auth.kind !== "generated") return;
      const token = server.auth.token;
      expect(server.auth.created).toBe(true);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);

      const base = local(server);
      expect(await status(`${base}/api/bootstrap`)).toBe(401);
      expect(
        await status(`${base}/api/bootstrap`, {
          Authorization: "Bearer wrong",
        }),
      ).toBe(401);
      expect(
        await status(`${base}/api/bootstrap`, {
          Authorization: `Bearer ${token}`,
        }),
      ).toBe(200);
      expect(await status(`${base}/health`)).toBe(200);
      // The page a user opens with the token, and a failing request.
      await fetch(`${base}/?token=${token}`);
      await fetch(`${base}/api/nope?token=${token}`);

      const stored = await server.services.database.db
        .select()
        .from(instanceSettings);
      expect(stored.map((row) => [row.key, row.value])).toEqual([
        [GENERATED_TOKEN_KEY, token],
      ]);
      const carrying = first.lines.filter((line) => line.includes(token));
      expect(carrying).toEqual([
        `Open JJ Bot: http://127.0.0.1:${new URL(server.url).port}/?token=${token}`,
      ]);
      expect(first.lines.join("\n")).toContain("generated now");
      // The engine redacts it from what runs persist.
      expect(server.services.secrets.has(token)).toBe(true);
      await server.close();
      servers.length = 0;
      vi.restoreAllMocks();

      // A restart on the same database reuses it.
      const second = capture();
      const again = await boot(
        { ...env, API_PUBLIC_URL: "http://127.0.0.1:3101/" },
        second.logger,
      );
      expect(again.auth).toEqual({ kind: "generated", token, created: false });
      expect(
        await status(`${local(again)}/api/bootstrap`, {
          Authorization: `Bearer ${token}`,
        }),
      ).toBe(200);
      expect(await status(`${local(again)}/api/bootstrap`)).toBe(401);
      expect(second.lines.filter((line) => line.includes(token))).toEqual([
        `Open JJ Bot: http://127.0.0.1:3101/?token=${token}`,
      ]);
      expect(second.lines.join("\n")).toContain("generated on first boot");
      expect(again.services.secrets.has(token)).toBe(true);
    },
    OPEN_TIMEOUT,
  );

  it(
    "prints the token in exactly one line of the whole process output",
    async () => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", join(REPO_ROOT, "apps/api/src/index.ts")],
        {
          env: {
            PATH: process.env.PATH,
            API_HOST: "0.0.0.0",
            API_PORT: "0",
            JJ_DATABASE_PATH: "memory://",
            JJ_SANDBOX_DRIVERS: "local",
            JJ_SANDBOX_ROOT: join(dir, "process-sandbox"),
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
      let token = "";
      try {
        const deadline = Date.now() + 30_000;
        let match: RegExpExecArray | null = null;
        while (!match) {
          match =
            /Open JJ Bot: (http:\/\/127\.0\.0\.1:(\d+))\/\?token=(\S+)/.exec(
              output,
            );
          if (child.exitCode !== null || Date.now() > deadline)
            throw new Error(`The API did not start:\n${output}`);
          if (!match) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        const base = match[1] as string;
        token = match[3] as string;
        expect(output).toMatch(/JJ Bot API at http:\/\/0\.0\.0\.0:\d+/);
        expect(await status(`${base}/api/bootstrap`)).toBe(401);
        expect(
          await status(`${base}/api/bootstrap`, {
            Authorization: `Bearer ${token}`,
          }),
        ).toBe(200);
        await fetch(`${base}/?token=${token}`);
      } finally {
        child.kill("SIGTERM");
      }
      expect(await exited).toBe(0);
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(output.split(token).length - 1).toBe(1);
    },
    OPEN_TIMEOUT,
  );
});

describe("API_TOKEN and loopback", () => {
  it(
    "uses API_TOKEN beyond loopback without generating or printing one",
    async () => {
      const { lines, logger } = capture();
      const server = await boot(
        {
          API_HOST: "0.0.0.0",
          API_TOKEN: "configured-token",
          JJ_DATABASE_PATH: "memory://",
        },
        logger,
      );
      expect(server.auth).toEqual({
        kind: "configured",
        token: "configured-token",
      });
      expect(await status(`${local(server)}/api/bootstrap`)).toBe(401);
      expect(
        await status(`${local(server)}/api/bootstrap`, {
          Authorization: "Bearer configured-token",
        }),
      ).toBe(200);
      expect(
        await server.services.database.db.select().from(instanceSettings),
      ).toEqual([]);
      expect(lines.join("\n")).not.toContain("configured-token");
      expect(lines.join("\n")).not.toContain("Open JJ Bot");
    },
    OPEN_TIMEOUT,
  );

  it(
    "hands the engine API_TOKEN and the provider keys to redact",
    async () => {
      const { logger } = capture();
      const server = await boot(
        {
          API_TOKEN: "configured-token",
          OPENAI_API_KEY: "sk-test-provider-key",
          JJ_DATABASE_PATH: "memory://",
        },
        logger,
      );
      expect([...server.services.secrets].sort()).toEqual([
        "configured-token",
        "sk-test-provider-key",
      ]);
    },
    OPEN_TIMEOUT,
  );

  it(
    "keeps loopback without a token unauthenticated, behind the Host check",
    async () => {
      const { lines, logger } = capture();
      const server = await boot({ JJ_DATABASE_PATH: "memory://" }, logger);
      expect(server.auth).toEqual({ kind: "none" });
      expect(await status(`${server.url}/api/bootstrap`)).toBe(200);
      const rebound = await server.app.request(
        "http://evil.example/api/bootstrap",
      );
      expect(rebound.status).toBe(403);
      expect(
        await server.services.database.db.select().from(instanceSettings),
      ).toEqual([]);
      expect(lines.join("\n")).toContain("auth none (loopback only)");
      expect(lines.join("\n")).not.toContain("Open JJ Bot");
    },
    OPEN_TIMEOUT,
  );
});

describe("databasePassword", () => {
  it("returns the password as written and decoded, or nothing", () => {
    expect(databasePassword("postgresql://jj:p%40ss-word@db:5432/jj")).toEqual([
      "p%40ss-word",
      "p@ss-word",
    ]);
    expect(databasePassword("postgresql://jj:jj_local@db/jj")).toEqual([
      "jj_local",
    ]);
    expect(databasePassword("postgresql://jj@db/jj")).toEqual([]);
    expect(databasePassword("not a url")).toEqual([]);
  });
});
