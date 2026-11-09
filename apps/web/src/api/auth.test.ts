// Signing the web app in: the login link's code and an old ?token= never
// stay in the address bar, a token an earlier version kept in localStorage is
// exchanged once and deleted, and an ended session sends the app back to the
// login screen, from a request or from a stream the browser gave up on.
import {
  type AuthState,
  type Bootstrap,
  CONTRACT_VERSION,
} from "@jj/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  type AuthApi,
  authState,
  createAuthApi,
  hasPendingSignIn,
  LEGACY_TOKEN_KEY,
  retryAfterSeconds,
} from "./auth";
import { ApiError } from "./client";
import { createLiveApi } from "./liveApi";
import { dropTokenFromAddress, signInOnce, takeLoginCode } from "./signIn";
import type { EventSourceLike } from "./sse";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const signedOut: AuthState = {
  required: true,
  authenticated: false,
  via: "none",
  methods: { token: true, password: false, passkey: false },
  session: null,
};

const session = {
  id: "auth_1",
  label: "Firefox on Linux",
  createdAt: "2026-11-09T10:00:00.000Z",
  lastSeenAt: "2026-11-09T10:00:00.000Z",
  expiresAt: "2026-12-09T10:00:00.000Z",
  current: true,
};

function storage(entries: Record<string, string> = {}) {
  const values = new Map(Object.entries(entries));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    removeItem: (key: string) => void values.delete(key),
  };
}

/** An AuthApi whose state and login answers are scripted. */
function fakeAuth(
  state: AuthState | Error,
  login: (command: unknown) => Promise<void> = async () => {},
) {
  const logins: unknown[] = [];
  const auth = {
    state: vi.fn(async () => {
      if (state instanceof Error) throw state;
      return state;
    }),
    login: vi.fn(async (command: unknown) => {
      logins.push(command);
      await login(command);
      return session;
    }),
  } as unknown as AuthApi;
  return { auth, logins };
}

const refused = new ApiError(
  "UNAUTHORIZED",
  "Sign-in failed: the token, password or link is wrong, used or expired.",
  undefined,
  401,
);

describe("the address bar", () => {
  it("takes a login link's code out of the fragment, keeping #/login", () => {
    const replaceState = vi.fn();
    expect(
      takeLoginCode({
        location: { href: "https://jj.example.com/#/login?code=c0de-1" },
        history: { replaceState },
      }),
    ).toBe("c0de-1");
    expect(replaceState).toHaveBeenCalledWith(
      null,
      "",
      "https://jj.example.com/#/login",
    );
    expect(
      takeLoginCode({ location: { href: "https://jj.example.com/#/tasks" } }),
    ).toBeNull();
  });

  it("drops an old ?token= without using it", () => {
    const replaceState = vi.fn();
    dropTokenFromAddress({
      location: { href: "http://localhost:5173/?token=abc&demo#/bots" },
      history: { replaceState },
    });
    expect(replaceState).toHaveBeenCalledWith(
      null,
      "",
      "http://localhost:5173/?demo#/bots",
    );
  });
});

describe("signing in on load", () => {
  it("loads the sign-in code only for a code, an old ?token= or a kept token", () => {
    const empty = storage();
    expect(hasPendingSignIn("https://jj.example.com/#/tasks", empty)).toBe(
      false,
    );
    expect(hasPendingSignIn("https://jj.example.com/#/login", empty)).toBe(
      false,
    );
    expect(
      hasPendingSignIn("https://jj.example.com/#/login?code=c", empty),
    ).toBe(true);
    expect(hasPendingSignIn("https://jj.example.com/?token=t", empty)).toBe(
      true,
    );
    expect(
      hasPendingSignIn(
        "https://jj.example.com/#/tasks",
        storage({ [LEGACY_TOKEN_KEY]: "kept" }),
      ),
    ).toBe(true);
  });

  it("opens the app when no sign-in is needed or the browser is signed in, dropping a kept token", async () => {
    for (const state of [
      { ...signedOut, required: false, authenticated: true },
      { ...signedOut, authenticated: true, via: "cookie" as const },
    ]) {
      const { auth, logins } = fakeAuth(state);
      const kept = storage({ [LEGACY_TOKEN_KEY]: "old-token" });
      expect(await signInOnce(auth, state, null, kept)).toEqual({
        signedIn: true,
      });
      expect(logins).toEqual([]);
      expect(kept.values.has(LEGACY_TOKEN_KEY)).toBe(false);
    }
  });

  it("signs in with a login link's code, or says why it did not", async () => {
    const ok = fakeAuth(signedOut);
    expect(await signInOnce(ok.auth, signedOut, "c0de", storage())).toEqual({
      signedIn: true,
    });
    expect(ok.logins).toEqual([{ code: "c0de" }]);
    const used = fakeAuth(signedOut, async () => {
      throw refused;
    });
    const result = await signInOnce(used.auth, signedOut, "c0de", storage());
    expect(result).toMatchObject({
      signedIn: false,
      state: signedOut,
      error: expect.stringContaining("A login link works once"),
    });
  });

  it("exchanges a token kept in localStorage once, then deletes it, whatever the answer", async () => {
    const kept = storage({ [LEGACY_TOKEN_KEY]: "old-token" });
    const ok = fakeAuth(signedOut);
    expect(await signInOnce(ok.auth, signedOut, null, kept)).toEqual({
      signedIn: true,
    });
    expect(ok.logins).toEqual([{ token: "old-token" }]);
    expect(kept.values.has(LEGACY_TOKEN_KEY)).toBe(false);

    const stale = storage({ [LEGACY_TOKEN_KEY]: "rotated-away" });
    const wrong = fakeAuth(signedOut, async () => {
      throw refused;
    });
    expect(await signInOnce(wrong.auth, signedOut, null, stale)).toEqual({
      signedIn: false,
      state: signedOut,
    });
    expect(stale.values.has(LEGACY_TOKEN_KEY)).toBe(false);

    // Offline: nothing was answered, so it is kept for the next load.
    const offline = storage({ [LEGACY_TOKEN_KEY]: "old-token" });
    const down = fakeAuth(signedOut, async () => {
      throw new ApiError("NETWORK_ERROR", "Can't reach the JJ Bot API");
    });
    await expect(
      signInOnce(down.auth, signedOut, null, offline),
    ).rejects.toThrow("Can't reach");
    expect(offline.values.get(LEGACY_TOKEN_KEY)).toBe("old-token");
  });

  it("leaves a server without sign-in routes to the bootstrap probe", async () => {
    const old = fakeAuth(new ApiError("NOT_FOUND", "No route", undefined, 404));
    expect(await authState(old.auth)).toBeNull();
  });
});

describe("rate limits", () => {
  it("reads the seconds to wait from a 429", () => {
    expect(
      retryAfterSeconds(
        new ApiError(
          "RATE_LIMITED",
          "Too many",
          { retryAfterSeconds: 840 },
          429,
        ),
      ),
    ).toBe(840);
    expect(retryAfterSeconds(refused)).toBeNull();
  });
});

describe("an ended session", () => {
  const bootstrap: Bootstrap = {
    mode: "backend",
    contractVersion: CONTRACT_VERSION,
    capabilities: {
      agentExecution: true,
      persistence: true,
      streaming: true,
      verification: false,
      secretStore: false,
      mcp: { stdio: false, remote: false },
      skills: false,
      schedules: false,
      uploads: null,
      drivers: [],
    },
    defaultModel: null,
    bots: [],
    tasks: [],
    profiles: [],
  };

  it("is reported by a 401 outside /api/auth, never by a failed sign-in", async () => {
    const onUnauthorized = vi.fn();
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("/api/auth/login")
        ? json(401, { error: { code: "UNAUTHORIZED", message: "no" } })
        : json(401, { error: { code: "UNAUTHORIZED", message: "ended" } }),
    ) as unknown as typeof globalThis.fetch;
    const auth = createAuthApi({ fetch, onUnauthorized });
    await expect(auth.login({ token: "x" })).rejects.toThrow("no");
    expect(onUnauthorized).not.toHaveBeenCalled();
    const api = createLiveApi({ bootstrap, fetch, auth, onUnauthorized });
    await expect(api.listBots()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
    expect(onUnauthorized).toHaveBeenCalledOnce();
    // The app sends no Authorization header: the cookie goes by itself.
    const [, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock
      .calls[1] as [string, RequestInit];
    expect(init.headers).not.toHaveProperty("Authorization");
  });

  it("is noticed when the browser gives up on a stream, by asking the server", async () => {
    const sources: (EventSourceLike & { fail(): void })[] = [];
    const eventSource = (url: string) => {
      const source = {
        url,
        readyState: 0,
        onopen: null as ((event: never) => unknown) | null,
        onerror: null as ((event: never) => unknown) | null,
        addEventListener() {},
        close() {},
        fail() {
          this.readyState = 2;
          this.onerror?.(new Event("error") as never);
        },
      };
      sources.push(source);
      return source;
    };
    const onUnauthorized = vi.fn();
    const auth = fakeAuth(signedOut).auth;
    const api = createLiveApi({
      bootstrap,
      fetch: vi.fn() as unknown as typeof globalThis.fetch,
      eventSource,
      auth,
      onUnauthorized,
      retryMs: 60_000,
    });
    const stop = api.subscribeHints(() => {});
    sources[0]?.fail();
    await vi.waitFor(() => expect(onUnauthorized).toHaveBeenCalledOnce());
    stop();
  });
});
