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

/** The hash last seen, and the one before it (for "return to where I was"). */
let lastHash = currentHash();
let previousHash: string | null = null;

/** Notes a hash change. A replaced entry (a redirect) is not somewhere to return to. */
function record(replaced: boolean) {
  const next = currentHash();
  if (next === lastHash) return;
  if (!replaced) previousHash = lastHash;
  lastHash = next;
}

function notify() {
  for (const listener of listeners) listener();
}

function onHashChange() {
  record(false);
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) window.addEventListener("hashchange", onHashChange);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0)
      window.removeEventListener("hashchange", onHashChange);
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
    record(true);
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

/**
 * The route shown before the current one, for Cancel buttons; null after a
 * reload or when the app opened on this route.
 */
export function previousRoute(): Route | null {
  return previousHash === null ? null : parseRoute(previousHash);
}
