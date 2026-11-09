// Signing in (contract 1.14.0): the guards on /api and /metrics, the cookie
// and its flags, Origin on cookie writes, sign-in with the token, a password
// or a one-time code, expiry on an injected clock, the rate limits and the
// password lock, the device list, signing out and token rotation, which end
// the affected event streams.
import {
  apiErrorSchema,
  authSessionListSchema,
  authStateSchema,
  loginResultSchema,
} from "@jj/contracts";
import { authLoginCodes, authSessions, instanceSettings } from "@jj/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AuthSettings, createApp, type JJApp } from "../app";
import {
  OPEN_TIMEOUT,
  quietLogger,
  SseReader,
  type TestApp,
  testApp,
} from "../testing";
import { GENERATED_TOKEN_KEY } from "../token";
import { parseTrustedProxies } from "./clients";
import { hashPassword, parsePasswordHash } from "./password";
import { SIGN_IN_FAILED } from "./service";
import {
  LAST_SEEN_WRITE_MS,
  LOGIN_CODE_MS,
  SESSION_ABSOLUTE_MS,
  SESSION_IDLE_MS,
} from "./store";

const TOKEN = "login-test-token-0123456789abcdefghijklmnop";
const PASSWORD = "correct horse battery staple";
const ORIGIN = "http://127.0.0.1:3001";
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let t: TestApp;
let password: { hash: ReturnType<typeof parsePasswordHash>; text: string };
const clock = { now: Date.parse("2026-11-09T10:00:00.000Z") };

beforeAll(async () => {
  t = await testApp({ startWorker: false });
  const text = await hashPassword(PASSWORD);
  password = { hash: parsePasswordHash(text), text };
}, OPEN_TIMEOUT);
afterAll(async () => {
  await t?.dispose();
});
beforeEach(async () => {
  clock.now = Date.parse("2026-11-09T10:00:00.000Z");
  await t.database.db.delete(authSessions);
  await t.database.db.delete(authLoginCodes);
});

/**
 * An app on the shared engine, with fresh rate limits. Stream heartbeats,
 * which recheck a stream's credential, are a minute apart unless a test sets
 * them shorter, so a stream that ends within seconds was ended at once.
 */
function app(
  settings: AuthSettings = {},
  apiToken: string | null = TOKEN,
  heartbeatMs = 60_000,
) {
  return createApp({
    engine: t.engine,
    logger: quietLogger,
    config: {
      workerEmbedded: false,
      heartbeatMs,
      ...(apiToken ? { apiToken } : {}),
      auth: { password, now: () => clock.now, ...settings },
    },
  });
}

interface Call {
  body?: unknown;
  cookie?: string;
  bearer?: string;
  origin?: string;
  /** The socket's peer address. */
  client?: string;
  headers?: Record<string, string>;
}

function call(target: JJApp, method: string, path: string, options: Call = {}) {
  const headers: Record<string, string> = { ...options.headers };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  else if (["POST", "PUT", "PATCH"].includes(method))
    headers["Content-Type"] = "application/json";
  if (options.cookie) headers.Cookie = options.cookie;
  if (options.bearer) headers.Authorization = `Bearer ${options.bearer}`;
  if (options.origin) headers.Origin = options.origin;
  return target.request(
    `${ORIGIN}${path}`,
    {
      method,
      headers,
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    },
    { incoming: { socket: { remoteAddress: options.client ?? "192.0.2.1" } } },
  );
}

/** `name=value` of the response's session cookie, and its attributes. */
function setCookie(response: Response) {
  const header = response.headers.get("Set-Cookie") ?? "";
  const [pair = "", ...attributes] = header
    .split(";")
    .map((part) => part.trim());
  return { header, pair, attributes };
}

async function signIn(
  target: JJApp,
  credential: Record<string, string> = { token: TOKEN },
  options: Call = {},
) {
  const response = await call(target, "POST", "/api/auth/login", {
    origin: ORIGIN,
    body: credential,
    ...options,
  });
  expect(response.status).toBe(200);
  const { session } = loginResultSchema.parse(await response.json());
  return { cookie: setCookie(response).pair, session, response };
}

const errorOf = async (response: Response) =>
  apiErrorSchema.parse(await response.json()).error;

describe("without a token", () => {
  it("needs no sign-in on loopback, and refuses one", async () => {
    const open = app({}, null);
    const state = authStateSchema.parse(
      await (await call(open, "GET", "/api/auth/session")).json(),
    );
    expect(state).toEqual({
      required: false,
      authenticated: true,
      via: "none",
      methods: { token: false, password: false, passkey: false },
      session: null,
    });
    expect((await call(open, "GET", "/api/bootstrap")).status).toBe(200);
    const login = await call(open, "POST", "/api/auth/login", {
      origin: ORIGIN,
      body: { token: "anything" },
    });
    expect(login.status).toBe(409);
    expect(
      (
        await call(open, "POST", "/api/auth/token", {
          body: { current: { token: "x" } },
        })
      ).status,
    ).toBe(409);
  });
});

describe("the guards", () => {
  it("refuses every route but the session and login ones without credentials", async () => {
    const guarded = app();
    for (const [method, path] of [
      ["GET", "/api/bootstrap"],
      ["GET", "/api/stream"],
      ["GET", "/metrics"],
      ["GET", "/api/auth/sessions"],
      ["DELETE", "/api/auth/sessions"],
      ["POST", "/api/auth/logout"],
      ["POST", "/api/auth/token"],
      ["POST", "/api/bots"],
      ["GET", "/api/nope"],
    ] as const) {
      const response = await call(guarded, method, path);
      expect(response.status, `${method} ${path}`).toBe(401);
      expect((await errorOf(response)).code).toBe("UNAUTHORIZED");
    }
    const state = authStateSchema.parse(
      await (await call(guarded, "GET", "/api/auth/session")).json(),
    );
    expect(state).toMatchObject({
      required: true,
      authenticated: false,
      via: "none",
      methods: { token: true, password: true, passkey: false },
      session: null,
    });
    expect((await call(guarded, "GET", "/health")).status).toBe(200);
  });

  it("keeps the bearer token working for scripts and /metrics, with no Origin", async () => {
    const guarded = app();
    expect(
      (await call(guarded, "GET", "/api/bootstrap", { bearer: TOKEN })).status,
    ).toBe(200);
    const metrics = await call(guarded, "GET", "/metrics", { bearer: TOKEN });
    expect(metrics.status).toBe(200);
    expect(await metrics.text()).toContain("# TYPE");
    const created = await call(guarded, "POST", "/api/bots", {
      bearer: TOKEN,
      body: { name: "Scripted" },
    });
    expect(created.status).toBe(201);
    const state = authStateSchema.parse(
      await (
        await call(guarded, "GET", "/api/auth/session", { bearer: TOKEN })
      ).json(),
    );
    expect(state).toMatchObject({ authenticated: true, via: "bearer" });
  });

  it("refuses cross-site requests before any credential, sign-in included", async () => {
    const guarded = app();
    const { cookie } = await signIn(guarded);
    for (const [method, path, body] of [
      ["POST", "/api/auth/login", { token: TOKEN }],
      ["GET", "/api/auth/session", undefined],
      ["GET", "/api/bootstrap", undefined],
    ] as const) {
      const response = await call(guarded, method, path, {
        cookie,
        origin: "https://evil.example",
        ...(body ? { body } : {}),
        headers: { "Sec-Fetch-Site": "cross-site" },
      });
      expect(response.status, path).toBe(403);
    }
    // The page that asked is framed by nobody (headers.ts).
    const page = await call(guarded, "GET", "/api/auth/session");
    expect(page.headers.get("Content-Security-Policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(page.headers.get("X-Frame-Options")).toBe("DENY");
  });
});

describe("the session cookie", () => {
  it("is jj_session without Secure for plain http on loopback", async () => {
    const { response, session } = await signIn(app());
    const { pair, attributes } = setCookie(response);
    expect(pair).toMatch(/^jj_session=[A-Za-z0-9_-]{43}$/);
    expect(attributes).toEqual([
      "Path=/",
      `Max-Age=${SESSION_ABSOLUTE_MS / 1000}`,
      "HttpOnly",
      "SameSite=Strict",
    ]);
    expect(session.current).toBe(true);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("is __Host-jj_session with Secure for an https public URL", async () => {
    const https = app({ publicUrl: "https://jj.example.com" });
    const { pair, attributes } = setCookie(
      (
        await signIn(
          https,
          { token: TOKEN },
          {
            origin: "https://jj.example.com",
          },
        )
      ).response,
    );
    expect(pair).toMatch(/^__Host-jj_session=[A-Za-z0-9_-]{43}$/);
    expect(attributes).toEqual([
      "Path=/",
      `Max-Age=${SESSION_ABSOLUTE_MS / 1000}`,
      "HttpOnly",
      "SameSite=Strict",
      "Secure",
    ]);
    // The plain name is no session there: a subdomain could have set it.
    const value = pair.split("=")[1];
    expect(
      (
        await call(https, "GET", "/api/bootstrap", {
          cookie: `jj_session=${value}`,
        })
      ).status,
    ).toBe(401);
    expect(
      (await call(https, "GET", "/api/bootstrap", { cookie: pair })).status,
    ).toBe(200);
  });

  it("stores only the secret's hash, never the cookie's value", async () => {
    const { cookie } = await signIn(app());
    const secret = cookie.split("=")[1] as string;
    const rows = await t.database.db.select().from(authSessions);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(secret);
  });
});

describe("cookie writes and Origin", () => {
  it("reads with the cookie, and writes only from the app's own Origin", async () => {
    const guarded = app();
    const { cookie } = await signIn(guarded);
    expect(
      (await call(guarded, "GET", "/api/bootstrap", { cookie })).status,
    ).toBe(200);
    for (const origin of [
      undefined,
      "https://evil.example",
      "http://127.0.0.1:3002",
      "http://localhost:3001",
      "null",
    ]) {
      const response = await call(guarded, "POST", "/api/bots", {
        cookie,
        body: { name: "Csrf" },
        ...(origin ? { origin } : {}),
      });
      expect(response.status, String(origin)).toBe(403);
      expect((await errorOf(response)).code).toBe("UNAUTHORIZED");
    }
    const deleted = await call(guarded, "DELETE", "/api/auth/sessions", {
      cookie,
    });
    expect(deleted.status).toBe(403);
    const created = await call(guarded, "POST", "/api/bots", {
      cookie,
      origin: ORIGIN,
      body: { name: "Mine" },
    });
    expect(created.status).toBe(201);
  });

  it("takes only API_PUBLIC_URL's origin when it is set", async () => {
    const pub = app({ publicUrl: "https://jj.example.com" });
    const wrong = await call(pub, "POST", "/api/auth/login", {
      origin: ORIGIN,
      body: { token: TOKEN },
    });
    expect(wrong.status).toBe(403);
    const { cookie } = await signIn(
      pub,
      { token: TOKEN },
      {
        origin: "https://jj.example.com",
      },
    );
    expect(
      (
        await call(pub, "POST", "/api/auth/logout", {
          cookie,
          origin: "https://other.example.com",
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(pub, "POST", "/api/auth/logout", {
          cookie,
          origin: "https://jj.example.com",
        })
      ).status,
    ).toBe(204);
  });
});

describe("signing in", () => {
  it("takes the token, the password or a one-time code, and refuses each wrong one alike", async () => {
    const guarded = app();
    await signIn(guarded, { token: TOKEN });
    await signIn(guarded, { password: PASSWORD });
    const code = await guarded.auth.store.createLoginCode();
    await signIn(guarded, { code });
    const messages = new Set<string>();
    for (const credential of [
      { token: `${TOKEN}x` },
      { password: `${PASSWORD}!` },
      { code },
      { code: "never-issued" },
    ]) {
      const response = await call(guarded, "POST", "/api/auth/login", {
        origin: ORIGIN,
        body: credential,
        client: `198.51.100.${messages.size + 1}`,
      });
      expect(response.status).toBe(401);
      const error = await errorOf(response);
      expect(error.code).toBe("UNAUTHORIZED");
      messages.add(error.message);
      expect(response.headers.get("Set-Cookie")).toBeNull();
    }
    expect([...messages]).toEqual([SIGN_IN_FAILED]);
    const noPassword = app({ password: undefined });
    const refused = await call(noPassword, "POST", "/api/auth/login", {
      origin: ORIGIN,
      body: { password: PASSWORD },
    });
    expect((await errorOf(refused)).message).toBe(SIGN_IN_FAILED);
  });

  it("expires a login code after 15 minutes, unused", async () => {
    const guarded = app();
    const code = await guarded.auth.store.createLoginCode();
    const stored = await t.database.db.select().from(authLoginCodes);
    expect(JSON.stringify(stored)).not.toContain(code);
    clock.now += LOGIN_CODE_MS + 1;
    const late = await call(guarded, "POST", "/api/auth/login", {
      origin: ORIGIN,
      body: { code },
    });
    expect(late.status).toBe(401);
  });

  it("replaces the session of a browser that signs in again", async () => {
    const guarded = app();
    const first = await signIn(guarded);
    const second = await signIn(
      guarded,
      { token: TOKEN },
      {
        cookie: first.cookie,
      },
    );
    expect(
      (await call(guarded, "GET", "/api/bootstrap", { cookie: first.cookie }))
        .status,
    ).toBe(401);
    expect(
      (await call(guarded, "GET", "/api/bootstrap", { cookie: second.cookie }))
        .status,
    ).toBe(200);
  });
});

describe("expiry (injected clock)", () => {
  it("ends a session after 7 idle days, and writes last seen at most hourly", async () => {
    const guarded = app();
    const { cookie, session } = await signIn(guarded);
    const lastSeen = async () =>
      (
        await t.database.db
          .select()
          .from(authSessions)
          .where(eq(authSessions.id, session.id))
      )[0]?.lastSeenAt.getTime();
    const signedInAt = clock.now;
    clock.now += LAST_SEEN_WRITE_MS - 1000;
    expect(
      (await call(guarded, "GET", "/api/bootstrap", { cookie })).status,
    ).toBe(200);
    expect(await lastSeen()).toBe(signedInAt);
    clock.now += 2000;
    expect(
      (await call(guarded, "GET", "/api/bootstrap", { cookie })).status,
    ).toBe(200);
    expect(await lastSeen()).toBe(clock.now);
    clock.now += SESSION_IDLE_MS - 1000;
    expect(
      (await call(guarded, "GET", "/api/bootstrap", { cookie })).status,
    ).toBe(200);
    clock.now += SESSION_IDLE_MS + 1;
    const ended = await call(guarded, "GET", "/api/bootstrap", { cookie });
    expect(ended.status).toBe(401);
    // An ended session's cookie is cleared.
    expect(setCookie(ended).attributes).toContain("Max-Age=0");
  });

  it("ends a session 30 days after sign-in however often it is used", async () => {
    const guarded = app();
    const { cookie } = await signIn(guarded);
    const end = clock.now + SESSION_ABSOLUTE_MS;
    while (clock.now + 6 * DAY < end) {
      clock.now += 6 * DAY;
      expect(
        (await call(guarded, "GET", "/api/bootstrap", { cookie })).status,
      ).toBe(200);
    }
    const listed = authSessionListSchema.parse(
      await (
        await call(guarded, "GET", "/api/auth/sessions", { cookie })
      ).json(),
    );
    expect(Date.parse(listed.sessions[0]?.expiresAt ?? "")).toBe(end);
    clock.now = end;
    expect(
      (await call(guarded, "GET", "/api/bootstrap", { cookie })).status,
    ).toBe(401);
  });
});

describe("rate limits", () => {
  it("answers 429 after 5 failed sign-ins from a client, yet the right token still signs in", async () => {
    const guarded = app();
    for (let attempt = 0; attempt < 5; attempt += 1)
      expect(
        (
          await call(guarded, "POST", "/api/auth/login", {
            origin: ORIGIN,
            body: { token: "wrong" },
            client: "203.0.113.9",
          })
        ).status,
      ).toBe(401);
    const limited = await call(guarded, "POST", "/api/auth/login", {
      origin: ORIGIN,
      body: { password: PASSWORD },
      client: "203.0.113.9",
    });
    expect(limited.status).toBe(429);
    const error = await errorOf(limited);
    expect(error.code).toBe("RATE_LIMITED");
    const retryAfter = Number(limited.headers.get("Retry-After"));
    expect(retryAfter).toBeGreaterThan(14 * 60);
    expect(retryAfter).toBeLessThanOrEqual(15 * 60);
    expect(error.details).toEqual({ retryAfterSeconds: retryAfter });
    // Another client is not limited, and the token always gets the owner in.
    await signIn(guarded, { password: PASSWORD }, { client: "203.0.113.10" });
    await signIn(guarded, { token: TOKEN }, { client: "203.0.113.9" });
  });

  it("locks the password path after 20 failures from anywhere, never the token, and doubles the lock", async () => {
    const guarded = app();
    const failPasswords = async (from: number) => {
      for (let client = 0; client < 4; client += 1)
        for (let attempt = 0; attempt < 5; attempt += 1)
          await call(guarded, "POST", "/api/auth/login", {
            origin: ORIGIN,
            body: { password: "not it at all" },
            client: `10.${from}.0.${client}`,
          });
    };
    await failPasswords(1);
    const locked = await call(guarded, "POST", "/api/auth/login", {
      origin: ORIGIN,
      body: { password: PASSWORD },
      client: "10.9.9.9",
    });
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("Retry-After"))).toBe(15 * 60);
    await signIn(guarded, { token: TOKEN }, { client: "10.9.9.9" });
    await signIn(guarded, { code: await guarded.auth.store.createLoginCode() });
    clock.now += 15 * 60_000 + 1;
    await failPasswords(2);
    const again = await call(guarded, "POST", "/api/auth/login", {
      origin: ORIGIN,
      body: { password: PASSWORD },
      client: "10.9.9.8",
    });
    expect(Number(again.headers.get("Retry-After"))).toBe(30 * 60);
    expect(
      quietLogger.lines.some((line) =>
        line.message.includes("Password sign-in is locked for 30 minutes"),
      ),
    ).toBe(true);
    clock.now += 30 * 60_000 + 1;
    await signIn(guarded, { password: PASSWORD }, { client: "10.9.9.7" });
  }, 60_000);

  it("answers 429 to a client after 30 wrong bearer tokens in a minute", async () => {
    const guarded = app();
    for (let attempt = 0; attempt < 30; attempt += 1)
      expect(
        (
          await call(guarded, "GET", "/api/bootstrap", {
            bearer: `guess-${attempt}`,
            client: "203.0.113.50",
          })
        ).status,
      ).toBe(401);
    const limited = await call(guarded, "GET", "/api/bootstrap", {
      bearer: TOKEN,
      client: "203.0.113.50",
    });
    expect(limited.status).toBe(429);
    expect((await errorOf(limited)).code).toBe("RATE_LIMITED");
    expect(
      (
        await call(guarded, "GET", "/api/bootstrap", {
          bearer: TOKEN,
          client: "203.0.113.51",
        })
      ).status,
    ).toBe(200);
    clock.now += 60_001;
    expect(
      (
        await call(guarded, "GET", "/api/bootstrap", {
          bearer: TOKEN,
          client: "203.0.113.50",
        })
      ).status,
    ).toBe(200);
  });

  it("counts X-Forwarded-For only from a trusted proxy", async () => {
    const guarded = app({ trustedProxies: parseTrustedProxies("loopback") });
    const fail = (client: string, forwardedFor: string) =>
      call(guarded, "POST", "/api/auth/login", {
        origin: ORIGIN,
        body: { token: "wrong" },
        client,
        headers: { "X-Forwarded-For": forwardedFor },
      });
    // Through the proxy on loopback, each forwarded client counts apart.
    for (let attempt = 0; attempt < 5; attempt += 1)
      await fail("127.0.0.1", `198.51.100.1, 198.51.100.${attempt + 10}`);
    expect((await fail("127.0.0.1", "198.51.100.99")).status).toBe(401);
    // A client sending the header itself is still counted as itself.
    for (let attempt = 0; attempt < 5; attempt += 1)
      await fail("203.0.113.77", `198.51.100.${attempt + 30}`);
    expect((await fail("203.0.113.77", "198.51.100.200")).status).toBe(429);
  });
});

describe("devices, signing out and rotation", () => {
  async function openStream(target: JJApp, options: Call) {
    const response = await call(target, "GET", "/api/stream", options);
    expect(response.status).toBe(200);
    const reader = new SseReader(response);
    await reader.until((r) => r.comments.includes("connected"), {
      what: "the stream to open",
    });
    return reader;
  }

  it("lists devices, signs one out, and ends that device's streams at once", async () => {
    const guarded = app({}, TOKEN);
    const phone = await signIn(
      guarded,
      { token: TOKEN },
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
        },
      },
    );
    const laptop = await signIn(
      guarded,
      { password: PASSWORD },
      {
        headers: {
          "User-Agent":
            "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
        },
      },
    );
    const listed = authSessionListSchema.parse(
      await (
        await call(guarded, "GET", "/api/auth/sessions", {
          cookie: laptop.cookie,
        })
      ).json(),
    );
    expect(
      listed.sessions.map((session) => [session.label, session.current]),
    ).toEqual(
      expect.arrayContaining([
        ["Safari on iPhone", false],
        ["Firefox on Linux", true],
      ]),
    );
    const phoneStream = await openStream(guarded, { cookie: phone.cookie });
    const laptopStream = await openStream(guarded, { cookie: laptop.cookie });
    expect(
      (
        await call(
          guarded,
          "DELETE",
          `/api/auth/sessions/${phone.session.id}`,
          {
            cookie: laptop.cookie,
            origin: ORIGIN,
          },
        )
      ).status,
    ).toBe(204);
    await phoneStream.ended({ timeoutMs: 2_000 });
    expect(laptopStream.isDone).toBe(false);
    expect(
      (await call(guarded, "GET", "/api/bootstrap", { cookie: phone.cookie }))
        .status,
    ).toBe(401);
    expect(
      (
        await call(
          guarded,
          "DELETE",
          `/api/auth/sessions/${phone.session.id}`,
          {
            cookie: laptop.cookie,
            origin: ORIGIN,
          },
        )
      ).status,
    ).toBe(404);
    // Signing out ends this device's own stream and clears its cookie.
    const out = await call(guarded, "POST", "/api/auth/logout", {
      cookie: laptop.cookie,
      origin: ORIGIN,
    });
    expect(out.status).toBe(204);
    expect(setCookie(out).header).toMatch(/^jj_session=; .*Max-Age=0/);
    await laptopStream.ended({ timeoutMs: 2_000 });
    expect(
      (await call(guarded, "GET", "/api/bootstrap", { cookie: laptop.cookie }))
        .status,
    ).toBe(401);
  });

  it("ends a stream whose session another process signed out, at the next heartbeat", async () => {
    const guarded = app({}, TOKEN, 50);
    const { cookie, session } = await signIn(guarded);
    const stream = await openStream(guarded, { cookie });
    // Deleted behind this process's back, as another API process would.
    await t.database.db
      .delete(authSessions)
      .where(eq(authSessions.id, session.id));
    await stream.ended({ timeoutMs: 2_000 });
  });

  it("signs out every other device", async () => {
    const guarded = app();
    const keep = await signIn(guarded);
    const other = await signIn(guarded);
    const otherStream = await openStream(guarded, { cookie: other.cookie });
    expect(
      (
        await call(guarded, "DELETE", "/api/auth/sessions", {
          cookie: keep.cookie,
          origin: ORIGIN,
        })
      ).status,
    ).toBe(204);
    await otherStream.ended({ timeoutMs: 2_000 });
    expect(
      (await call(guarded, "GET", "/api/bootstrap", { cookie: keep.cookie }))
        .status,
    ).toBe(200);
    expect(
      (await call(guarded, "GET", "/api/bootstrap", { cookie: other.cookie }))
        .status,
    ).toBe(401);
  });

  it("rotates the generated token: the old one gets 401, other sessions and bearer streams end", async () => {
    const generated = "generated-token-0123456789abcdefghijklmnopq";
    await t.database.db
      .insert(instanceSettings)
      .values({ key: GENERATED_TOKEN_KEY, value: generated })
      .onConflictDoUpdate({
        target: instanceSettings.key,
        set: { value: generated },
      });
    const guarded = app({ generated: true }, generated);
    const mine = await signIn(guarded, { token: generated });
    const other = await signIn(guarded, { password: PASSWORD });
    const otherStream = await openStream(guarded, { cookie: other.cookie });
    const bearerStream = await openStream(guarded, { bearer: generated });
    const myStream = await openStream(guarded, { cookie: mine.cookie });

    const wrong = await call(guarded, "POST", "/api/auth/token", {
      cookie: mine.cookie,
      origin: ORIGIN,
      body: { current: { token: "not the token" } },
    });
    expect(wrong.status).toBe(401);
    const rotated = await call(guarded, "POST", "/api/auth/token", {
      cookie: mine.cookie,
      origin: ORIGIN,
      body: { current: { password: PASSWORD } },
    });
    expect(rotated.status).toBe(201);
    expect(rotated.headers.get("Cache-Control")).toBe("no-store");
    const { token } = (await rotated.json()) as { token: string };
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(token).not.toBe(generated);

    await otherStream.ended({ timeoutMs: 2_000 });
    await bearerStream.ended({ timeoutMs: 2_000 });
    expect(myStream.isDone).toBe(false);
    expect(
      (await call(guarded, "GET", "/api/bootstrap", { bearer: generated }))
        .status,
    ).toBe(401);
    expect(
      (await call(guarded, "GET", "/api/bootstrap", { bearer: token })).status,
    ).toBe(200);
    expect(
      (await call(guarded, "GET", "/api/bootstrap", { cookie: other.cookie }))
        .status,
    ).toBe(401);
    expect(
      (await call(guarded, "GET", "/api/bootstrap", { cookie: mine.cookie }))
        .status,
    ).toBe(200);
    const [stored] = await t.database.db
      .select()
      .from(instanceSettings)
      .where(eq(instanceSettings.key, GENERATED_TOKEN_KEY));
    expect(stored?.value).toBe(token);
    // The engine's redactor learns the new token.
    expect(
      (await t.engine.context.serverSecrets()).map((secret) => secret.value),
    ).toContain(token);
    myStream.close();
  });

  it("refuses to rotate API_TOKEN, which the environment sets", async () => {
    const guarded = app();
    const response = await call(guarded, "POST", "/api/auth/token", {
      bearer: TOKEN,
      body: { current: { token: TOKEN } },
    });
    expect(response.status).toBe(409);
    expect((await errorOf(response)).code).toBe("CONFLICT");
  });
});

describe("a changed credential", () => {
  it("signs every device out at the next boot", async () => {
    const before = app();
    expect(await before.auth.reconcileCredentials()).toBe(0);
    const { cookie } = await signIn(before);
    expect(await app().auth.reconcileCredentials()).toBe(0);
    expect(
      (await call(app(), "GET", "/api/bootstrap", { cookie })).status,
    ).toBe(200);
    const newPassword = await hashPassword("a whole new password");
    const after = app({
      password: { hash: parsePasswordHash(newPassword), text: newPassword },
    });
    expect(await after.auth.reconcileCredentials()).toBe(1);
    expect(
      (await call(after, "GET", "/api/bootstrap", { cookie })).status,
    ).toBe(401);
  });
});
