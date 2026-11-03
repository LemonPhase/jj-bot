/*
 * JJ Bot's service worker. It caches the app shell and nothing else:
 *
 * - `/api/*` and `/health*` (JSON, files and the event streams), other
 *   origins and every method but GET are never handled. They go to the
 *   network exactly as without a service worker, and nothing they return is
 *   stored, so the cache never holds API data or a token.
 * - Page loads are network first: the server's index.html whenever it
 *   answers, so a deploy shows on the next load as it would without a
 *   service worker. Each one is stored as the shell; the stored shell is
 *   served only when the network fails or the server answers with a 5xx
 *   (down behind a proxy), so the app still opens and says so.
 * - `/assets/*` are Vite's content-hashed files: a name never changes
 *   content, so a stored one is served without asking, and one not stored
 *   yet is fetched and stored.
 *
 * A fetched shell that differs from the stored one (a deploy) is stored once
 * the assets it loads first are, so the stored shell always has its assets
 * (and a failed attempt is retried on the next load); then stored assets the
 * server no longer has are dropped. Registered by src/lib/serviceWorker.ts
 * in production builds only; the browser suite checks this behaviour
 * (apps/web/e2e/pwa.e2e.ts).
 */
const CACHE = "jj-shell-v1";
const SHELL = "/index.html";

const isApi = (path) =>
  path === "/api" ||
  path.startsWith("/api/") ||
  path === "/health" ||
  path.startsWith("/health/");

/** A page route the server answers with index.html: no file extension. */
const isPageRoute = (path) => !/\.[^/]*$/.test(path.split("/").pop() ?? "");

const isHtml = (response) =>
  (response.headers.get("content-type") ?? "").includes("text/html");

/** The `/assets/` files index.html loads first: its script, preloads, styles. */
const shellAssets = (html) => [
  ...new Set(
    [...html.matchAll(/\s(?:src|href)="(\/assets\/[^"?#]+)"/g)].map(
      ([, path]) => path,
    ),
  ),
];

async function storeShell(html) {
  const cache = await caches.open(CACHE);
  const stored = await cache.match(SHELL);
  if (stored && (await stored.text()) === html) return;
  const assets = shellAssets(html);
  // Throws when one does not arrive: the old shell, whose assets are stored,
  // stays until a later load stores this one whole.
  await Promise.all(
    assets.map(async (path) => {
      if (await cache.match(path)) return;
      const response = await fetch(path);
      if (!response.ok) throw new Error(`${path}: ${response.status}`);
      await cache.put(path, response);
    }),
  );
  // A response of its own, with no URL: the address it was loaded from, a
  // `?token=` included, never reaches the cache.
  await cache.put(
    SHELL,
    new Response(html, {
      headers: { "content-type": "text/html; charset=utf-8" },
    }),
  );
  const keep = new Set(assets);
  const others = (await cache.keys()).filter((request) => {
    const path = new URL(request.url).pathname;
    return path.startsWith("/assets/") && !keep.has(path);
  });
  await Promise.all(
    others.map(async (request) => {
      const head = await fetch(request.url, {
        method: "HEAD",
        cache: "no-store",
      }).catch(() => null);
      if (head?.status === 404) await cache.delete(request);
    }),
  );
}

async function storedShell(path) {
  return isPageRoute(path)
    ? caches.match(SHELL, { cacheName: CACHE })
    : undefined;
}

async function page(event) {
  const path = new URL(event.request.url).pathname;
  let response;
  try {
    response = await fetch(event.request);
  } catch (error) {
    const stored = await storedShell(path);
    if (stored) return stored;
    throw error;
  }
  if (response.status >= 500) return (await storedShell(path)) ?? response;
  if (response.ok && isHtml(response) && isPageRoute(path))
    event.waitUntil(
      response
        .clone()
        .text()
        .then(storeShell)
        .catch(() => {}),
    );
  return response;
}

async function asset(event) {
  const cache = await caches.open(CACHE);
  const stored = await cache.match(event.request);
  if (stored) return stored;
  const response = await fetch(event.request);
  if (response.status === 200 && response.type === "basic")
    event.waitUntil(cache.put(event.request, response.clone()));
  return response;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    fetch("/", { cache: "no-store" })
      .then((response) =>
        response.ok && isHtml(response)
          ? response.text().then(storeShell)
          : undefined,
      )
      .catch(() => {})
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith("jj-shell-") && key !== CACHE)
          await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || isApi(url.pathname)) return;
  if (request.mode === "navigate") event.respondWith(page(event));
  else if (url.pathname.startsWith("/assets/") && !request.headers.has("range"))
    event.respondWith(asset(event));
});
