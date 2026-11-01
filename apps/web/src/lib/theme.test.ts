import { describe, expect, it } from "vitest";
import {
  applyThemePreference,
  readThemePreference,
  resolveTheme,
  THEME_STORAGE_KEY,
  writeThemePreference,
} from "./theme";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
}

const throwingStorage = {
  getItem: (): string | null => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
};

describe("theme preference storage", () => {
  it("reads a stored choice and defaults to system", () => {
    expect(
      readThemePreference(memoryStorage({ [THEME_STORAGE_KEY]: "dark" })),
    ).toBe("dark");
    expect(readThemePreference(memoryStorage())).toBe("system");
    expect(
      readThemePreference(memoryStorage({ [THEME_STORAGE_KEY]: "sepia" })),
    ).toBe("system");
    expect(readThemePreference(null)).toBe("system");
  });

  it("survives storage that throws", () => {
    expect(readThemePreference(throwingStorage)).toBe("system");
    expect(writeThemePreference("dark", throwingStorage)).toBe(false);
    expect(writeThemePreference("dark", null)).toBe(false);
  });

  it("stores explicit choices and clears the key for system", () => {
    const storage = memoryStorage();
    expect(writeThemePreference("light", storage)).toBe(true);
    expect(storage.data.get(THEME_STORAGE_KEY)).toBe("light");
    writeThemePreference("system", storage);
    expect(storage.data.has(THEME_STORAGE_KEY)).toBe(false);
  });
});

describe("resolveTheme", () => {
  it("follows the OS only for system", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });
});

describe("applyThemePreference", () => {
  it("sets data-theme for a choice and removes it for system", () => {
    const attributes = new Map<string, string>();
    const root = {
      setAttribute: (name: string, value: string) =>
        void attributes.set(name, value),
      removeAttribute: (name: string) => void attributes.delete(name),
    };
    applyThemePreference("dark", root);
    expect(attributes.get("data-theme")).toBe("dark");
    applyThemePreference("light", root);
    expect(attributes.get("data-theme")).toBe("light");
    applyThemePreference("system", root);
    expect(attributes.has("data-theme")).toBe(false);
  });
});
