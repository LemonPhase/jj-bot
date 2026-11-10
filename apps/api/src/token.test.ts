// The generated API token: created on the first boot beyond loopback without
// API_TOKEN, kept in the database and reused on later boots, required on
// /api/*, and printed in no line at all: `npm run auth:token` reads it. Each
// boot prints a one-time login link instead, whose code is in the URL
// fragment and appears in that line alone. Loopback without a token stays
// open; a configured API_TOKEN is never printed either.
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Logger } from "@jj/backend";
import { instanceSettings } from "@jj/db";
import { eq, ne } from "drizzle-orm";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { CREDENTIALS_KEY } from "./auth/service";
import { REPO_ROOT } from "./config";
import { type RunningServer, startServer } from "./server";
import { OPEN_TIMEOUT } from "./testing";
import { GENERATED_TOKEN_KEY } from "./token";
import { databasePassword } from "./wiring";

const exec = promisify(execFile);

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

const secretValues = async (server: RunningServer) =>
  (await server.services.secrets()).map((secret) => secret.value);

/** The server's port on 127.0.0.1, whatever address it listens on. */
const local = (server: RunningServer) =>
  `http://127.0.0.1:${new URL(server.url).port}`;

const status = async (url: string, headers: Record<string, string> = {}) =>
  (await fetch(url, { headers })).status;

/** The login link of a boot line: its base and its one-time code. */
const LOGIN_LINE =
  /Open JJ Bot: (http:\/\/127\.0\.0\.1:(\d+))\/#\/login\?code=([A-Za-z0-9_-]+)/;

describe("beyond loopback without API_TOKEN", () => {
  it(
    "generates a token on first boot, requires it, keeps it across restarts, and never prints it",
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
      // A token pasted where it does not belong: a query, a Referer.
      await fetch(`${base}/?token=${token}`);
      await fetch(`${base}/api/nope?token=${token}`, {
        headers: { Referer: `${base}/?token=${token}` },
      });

      // The scheduler's last pass and the credentials' fingerprint are
      // stored there too; the token is the only secret.
      const stored = await server.services.database.db
        .select()
        .from(instanceSettings)
        .where(ne(instanceSettings.key, "scheduler.last_pass_at"));
      expect(
        Object.fromEntries(stored.map((row) => [row.key, row.value])),
      ).toEqual({
        [GENERATED_TOKEN_KEY]: token,
        [CREDENTIALS_KEY]: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(first.lines.filter((line) => line.includes(token))).toEqual([]);
      const opening = first.lines.filter((line) => LOGIN_LINE.test(line));
      expect(opening).toHaveLength(1);
      expect(first.lines.join("\n")).toContain("generated now");
      // The engine redacts it from what runs persist.
      expect(await secretValues(server)).toContain(token);
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
      expect(second.lines.filter((line) => line.includes(token))).toEqual([]);
      expect(
        second.lines.filter((line) =>
          line.includes("Open JJ Bot: http://127.0.0.1:3101/#/login?code="),
        ),
      ).toHaveLength(1);
      expect(second.lines.join("\n")).toContain("generated on first boot");
      expect(await secretValues(again)).toContain(token);
    },
    OPEN_TIMEOUT,
  );

  it(
    "puts the token in no line of the process output, and each login code only in its boot line",
    async () => {
      const database = join(dir, "process-db");
      const childEnv = {
        PATH: process.env.PATH,
        API_HOST: "0.0.0.0",
        API_PORT: "0",
        JJ_DATABASE_PATH: database,
        JJ_SANDBOX_DRIVERS: "local",
        JJ_SANDBOX_ROOT: join(dir, "process-sandbox"),
      };
      let output = "";
      const start = async () => {
        const before = output.length;
        const child = spawn(
          process.execPath,
          ["--import", "tsx", join(REPO_ROOT, "apps/api/src/index.ts")],
          { env: childEnv, stdio: ["ignore", "pipe", "pipe"] },
        );
        child.stdout.on("data", (chunk) => {
          output += chunk;
        });
        child.stderr.on("data", (chunk) => {
          output += chunk;
        });
        const exited = new Promise<number | null>((resolve) =>
          child.once("exit", (code) => resolve(code)),
        );
        // A fresh process transpiles the app and opens its database before
        // it prints anything: like opening a server in-process, only from
        // scratch, so it gets the whole opening budget.
        const deadline = Date.now() + OPEN_TIMEOUT;
        let match: RegExpExecArray | null = null;
        while (!match) {
          match = LOGIN_LINE.exec(output.slice(before));
          if (child.exitCode !== null || Date.now() > deadline) {
            child.kill("SIGKILL");
            throw new Error(`The API did not start:\n${output}`);
          }
          if (!match) await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return {
          child,
          exited,
          base: match[1] as string,
          code: match[3] as string,
        };
      };
      const stop = async (child: ChildProcess, exited: Promise<unknown>) => {
        child.kill("SIGTERM");
        expect(await exited).toBe(0);
      };
      const cli = async (command: string) =>
        (
          await exec(
            process.execPath,
            [
              "--import",
              "tsx",
              join(REPO_ROOT, "apps/api/src/auth-cli.ts"),
              command,
            ],
            { env: childEnv },
          )
        ).stdout.trim();
      const signIn = (base: string, body: unknown) =>
        fetch(`${base}/api/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Origin: base },
          body: JSON.stringify(body),
        });

      // First boot: sign in with the boot line's code, once.
      const first = await start();
      try {
        expect(output).toMatch(/JJ Bot API at http:\/\/0\.0\.0\.0:\d+/);
        expect(await status(`${first.base}/api/bootstrap`)).toBe(401);
        const login = await signIn(first.base, { code: first.code });
        expect(login.status).toBe(200);
        const cookie = (login.headers.get("Set-Cookie") ?? "").split(";")[0];
        expect(cookie).toMatch(/^jj_session=/);
        expect(
          await status(`${first.base}/api/bootstrap`, { Cookie: cookie ?? "" }),
        ).toBe(200);
        expect((await signIn(first.base, { code: first.code })).status).toBe(
          401,
        );
      } finally {
        await stop(first.child, first.exited);
      }

      // Stopped, the CLI reads the token and mints a link; the token is
      // nowhere in what the server printed.
      const token = await cli("token");
      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      const link = await cli("login-link");
      const minted = /#\/login\?code=([A-Za-z0-9_-]+)$/.exec(link)?.[1];
      expect(minted).toBeDefined();

      // Second boot: the token as bearer, in a query and in a Referer; the
      // CLI's code signs in.
      const second = await start();
      try {
        expect(
          await status(`${second.base}/api/bootstrap`, {
            Authorization: `Bearer ${token}`,
          }),
        ).toBe(200);
        await fetch(`${second.base}/?token=${token}`);
        await fetch(`${second.base}/api/nope?token=${token}`, {
          headers: { Referer: `${second.base}/?token=${token}` },
        });
        expect(
          await status(`${second.base}/api/bootstrap`, {
            Authorization: `Bearer ${token}x`,
          }),
        ).toBe(401);
        expect((await signIn(second.base, { token })).status).toBe(200);
        expect((await signIn(second.base, { code: minted })).status).toBe(200);
      } finally {
        await stop(second.child, second.exited);
      }

      expect(output.split(token).length - 1).toBe(0);
      expect(output.split(first.code).length - 1).toBe(1);
      expect(output.split(second.code).length - 1).toBe(1);
      expect(output).not.toContain(minted);
      expect(output.match(/Open JJ Bot: /g)).toHaveLength(2);
    },
    // Two starts, the CLI and the requests.
    3 * OPEN_TIMEOUT,
  );
});

describe("API_TOKEN and loopback", () => {
  it(
    "uses API_TOKEN beyond loopback without generating or printing a token",
    async () => {
      const { lines, logger } = capture();
      const server = await boot(
        {
          API_HOST: "0.0.0.0",
          API_TOKEN: "configured-token-0123456789abcdefghij",
          JJ_DATABASE_PATH: "memory://",
        },
        logger,
      );
      expect(server.auth).toEqual({
        kind: "configured",
        token: "configured-token-0123456789abcdefghij",
      });
      expect(await status(`${local(server)}/api/bootstrap`)).toBe(401);
      expect(
        await status(`${local(server)}/api/bootstrap`, {
          Authorization: "Bearer configured-token-0123456789abcdefghij",
        }),
      ).toBe(200);
      expect(
        await server.services.database.db
          .select()
          .from(instanceSettings)
          .where(eq(instanceSettings.key, GENERATED_TOKEN_KEY)),
      ).toEqual([]);
      expect(lines.join("\n")).not.toContain(
        "configured-token-0123456789abcdefghij",
      );
      expect(
        lines.filter((line) => /Open JJ Bot: .*#\/login\?code=/.test(line)),
      ).toHaveLength(1);
    },
    OPEN_TIMEOUT,
  );

  it(
    "hands the engine API_TOKEN and the provider keys to redact",
    async () => {
      const { lines, logger } = capture();
      const server = await boot(
        {
          API_TOKEN: "short-token1",
          OPENAI_API_KEY: "sk-test-provider-key",
          JJ_DATABASE_PATH: "memory://",
        },
        logger,
      );
      expect(await server.services.secrets()).toEqual([
        { name: "OPENAI_API_KEY", value: "sk-test-provider-key" },
        { name: "API_TOKEN", value: "short-token1" },
      ]);
      // Too short to redact as a bare value: named in a boot warning, never printed.
      const warning = lines.find((line) =>
        line.includes("is not redacted from task history"),
      );
      expect(warning).toContain("API_TOKEN is shorter");
      // Too short for an API beyond loopback: allowed here, with a warning.
      expect(
        lines.filter((line) =>
          line.includes(
            "API_TOKEN is shorter than 32 characters: fine while only this machine reaches the API",
          ),
        ),
      ).toHaveLength(1);
      expect(lines.join("\n")).not.toContain("short-token1");
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
        await server.services.database.db
          .select()
          .from(instanceSettings)
          .where(eq(instanceSettings.key, GENERATED_TOKEN_KEY)),
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
