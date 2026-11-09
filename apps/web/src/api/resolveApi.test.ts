// @vitest-environment jsdom
import { CONTRACT_VERSION } from "@jj/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { JJApi } from "./client";
import { resolveApi, type Startup } from "./resolveApi";

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

const appOf = (startup: Startup): JJApi => {
  if (startup.kind !== "app") throw new Error(`opened on ${startup.kind}`);
  return startup.api;
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const signedOut = {
  required: true,
  authenticated: false,
  via: "none",
  methods: { token: true, password: true, passkey: false },
  session: null,
};

const bootstrap = {
  mode: "backend",
  contractVersion: CONTRACT_VERSION,
  capabilities: {
    agentExecution: true,
    persistence: true,
    streaming: true,
    verification: false,
    drivers: [],
  },
  defaultModel: null,
  bots: [],
  tasks: [],
  profiles: [],
};

describe("resolveApi", () => {
  it("loads the demo data on demand, with the reason in the badge", async () => {
    window.history.replaceState(null, "", "/?demo");
    const api = appOf(await resolveApi());
    expect(api.mode).toBe("demo");
    expect(api.auth).toBeUndefined();
    expect(api.badge).toMatchObject({
      label: "Demo data",
      title: expect.stringContaining("Opened with ?demo."),
    });
  });

  it("says the API is unreachable, offline or down, and never shows the demo data instead", async () => {
    const loadDemo = vi.fn(() => import("./demoApi"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(resolveApi(loadDemo)).rejects.toThrow(
      "The JJ Bot API isn't reachable.",
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("Service unavailable", { status: 503 })),
    );
    await expect(resolveApi(loadDemo)).rejects.toThrow(
      "The JJ Bot API isn't reachable.",
    );
    expect(loadDemo).not.toHaveBeenCalled();
  });

  it("falls back to the demo data when no JJ Bot API is served (a static build)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("<!doctype html>", { status: 404 })),
    );
    const loadDemo = vi.fn(() => import("./demoApi"));
    const api = appOf(await resolveApi(loadDemo));
    expect(loadDemo).toHaveBeenCalledOnce();
    expect(api.mode).toBe("demo");
    expect(api.badge.title).toContain("No JJ Bot API answers here.");
  });

  it("says why when the demo data cannot load either", async () => {
    window.history.replaceState(null, "", "/?demo");
    const loadDemo = () =>
      Promise.reject(
        new TypeError("Failed to fetch dynamically imported module"),
      );
    await expect(resolveApi(loadDemo)).rejects.toThrow(
      "Opened with ?demo. The demo data did not load either: Failed to fetch dynamically imported module",
    );
  });

  it("opens on the login screen when the server asks to sign in, and never probes the workspace first", async () => {
    window.history.replaceState(null, "", "/?token=old#/tasks/task-1");
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input) === "/api/auth/session"
        ? json(200, signedOut)
        : json(401, { error: { code: "UNAUTHORIZED", message: "no" } }),
    );
    vi.stubGlobal("fetch", fetch);
    const startup = await resolveApi();
    expect(startup).toMatchObject({ kind: "login", state: signedOut });
    expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
      "/api/auth/session",
    ]);
    // The old token left the address bar unused.
    expect(window.location.href).toBe("http://localhost:3000/#/tasks/task-1");
  });

  it("signs in with a login link's code, then opens the workspace on the session cookie", async () => {
    window.history.replaceState(null, "", "/#/login?code=one-time-code");
    let signedIn = false;
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init: RequestInit = {}) => {
        const url = String(input);
        if (url === "/api/auth/session") return json(200, signedOut);
        if (url === "/api/auth/login") {
          expect(JSON.parse(String(init.body))).toEqual({
            code: "one-time-code",
          });
          signedIn = true;
          return json(200, {
            session: {
              id: "auth_1",
              label: "Unknown device",
              createdAt: "2026-11-09T10:00:00.000Z",
              lastSeenAt: "2026-11-09T10:00:00.000Z",
              expiresAt: "2026-12-09T10:00:00.000Z",
              current: true,
            },
          });
        }
        if (!signedIn)
          return json(401, { error: { code: "UNAUTHORIZED", message: "no" } });
        if (url === "/api/bootstrap") return json(200, bootstrap);
        return json(404, { error: { code: "NOT_FOUND", message: url } });
      },
    );
    vi.stubGlobal("fetch", fetch);
    const api = appOf(await resolveApi());
    expect(api.mode).toBe("live");
    expect(api.auth).toBeDefined();
    expect(window.location.hash).toBe("#/login");
    for (const [, init] of fetch.mock.calls)
      expect(JSON.stringify(init?.headers ?? {})).not.toContain(
        "Authorization",
      );
  });
});
