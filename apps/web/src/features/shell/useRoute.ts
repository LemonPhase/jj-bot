import { useMemo, useSyncExternalStore } from "react";
import { parseRoute, type Route, routeHref } from "./router";

/**
 * Binds the hash routes in ./router.ts to the window. One module-level store,
 * so every `useRoute()` caller agrees. Plain `<a href={taskHref(id)}>` links
 * work too: the browser updates the hash and fires `hashchange`.
 */

const listeners = new Set<() => void>();

const currentHash = () =>
  typeof window === "undefined" ? "" : window.location.hash;

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("hashchange", notify);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("hashchange", notify);
  };
}

export interface NavigateOptions {
  /** Replace the current history entry instead of adding one (redirects, fixes). */
  replace?: boolean;
}

/** Goes to a route. A no-op when it is already the current one. */
export function navigate(route: Route, options: NavigateOptions = {}): void {
  const href = routeHref(route);
  if (href === currentHash()) return;
  if (options.replace) {
    // replaceState does not fire hashchange, so tell subscribers directly.
    window.history.replaceState(window.history.state, "", href);
    notify();
  } else {
    window.location.hash = href;
  }
}

/** The current route; re-renders when the hash changes. */
export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, currentHash, () => "");
  return useMemo(() => parseRoute(hash), [hash]);
}
