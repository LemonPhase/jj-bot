import {
  type RefObject,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { useMediaQuery } from "../../lib/media";

/** Whether the user asked for reduced motion; follows changes live. */
export function useReducedMotion(): boolean {
  return useMediaQuery("(prefers-reduced-motion: reduce)");
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
