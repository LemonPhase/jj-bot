import { useSyncExternalStore } from "react";

/**
 * Phone widths: the layout breakpoint the stylesheets use (`max-width: 759px`).
 * Below it the sidebar becomes a menu drawer, controls grow to 44px touch
 * targets and the 3D office is not offered. Keep the CSS in step.
 */
export const NARROW_QUERY = "(max-width: 759px)";

function mediaQuery(query: string): MediaQueryList | null {
  try {
    return typeof window !== "undefined" &&
      typeof window.matchMedia === "function"
      ? window.matchMedia(query)
      : null;
  } catch {
    return null;
  }
}

/** Whether `query` matches; follows changes live. False where it cannot be asked. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (listener) => {
      const media = mediaQuery(query);
      media?.addEventListener("change", listener);
      return () => media?.removeEventListener("change", listener);
    },
    () => mediaQuery(query)?.matches ?? false,
    () => false,
  );
}
