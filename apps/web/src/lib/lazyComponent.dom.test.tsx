// @vitest-environment jsdom
import "../test/dom";
import { render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  LoadBoundary,
  lazyComponent,
  OPEN_WAIT_MS,
  openWhenLoaded,
} from "./lazyComponent";
import { restoreStylesheets, watchStylesheets } from "./stylesheets";

const Part = ({ name }: { name: string }) => <p>Hello {name}</p>;

watchStylesheets();

/** A stylesheet link in the page, as Vite adds one for a lazy chunk. */
function stylesheet(href: string) {
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  document.head.append(link);
  return link;
}

/** The page's stylesheet links for `href`. */
const links = (href: string) =>
  [
    ...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
  ].filter((link) => link.href === href);

describe("lazyComponent", () => {
  it("loads its chunk once, however often it is asked", async () => {
    const importPart = vi.fn(async () => Part);
    const part = lazyComponent("Part", importPart);
    await Promise.all([part.load(), part.load()]);
    await part.load();
    expect(importPart).toHaveBeenCalledTimes(1);
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

  it("keeps a failed load: its boundary says so, and no later load tries again", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const importPart = vi.fn(async (): Promise<typeof Part> => {
      throw new TypeError("Failed to fetch dynamically imported module");
    });
    const part = lazyComponent<{ name: string }>("Part", importPart);
    await expect(part.load()).rejects.toThrow("Failed to fetch");
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
    await expect(part.load()).rejects.toThrow("Failed to fetch");
    expect(importPart).toHaveBeenCalledTimes(1);
  });

  it("asks again for a stylesheet that failed before it loads, and waits for it", async () => {
    const href = "http://localhost/assets/tasks-a.css";
    stylesheet(href).dispatchEvent(new Event("error"));
    const importPart = vi.fn(async () => Part);
    const part = lazyComponent("Part", importPart);
    const loading = part.load();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // The failed link is replaced, and the chunk waits for the new one.
    const [retry, ...others] = links(href);
    expect(others).toEqual([]);
    expect(importPart).not.toHaveBeenCalled();
    retry?.dispatchEvent(new Event("load"));
    await loading;
    expect(importPart).toHaveBeenCalledTimes(1);
    // Restored, it is not asked for again.
    await restoreStylesheets();
    expect(links(href)).toEqual([retry]);
  });

  it("fails a load whose failed stylesheet fails again, so the part never shows unstyled", async () => {
    const href = "http://localhost/assets/schedules-b.css";
    stylesheet(href).dispatchEvent(new Event("error"));
    const importPart = vi.fn(async () => Part);
    const part = lazyComponent("Part", importPart);
    const loading = part.load();
    await new Promise((resolve) => setTimeout(resolve, 0));
    links(href)[0]?.dispatchEvent(new Event("error"));
    await expect(loading).rejects.toThrow(
      `Unable to load the stylesheet ${href}`,
    );
    expect(importPart).not.toHaveBeenCalled();
    // Another part asks again for it later.
    const later = restoreStylesheets();
    await new Promise((resolve) => setTimeout(resolve, 0));
    links(href)[0]?.dispatchEvent(new Event("load"));
    await later;
  });

  it("asks again only for the failed stylesheets its own chunk loads with, when the page lists them", async () => {
    const own = new URL("/assets/tasks-c.css", document.baseURI).href;
    const other = new URL("/assets/schedules-d.css", document.baseURI).href;
    const list = document.createElement("meta");
    list.name = "jj-chunk-stylesheets";
    list.content = "Dialog=/assets/tasks-c.css;Panel=;Screen=/assets/x.css";
    document.head.append(list);
    try {
      stylesheet(own).dispatchEvent(new Event("error"));
      stylesheet(other).dispatchEvent(new Event("error"));
      // A chunk with no stylesheets of its own loads at once, whatever failed
      // (offline, an unvisited screen's stylesheet must not stop it).
      const panel = vi.fn(async () => Part);
      await lazyComponent("Panel", panel).load();
      expect(panel).toHaveBeenCalledTimes(1);
      // A chunk that needs one waits for it, and only for it.
      const dialog = vi.fn(async () => Part);
      const loading = lazyComponent("Dialog", dialog).load();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(dialog).not.toHaveBeenCalled();
      links(own)[0]?.dispatchEvent(new Event("load"));
      await loading;
      expect(dialog).toHaveBeenCalledTimes(1);
    } finally {
      list.remove();
      // Leave nothing failed behind for the other tests.
      const done = restoreStylesheets();
      await new Promise((resolve) => setTimeout(resolve, 0));
      for (const link of [...links(own), ...links(other)])
        link.dispatchEvent(new Event("load"));
      await done;
    }
  });
});

describe("openWhenLoaded", () => {
  const held = () => {
    let settle: (ok: boolean) => void = () => {};
    const load = vi.fn(
      () =>
        new Promise<unknown>((resolve, reject) => {
          settle = (ok) => (ok ? resolve(Part) : reject(new Error("failed")));
        }),
    );
    return { part: { load }, settle: (ok: boolean) => settle(ok) };
  };

  it("opens as soon as the part has loaded, before the wait is over", async () => {
    vi.useFakeTimers();
    try {
      const { part, settle } = held();
      const open = vi.fn();
      openWhenLoaded(part, open);
      expect(part.load).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30);
      expect(open).not.toHaveBeenCalled();
      settle(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(open).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(OPEN_WAIT_MS);
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens with the placeholder once the wait is over, and once only", async () => {
    vi.useFakeTimers();
    try {
      const { part, settle } = held();
      const open = vi.fn();
      openWhenLoaded(part, open);
      await vi.advanceTimersByTimeAsync(OPEN_WAIT_MS - 1);
      expect(open).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(open).toHaveBeenCalledTimes(1);
      settle(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("opens on a failed load too, so the part's boundary says what failed", async () => {
    const { part, settle } = held();
    const open = vi.fn();
    openWhenLoaded(part, open);
    settle(false);
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1));
  });
});
