import {
  type RefObject,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function reducedMotionQuery(): MediaQueryList | null {
  try {
    return typeof window !== "undefined" &&
      typeof window.matchMedia === "function"
      ? window.matchMedia(REDUCED_MOTION)
      : null;
  } catch {
    return null;
  }
}

function subscribeReducedMotion(listener: () => void): () => void {
  const query = reducedMotionQuery();
  query?.addEventListener("change", listener);
  return () => query?.removeEventListener("change", listener);
}

/** Whether the user asked for reduced motion; follows changes live. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    () => reducedMotionQuery()?.matches ?? false,
    () => false,
  );
}

function subscribeVisibility(listener: () => void): () => void {
  document.addEventListener("visibilitychange", listener);
  return () => document.removeEventListener("visibilitychange", listener);
}

/** Whether the page is visible (not a background tab). */
export function usePageVisible(): boolean {
  return useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState !== "hidden",
    () => true,
  );
}

/**
 * Whether an element should animate: the page is visible and the element is
 * at least partly on screen. Views stop their clocks when this is false.
 */
export function usePageActive(ref: RefObject<Element | null>): boolean {
  const visible = usePageVisible();
  const [onScreen, setOnScreen] = useState(true);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries.at(-1);
      if (entry) setOnScreen(entry.isIntersecting);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return visible && onScreen;
}
