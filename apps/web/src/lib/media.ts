import { useCallback, useSyncExternalStore } from "react";

/**
 * Phone widths: the layout breakpoint the stylesheets use (`max-width: 759px`).
 * Below it the sidebar becomes a menu drawer, controls grow to 44px touch
 * targets and the 3D office is not offered. Keep the CSS in step.
 */
export const NARROW_QUERY = "(max-width: 759px)";

/** One MediaQueryList per query, so renders do not build new ones. */
const lists = new Map<string, MediaQueryList | null>();

function mediaQuery(query: string): MediaQueryList | null {
  if (lists.has(query)) return lists.get(query) ?? null;
  let list: MediaQueryList | null = null;
  try {
    list =
      typeof window !== "undefined" && typeof window.matchMedia === "function"
        ? window.matchMedia(query)
        : null;
  } catch {
    list = null;
  }
  lists.set(query, list);
  return list;
}

/** Forgets the MediaQueryLists, for tests that replace `window.matchMedia`. */
export function resetMediaQueries(): void {
  lists.clear();
}

/** Whether `query` matches; follows changes live. False where it cannot be asked. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (listener: () => void) => {
      const list = mediaQuery(query);
      list?.addEventListener("change", listener);
      return () => list?.removeEventListener("change", listener);
    },
    [query],
  );
  const matches = useCallback(
    () => mediaQuery(query)?.matches ?? false,
    [query],
  );
  return useSyncExternalStore(subscribe, matches, () => false);
}
