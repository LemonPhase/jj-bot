// @vitest-environment jsdom
import "../test/dom";
import { act, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoadBoundary, lazyComponent, whenIdle } from "./lazyComponent";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const Part = ({ name }: { name: string }) => <p>Hello {name}</p>;

describe("lazyComponent", () => {
  it("loads its chunk once, however often it is asked", async () => {
    const importPart = vi.fn(async () => Part);
    const part = lazyComponent("Part", importPart);
    await Promise.all([part.load(), part.load()]);
    await part.load();
    expect(importPart).toHaveBeenCalledTimes(1);
  });

  it("forgets a failed load, so a later one (the render after a preload) tries again", async () => {
    const importPart = vi
      .fn<() => Promise<typeof Part>>()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(Part);
    const part = lazyComponent("Part", importPart);
    await expect(part.load()).rejects.toThrow("Failed to fetch");
    render(
      <Suspense fallback={<p>Loading part…</p>}>
        <part.Component name="Kite" />
      </Suspense>,
    );
    expect(screen.getByText("Loading part…")).toBeTruthy();
    expect(await screen.findByText("Hello Kite")).toBeTruthy();
    expect(importPart).toHaveBeenCalledTimes(2);
  });

  it("tries once more when a preload it waits on fails", async () => {
    let fail: (error: Error) => void = () => {};
    const importPart = vi
      .fn<() => Promise<typeof Part>>()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            fail = reject;
          }),
      )
      .mockResolvedValue(Part);
    const part = lazyComponent("Part", importPart);
    const preload = part.load().catch(() => {});
    // Asked for while the preload is in flight, then the preload fails.
    render(
      <Suspense fallback={<p>Loading part…</p>}>
        <part.Component name="Moss" />
      </Suspense>,
    );
    act(() => fail(new TypeError("net::ERR_NETWORK_CHANGED")));
    await preload;
    expect(await screen.findByText("Hello Moss")).toBeTruthy();
    expect(importPart).toHaveBeenCalledTimes(2);
  });

  it("renders at once, without its fallback, once its chunk is in", async () => {
    const part = lazyComponent("Part", async () => Part);
    await part.load();
    render(
      <Suspense fallback={<p>Loading part…</p>}>
        <part.Component name="Juno" />
      </Suspense>,
    );
    expect(screen.getByText("Hello Juno")).toBeTruthy();
    expect(screen.queryByText("Loading part…")).toBeNull();
  });

  it("shows its boundary's message when the chunk does not arrive twice", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const importPart = vi.fn(async (): Promise<typeof Part> => {
      throw new TypeError("Failed to fetch dynamically imported module");
    });
    const part = lazyComponent<{ name: string }>("Part", importPart);
    render(
      <LoadBoundary failed={(error) => <p role="alert">{error.message}</p>}>
        <Suspense fallback={null}>
          <part.Component name="Nova" />
        </Suspense>
      </LoadBoundary>,
    );
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Failed to fetch dynamically imported module",
    );
    expect(importPart).toHaveBeenCalledTimes(2);
  });
});

describe("whenIdle", () => {
  it("waits for the browser to be idle, and can be cancelled", () => {
    const requestIdleCallback = vi.fn(() => 7);
    const cancelIdleCallback = vi.fn();
    vi.stubGlobal("requestIdleCallback", requestIdleCallback);
    vi.stubGlobal("cancelIdleCallback", cancelIdleCallback);
    const task = vi.fn();
    const cancel = whenIdle(task);
    expect(requestIdleCallback).toHaveBeenCalledWith(task, { timeout: 2000 });
    expect(task).not.toHaveBeenCalled();
    cancel();
    expect(cancelIdleCallback).toHaveBeenCalledWith(7);
  });

  it("falls back to a short timer where the browser cannot tell (Safari)", () => {
    vi.useFakeTimers();
    vi.stubGlobal("requestIdleCallback", undefined);
    const task = vi.fn();
    whenIdle(task);
    vi.advanceTimersByTime(199);
    expect(task).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(task).toHaveBeenCalledTimes(1);

    const cancelled = vi.fn();
    whenIdle(cancelled)();
    vi.advanceTimersByTime(1000);
    expect(cancelled).not.toHaveBeenCalled();
  });
});
