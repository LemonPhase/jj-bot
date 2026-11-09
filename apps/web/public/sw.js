/*
 * JJ Bot's service worker. It caches the app shell and nothing else:
 *
 * - `/api/*` and `/health*` (JSON, files and the event streams), other
 *   origins and every method but GET are never handled. They go to the
 *   network exactly as without a service worker, and nothing they return is
 *   stored, so the cache never holds API data or a token.
 * - Page loads are network first: the server's answer whenever it answers,
 *   so a deploy shows on the next load as it would without a service worker.
 *   An answer that is the app's own index.html (not redirected, and loading
 *   a hashed entry script) is stored as the shell; the stored shell is
 *   served only when the network fails or the server answers with a 5xx
 *   (down behind a proxy), so the app still opens and says so. It keeps the
 *   security headers it was answered with (its Content-Security-Policy and
 *   the others in SECURITY_HEADERS) and no other, so it runs under the same
 *   policy offline as online.
 * - Vite's content-hashed build files (`/assets/<name>-<hash>.<ext>`) never
 *   change content under a name, so a stored one is served without asking,
 *   and one not stored yet is fetched and stored if the answer is really
 *   that file: a 200, not redirected, of the type a known extension calls
 *   for (never a web page), and for scripts, styles and JSON a body that is
 *   not markup. Anything else under `/assets/` goes to the network. The demo data's
 *   chunk is never stored: the app must not open on it without the API.
 *
 * A fetched shell that differs from the stored one (a deploy) is stored once
 * the assets it loads first are, so the stored shell always has its assets
 * (and a failed attempt is retried on the next load); then stored assets
 * that neither the stored shell loads nor the server still has are dropped.
 *
 * Recovery: a release that bumps CACHE makes every browser drop the old
 * caches when the new worker activates. Registered by
 * src/lib/serviceWorker.ts in production builds only; the browser suite
 * checks this behaviour (apps/web/e2e/pwa.e2e.ts).
 */
const CACHE = "jj-shell-v2";
const SHELL = "/index.html";

/** The headers the stored shell keeps from the answer it was stored from. */
const SECURITY_HEADERS = [
  "content-security-policy",
  "x-frame-options",
  "referrer-policy",
  "x-content-type-options",
];

/** The stored shell's headers: its type and the answer's security headers. */
function shellHeaders(headers) {
  const kept = new Headers({ "content-type": "text/html; charset=utf-8" });
  for (const name of SECURITY_HEADERS) {
    const value = headers.get(name);
    if (value !== null) kept.set(name, value);
  }
  return kept;
}

/** Whether a stored shell already is this page with these headers. */
async function isStored(stored, html, headers) {
  if (!stored || (await stored.text()) !== html) return false;
  return SECURITY_HEADERS.every(
    (name) => stored.headers.get(name) === headers.get(name),
  );
}

const isApi = (path) =>
  path === "/api" ||
  path.startsWith("/api/") ||
  path === "/health" ||
  path.startsWith("/health/");

/** A page route the server answers with index.html: no file extension. */
const isPageRoute = (path) => !/\.[^/]*$/.test(path.split("/").pop() ?? "");

/** Vite's hashed build file name: `/assets/<name>-<8-character hash>.<ext>`. */
const HASHED = /^\/assets\/[^/]+-[\w-]{8}\.[a-z0-9]+$/;

/** The demo data's chunk (src/api/demoApi.ts), never stored. */
const DEMO = /^\/assets\/demoApi-/;

const isCacheable = (path) => HASHED.test(path) && !DEMO.test(path);

const contentType = (response) =>
  (response.headers.get("content-type") ?? "").toLowerCase();

/** The types an asset may be served as, by extension; never a web page. */
const TYPES = {
  js: /javascript/,
  mjs: /javascript/,
  css: /^text\/css/,
  woff2: /^font\/woff2/,
  woff: /^font\/woff/,
  ttf: /^font\/ttf/,
  otf: /^font\/otf/,
  png: /^image\/png/,
  jpg: /^image\/jpeg/,
  jpeg: /^image\/jpeg/,
  gif: /^image\/gif/,
  webp: /^image\/webp/,
  avif: /^image\/avif/,
  svg: /^image\/svg\+xml/,
  json: /json/,
  wasm: /^application\/wasm/,
};

/** Text assets, whose body must not be markup whatever its label says. */
const TEXT = new Set(["js", "mjs", "css", "json"]);

/** Whether a text body starts with `<` (after a BOM or spaces): markup. */
async function looksLikeMarkup(response) {
  const reader = response.clone().body?.getReader();
  if (!reader) return false;
  const { value } = await reader.read();
  reader.cancel().catch(() => {});
  const start = new TextDecoder()
    .decode(value ?? new Uint8Array())
    .replace(/^﻿/, "")
    .trimStart();
  return start.startsWith("<");
}

/**
 * Whether `response` is really the asset at `path`, and so may be stored: a
 * 200, not redirected, of a known extension's type, and, for scripts,
 * styles and JSON, a body that is not markup. Anything else is refused.
 */
async function isAsset(path, response) {
  if (response.status !== 200 || response.redirected) return false;
  if (response.type !== "basic" && response.type !== "default") return false;
  const type = contentType(response);
  if (type.includes("text/html")) return false;
  const extension = path.split(".").pop() ?? "";
  const expected = TYPES[extension];
  if (!expected?.test(type)) return false;
  return !(TEXT.has(extension) && (await looksLikeMarkup(response)));
}

/** The hashed entry script the app's own index.html loads. */
const ENTRY =
  /<script\b[^>]*\btype="module"[^>]*\bsrc="\/assets\/[^"/]+-[\w-]{8}\.js"/;

/** Whether `response` is the app's index.html, so may become the shell. */
const isShell = (response) =>
  response.status === 200 &&
  !response.redirected &&
  contentType(response).includes("text/html");

/** The `/assets/` files index.html loads first: its script, preloads, styles. */
const shellAssets = (html) => [
  ...new Set(
    [...html.matchAll(/\s(?:src|href)="(\/assets\/[^"?#]+)"/g)]
      .map(([, path]) => path)
      .filter(isCacheable),
  ),
];

/** The assets the stored shell loads first; none without one. */
async function storedAssets(cache) {
  const stored = await cache.match(SHELL);
  return new Set(stored ? shellAssets(await stored.text()) : []);
}

async function storeShell(html, answered) {
  if (!ENTRY.test(html)) return;
  const headers = shellHeaders(answered);
  const cache = await caches.open(CACHE);
  if (await isStored(await cache.match(SHELL), html, headers)) return;
  const assets = shellAssets(html);
  // Throws when one does not arrive whole: the old shell, whose assets are
  // stored, stays until a later load stores this one.
  await Promise.all(
    assets.map(async (path) => {
      if (await cache.match(path)) return;
      const response = await fetch(path);
      if (!(await isAsset(path, response)))
        throw new Error(`${path}: not the asset (${response.status})`);
      await cache.put(path, response);
    }),
  );
  // A response of its own, with no URL: the address it was loaded from, a
  // query (an old link's `?token=` too), never reaches the cache.
  await cache.put(SHELL, new Response(html, { headers }));
  const others = (await cache.keys()).filter((request) => {
    const path = new URL(request.url).pathname;
    return path.startsWith("/assets/") && !assets.includes(path);
  });
  await Promise.all(
    others.map(async (request) => {
      const head = await fetch(request.url, {
        method: "HEAD",
        cache: "no-store",
      }).catch(() => null);
      if (head?.status !== 404) return;
      // Another load may have stored a shell that loads it since.
      if ((await storedAssets(cache)).has(new URL(request.url).pathname))
        return;
      await cache.delete(request);
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
  if (isPageRoute(path) && isShell(response))
    event.waitUntil(
      response
        .clone()
        .text()
        .then((html) => storeShell(html, response.headers))
        .catch(() => {}),
    );
  return response;
}

async function asset(event) {
  const path = new URL(event.request.url).pathname;
  const cache = await caches.open(CACHE);
  const stored = await cache.match(event.request);
  if (stored) return stored;
  const response = await fetch(event.request);
  if (await isAsset(path, response))
    event.waitUntil(cache.put(event.request, response.clone()));
  return response;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    fetch("/", { cache: "no-store" })
      .then((response) =>
        isShell(response)
          ? response.text().then((html) => storeShell(html, response.headers))
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
  else if (isCacheable(url.pathname) && !request.headers.has("range"))
    event.respondWith(asset(event));
});
