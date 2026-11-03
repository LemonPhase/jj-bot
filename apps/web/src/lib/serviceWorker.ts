/**
 * Registers the service worker (`public/sw.js`, which caches only the app
 * shell) so the app can be installed and opens offline. Production builds
 * only: the dev server and unit tests never register it, so a stale worker
 * can never stand between a developer and their edits. It waits for the
 * page's `load`, so it never competes with the first screen's downloads.
 * `updateViaCache: "none"` has the browser look for a new worker on every
 * load, past the HTTP cache. A browser that refuses (no support, a private
 * window, storage off) runs the app as before, without one.
 */
export function registerServiceWorker(
  production: boolean = import.meta.env.PROD,
): void {
  if (!production || !("serviceWorker" in navigator)) return;
  const register = () => {
    navigator.serviceWorker
      .register("/sw.js", { scope: "/", updateViaCache: "none" })
      .catch((error: unknown) => {
        console.warn("The service worker was not registered:", error);
      });
  };
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}
