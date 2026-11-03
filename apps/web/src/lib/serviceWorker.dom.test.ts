// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerServiceWorker } from "./serviceWorker";

const register = vi.fn(() => Promise.resolve({}));

function withServiceWorker() {
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: { register },
  });
}

afterEach(() => {
  register.mockClear();
  Reflect.deleteProperty(navigator, "serviceWorker");
});

describe("registerServiceWorker", () => {
  it("does nothing outside a production build, as in dev and these tests", () => {
    withServiceWorker();
    registerServiceWorker();
    registerServiceWorker(false);
    window.dispatchEvent(new Event("load"));
    expect(register).not.toHaveBeenCalled();
  });

  it("registers /sw.js for the whole app, past the HTTP cache, once loaded", () => {
    withServiceWorker();
    // jsdom has finished loading by now, so it registers at once.
    expect(document.readyState).toBe("complete");
    registerServiceWorker(true);
    expect(register).toHaveBeenCalledWith("/sw.js", {
      scope: "/",
      updateViaCache: "none",
    });
  });

  it("waits for the page's load before registering", () => {
    withServiceWorker();
    const state = vi
      .spyOn(document, "readyState", "get")
      .mockReturnValue("interactive");
    try {
      registerServiceWorker(true);
      expect(register).not.toHaveBeenCalled();
      window.dispatchEvent(new Event("load"));
      expect(register).toHaveBeenCalledTimes(1);
    } finally {
      state.mockRestore();
    }
  });

  it("leaves a browser without service workers alone", () => {
    expect("serviceWorker" in navigator).toBe(false);
    expect(() => registerServiceWorker(true)).not.toThrow();
  });
});
