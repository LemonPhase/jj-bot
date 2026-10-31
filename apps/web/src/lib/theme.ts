import { useSyncExternalStore } from "react";

/**
 * Theme preference: explicit dark or light, or "system" (no `data-theme`
 * attribute, so tokens.css follows `prefers-color-scheme`). The preference is
 * stored in localStorage and applied to <html> as `data-theme`.
 *
 * State lives in one module-level store, so every `useTheme()` caller (the
 * sidebar toggle, a settings control) stays in sync, including across tabs.
 * The stored preference is applied as soon as this module loads, before React
 * renders, to avoid a flash of the wrong theme.
 */

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "jj.theme";
const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";

type ReadableStorage = Pick<Storage, "getItem">;
type WritableStorage = Pick<Storage, "setItem" | "removeItem">;

const isPreference = (value: unknown): value is ThemePreference =>
  value === "light" || value === "dark" || value === "system";

/** localStorage, or null where it is unavailable (privacy mode, sandboxed frames, tests). */
function browserStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** The stored preference; "system" when nothing valid is stored or storage throws. */
export function readThemePreference(
  storage: ReadableStorage | null = browserStorage(),
): ThemePreference {
  try {
    const value = storage?.getItem(THEME_STORAGE_KEY);
    return isPreference(value) ? value : "system";
  } catch {
    return "system";
  }
}

/** Stores the preference ("system" clears it). Returns false when storage refused. */
export function writeThemePreference(
  preference: ThemePreference,
  storage: WritableStorage | null = browserStorage(),
): boolean {
  if (!storage) return false;
  try {
    if (preference === "system") storage.removeItem(THEME_STORAGE_KEY);
    else storage.setItem(THEME_STORAGE_KEY, preference);
    return true;
  } catch {
    return false;
  }
}

/** The theme actually shown for a preference. */
export function resolveTheme(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === "system") return systemPrefersDark ? "dark" : "light";
  return preference;
}

/** Sets `data-theme` for an explicit choice and removes it for "system". */
export function applyThemePreference(
  preference: ThemePreference,
  root: Pick<
    HTMLElement,
    "setAttribute" | "removeAttribute"
  > | null = typeof document === "undefined" ? null : document.documentElement,
): void {
  if (!root) return;
  if (preference === "system") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", preference);
}

function systemPrefersDark(): boolean {
  try {
    return (
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia(SYSTEM_DARK_QUERY).matches
    );
  } catch {
    return false;
  }
}

interface ThemeSnapshot {
  preference: ThemePreference;
  resolved: ResolvedTheme;
}

const listeners = new Set<() => void>();
let snapshot: ThemeSnapshot = (() => {
  const preference = readThemePreference();
  return {
    preference,
    resolved: resolveTheme(preference, systemPrefersDark()),
  };
})();
applyThemePreference(snapshot.preference);

function update(preference: ThemePreference): void {
  const resolved = resolveTheme(preference, systemPrefersDark());
  if (preference === snapshot.preference && resolved === snapshot.resolved)
    return;
  snapshot = { preference, resolved };
  applyThemePreference(preference);
  for (const listener of listeners) listener();
}

/** Follows the OS theme and other tabs' choices. Returns the cleanup. */
function watchEnvironment(): () => void {
  const onSystemChange = () => update(snapshot.preference);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === THEME_STORAGE_KEY)
      update(readThemePreference());
  };
  let media: MediaQueryList | null = null;
  try {
    media = window.matchMedia?.(SYSTEM_DARK_QUERY) ?? null;
  } catch {
    media = null;
  }
  media?.addEventListener("change", onSystemChange);
  window.addEventListener("storage", onStorage);
  // Catch changes made while nobody was listening.
  update(readThemePreference());
  return () => {
    media?.removeEventListener("change", onSystemChange);
    window.removeEventListener("storage", onStorage);
  };
}

let stopWatching: (() => void) | null = null;

/** Watches the environment while at least one component is subscribed. */
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!stopWatching && typeof window !== "undefined")
    stopWatching = watchEnvironment();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && stopWatching) {
      stopWatching();
      stopWatching = null;
    }
  };
}

const getSnapshot = () => snapshot;

export interface ThemeState {
  /** What the user chose. */
  preference: ThemePreference;
  /** What is on screen ("system" resolved through prefers-color-scheme). */
  resolved: ResolvedTheme;
  setPreference: (preference: ThemePreference) => void;
  /** Switches to the explicit opposite of what is on screen. */
  toggle: () => void;
}

function setPreference(preference: ThemePreference): void {
  writeThemePreference(preference);
  update(preference);
}

function toggle(): void {
  setPreference(snapshot.resolved === "dark" ? "light" : "dark");
}

/**
 * The current theme and setters.
 *
 * @example const { resolved, toggle } = useTheme();
 */
export function useTheme(): ThemeState {
  const { preference, resolved } = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getSnapshot,
  );
  return { preference, resolved, setPreference, toggle };
}
