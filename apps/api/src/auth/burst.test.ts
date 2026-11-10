// Parallel sign-in bursts: password guesses sent all at once get no more
// scrypt checks than the limits allow (5 per client, at most 2 at a time),
// cannot push the password lock up its doubling in one go, and leave the
// threadpool free, so the server keeps answering everything else.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { authLoginCodes, authSessions } from "@jj/db";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createApp, type JJApp } from "../app";
import { OPEN_TIMEOUT, quietLogger, type TestApp, testApp } from "../testing";
import { parseTrustedProxies } from "./clients";
import {
  LOGIN_FAILURES_PER_CLIENT,
  MAX_PASSWORD_CHECKS,
  PASSWORD_LOCK_MS,
} from "./limits";
import { hashPassword, parsePasswordHash } from "./password";

/** Every scrypt check the server runs, and how many run at once. */
const checks = vi.hoisted(() => ({ started: 0, running: 0, peak: 0 }));
vi.mock("./password", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./password")>();
  return {
    ...actual,
    verifyPassword: async (
      ...args: Parameters<typeof actual.verifyPassword>
    ) => {
      checks.started += 1;
      checks.running += 1;
      checks.peak = Math.max(checks.peak, checks.running);
      try {
        return await actual.verifyPassword(...args);
      } finally {
        checks.running -= 1;
      }
    },
  };
});

const TOKEN = "burst-test-token-0123456789abcdefghijklmnop";
const PASSWORD = "correct horse battery staple";
const ORIGIN = "http://127.0.0.1:3001";

let t: TestApp;
let password: { hash: ReturnType<typeof parsePasswordHash>; text: string };

beforeAll(async () => {
  t = await testApp({ startWorker: false });
  const text = await hashPassword(PASSWORD);
  password = { hash: parsePasswordHash(text), text };
}, OPEN_TIMEOUT);
afterAll(async () => {
  await t?.dispose();
});
beforeEach(async () => {
  Object.assign(checks, { started: 0, running: 0, peak: 0 });
  await t.database.db.delete(authSessions);
  await t.database.db.delete(authLoginCodes);
});

function app(webDist?: string): JJApp {
  return createApp({
    engine: t.engine,
    logger: quietLogger,
    config: {
      workerEmbedded: false,
      apiToken: TOKEN,
      ...(webDist ? { webDist } : {}),
      auth: { password, trustedProxies: parseTrustedProxies("loopback") },
    },
  });
}

/** A password sign-in from `client`, as a proxy on loopback forwards it. */
const guess = (target: JJApp, client: string, value = "not the password") =>
  target.request(
    `${ORIGIN}/api/auth/login`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: ORIGIN,
        "X-Forwarded-For": client,
      },
      body: JSON.stringify({ password: value }),
    },
    { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
  );

const statuses = (responses: Response[]) =>
  responses.reduce<Record<number, number>>((counts, response) => {
    counts[response.status] = (counts[response.status] ?? 0) + 1;
    return counts;
  }, {});

describe("a burst of password guesses", () => {
  it("from one client gets 5 checks at most, 2 at a time, and 429 for the rest", async () => {
    const target = app();
    const responses = await Promise.all(
      Array.from({ length: 300 }, () => guess(target, "198.51.100.7")),
    );
    const counted = statuses(responses);
    expect(checks.started).toBeLessThanOrEqual(LOGIN_FAILURES_PER_CLIENT);
    expect(checks.peak).toBeLessThanOrEqual(MAX_PASSWORD_CHECKS);
    expect(counted[401]).toBe(checks.started);
    expect(counted[429]).toBe(300 - checks.started);
    // Settled, the client's guesses one by one reach its limit, not more.
    let last = 401;
    for (let attempt = 0; attempt < 10 && last === 401; attempt += 1)
      last = (await guess(target, "198.51.100.7")).status;
    expect(last).toBe(429);
    expect(checks.started).toBe(LOGIN_FAILURES_PER_CLIENT);
    // Over its limit, even the right password is not checked.
    expect((await guess(target, "198.51.100.7", PASSWORD)).status).toBe(429);
    expect(checks.started).toBe(LOGIN_FAILURES_PER_CLIENT);
    // The token still signs the owner in from there.
    const token = await target.request(
      `${ORIGIN}/api/auth/login`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: ORIGIN,
          "X-Forwarded-For": "198.51.100.7",
        },
        body: JSON.stringify({ token: TOKEN }),
      },
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
    );
    expect(token.status).toBe(200);
  });

  it("from many clients cannot push the password lock up its doubling in one go", async () => {
    const target = app();
    const lines = quietLogger.lines.length;
    const responses = await Promise.all(
      Array.from({ length: 600 }, (_, index) =>
        guess(target, `203.0.113.${index % 200}`),
      ),
    );
    expect(checks.peak).toBeLessThanOrEqual(MAX_PASSWORD_CHECKS);
    expect(statuses(responses)[401] ?? 0).toBe(checks.started);
    // At most one lock, of the first length, whatever the burst's size.
    expect(target.auth.limits.passwordLockMs()).toBeLessThanOrEqual(
      PASSWORD_LOCK_MS,
    );
    const locks = quietLogger.lines
      .slice(lines)
      .filter((line) => line.message.startsWith("Password sign-in is locked"));
    expect(locks.length).toBeLessThanOrEqual(1);
  });
});

describe("while a burst runs", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "jj-burst-web-"));
    await writeFile(
      join(dir, "index.html"),
      '<!doctype html><div id="root"></div>',
    );
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("the server still answers a static page at once: scrypt does not fill the threadpool", async () => {
    const target = app(dir);
    // 600 guesses from 250 clients, all in flight before the page load.
    const burst = Promise.all(
      Array.from({ length: 600 }, (_, index) =>
        guess(target, `192.0.2.${index % 250}`),
      ),
    );
    while (checks.running === 0)
      await new Promise((resolve) => setTimeout(resolve, 1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Serving the page reads a file, on the threadpool scrypt runs on.
    const started = performance.now();
    const page = await target.request(`${ORIGIN}/`);
    const html = await page.text();
    const pageMs = performance.now() - started;
    expect(page.status).toBe(200);
    expect(html).toContain('<div id="root">');
    expect(pageMs).toBeLessThan(1_000);
    await burst;
    expect(checks.peak).toBeLessThanOrEqual(MAX_PASSWORD_CHECKS);
  }, 60_000);
});
