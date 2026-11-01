// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeColorScheme } from "../test/dom";

/** Loads a fresh copy of theme.ts, which reads storage and the OS at import. */
async function loadTheme() {
  vi.resetModules();
  return import("./theme");
}

const root = () => document.documentElement;
// Under jsdom the global URL is jsdom's; node:fs wants Node's.
const readIndexHtml = () =>
  readFileSync(new NodeURL("../../index.html", import.meta.url), "utf8");
const metaContents = () =>
  Array.from(
    document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'),
  ).map((meta) => meta.content);

beforeEach(() => {
  localStorage.clear();
  root().removeAttribute("data-theme");
  document.head.innerHTML = `
    <meta name="theme-color" content="#f7f7f8" media="(prefers-color-scheme: light)">
    <meta name="theme-color" content="#0b0b0d" media="(prefers-color-scheme: dark)">`;
});

describe("useTheme", () => {
  it("follows the OS while the preference is system", async () => {
    const os = fakeColorScheme(false);
    const { useTheme } = await loadTheme();
    const { result } = renderHook(() => useTheme());
    expect(result.current).toMatchObject({
      preference: "system",
      resolved: "light",
    });
    act(() => os.set(true));
    expect(result.current.resolved).toBe("dark");
    expect(root().hasAttribute("data-theme")).toBe(false);
    expect(metaContents()).toEqual(["#f7f7f8", "#0b0b0d"]);
  });

  it("applies and stores an explicit choice, ignoring later OS changes", async () => {
    const os = fakeColorScheme(false);
    const { useTheme } = await loadTheme();
    const { result } = renderHook(() => useTheme());
    act(() => result.current.toggle());
    expect(result.current).toMatchObject({
      preference: "dark",
      resolved: "dark",
    });
    expect(root().getAttribute("data-theme")).toBe("dark");
    expect(localStorage.getItem("jj.theme")).toBe("dark");
    expect(metaContents()).toEqual(["#0b0b0d", "#0b0b0d"]);
    act(() => os.set(false));
    expect(result.current.resolved).toBe("dark");
    act(() => result.current.setPreference("system"));
    expect(root().hasAttribute("data-theme")).toBe(false);
    expect(localStorage.getItem("jj.theme")).toBeNull();
    expect(metaContents()).toEqual(["#f7f7f8", "#0b0b0d"]);
  });

  it("picks up a choice made in another tab", async () => {
    fakeColorScheme(false);
    const { useTheme } = await loadTheme();
    const first = renderHook(() => useTheme());
    const second = renderHook(() => useTheme());
    act(() => {
      localStorage.setItem("jj.theme", "dark");
      window.dispatchEvent(
        new StorageEvent("storage", { key: "jj.theme", newValue: "dark" }),
      );
    });
    expect(first.result.current.resolved).toBe("dark");
    expect(second.result.current.resolved).toBe("dark");
    expect(root().getAttribute("data-theme")).toBe("dark");
    act(() => {
      localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    expect(first.result.current.preference).toBe("system");
  });

  it("applies the stored choice as soon as the module loads", async () => {
    fakeColorScheme(true);
    localStorage.setItem("jj.theme", "light");
    await loadTheme();
    expect(root().getAttribute("data-theme")).toBe("light");
  });
});

describe("index.html pre-paint script", () => {
  it("uses the same storage key and theme colours as theme.ts", async () => {
    const { THEME_COLOURS, THEME_STORAGE_KEY } = await loadTheme();
    const html = readIndexHtml();
    expect(html).toContain(`localStorage.getItem("${THEME_STORAGE_KEY}")`);
    expect(html).toContain(
      `var colours = { light: "${THEME_COLOURS.light}", dark: "${THEME_COLOURS.dark}" }`,
    );
    for (const [theme, colour] of Object.entries(THEME_COLOURS))
      expect(html).toContain(
        `content="${colour}" media="(prefers-color-scheme: ${theme})"`,
      );
  });

  it("sets data-theme from storage before anything else runs", () => {
    const html = readIndexHtml();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1] ?? "";
    localStorage.setItem("jj.theme", "dark");
    new Function(script)();
    expect(root().getAttribute("data-theme")).toBe("dark");
    expect(metaContents()).toEqual(["#0b0b0d", "#0b0b0d"]);
    root().removeAttribute("data-theme");
    localStorage.setItem("jj.theme", "nonsense");
    new Function(script)();
    expect(root().hasAttribute("data-theme")).toBe(false);
  });
});
