// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveApi } from "./resolveApi";

afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

describe("resolveApi", () => {
  it("loads the demo data on demand, with the reason in the badge", async () => {
    window.history.replaceState(null, "", "/?demo");
    const api = await resolveApi();
    expect(api.mode).toBe("demo");
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
    const api = await resolveApi(loadDemo);
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
});
