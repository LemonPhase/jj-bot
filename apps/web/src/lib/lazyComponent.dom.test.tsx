// @vitest-environment jsdom
import "../test/dom";
import { render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { describe, expect, it, vi } from "vitest";
import { LoadBoundary, lazyComponent } from "./lazyComponent";
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
});
