import type { Page, Response, Route } from "@playwright/test";
import { createBot } from "./app";
import { expect, test } from "./fixtures";

// The installable web app: its manifest and icons, and the service worker
// (apps/web/public/sw.js), which caches the app shell and never API data.

interface Manifest {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  icons: { src: string; sizes: string; type: string; purpose: string }[];
}

/** Waits until the service worker is active and controls the page. */
async function controlled(page: Page) {
  await page.waitForFunction(
    () => navigator.serviceWorker.controller?.state === "activated",
  );
}

/** Every request URL in the app's caches, and the URL each stored response carries. */
function cached(page: Page) {
  return page.evaluate(async () => {
    const entries: { request: string; response: string }[] = [];
    for (const name of await caches.keys()) {
      const cache = await caches.open(name);
      for (const request of await cache.keys())
        entries.push({
          request: new URL(request.url).pathname,
          response: (await cache.match(request))?.url ?? "",
        });
    }
    return entries;
  });
}

/**
 * A proxy in front of the server answers every request the service worker
 * makes for `url` with `fault`, until it is fixed (`unrouteAll`); requests the
 * page makes itself pass. Returns how many the worker made. Every request, not
 * only the first: Chromium keeps no failed module fetch in its module map
 * (whatwg/html#10327), so a screen's `import()` fetches its chunk again when
 * the modulepreload Vite starts just before it has already failed.
 */
async function proxyFault(
  page: Page,
  url: RegExp,
  fault: (route: Route) => Promise<void>,
) {
  let requests = 0;
  await page.context().route(url, async (route) => {
    if (!route.request().serviceWorker()) return route.continue();
    requests += 1;
    await fault(route);
  });
  return () => requests;
}

/** The width and height a PNG's IHDR states. */
const pngSize = (bytes: Buffer) => ({
  png: bytes.subarray(1, 4).toString("ascii") === "PNG",
  width: bytes.readUInt32BE(16),
  height: bytes.readUInt32BE(20),
});

test("is installable: manifest, icons and a service worker that controls the page", async ({
  page,
  request,
  baseURL,
}) => {
  await createBot(request, "Nova");
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "Nova" }),
  ).toBeVisible();
  await controlled(page);

  const registration = await page.evaluate(async () => {
    const found = await navigator.serviceWorker.getRegistration();
    return { scope: found?.scope, script: found?.active?.scriptURL };
  });
  expect(registration).toEqual({
    scope: `${baseURL}/`,
    script: `${baseURL}/sw.js`,
  });

  // Chromium parses the manifest the page links, without errors.
  const cdp = await page.context().newCDPSession(page);
  const parsed = await cdp.send("Page.getAppManifest");
  expect(parsed.url).toBe(`${baseURL}/manifest.webmanifest`);
  expect(parsed.errors).toEqual([]);
  // Its installability verdict, where this build of Chromium gives one: a
  // Playwright context is always off the record, which alone is allowed.
  const { installabilityErrors } = await cdp.send(
    "Page.getInstallabilityErrors",
  );
  expect(
    installabilityErrors.filter((error) => error.errorId !== "in-incognito"),
  ).toEqual([]);

  const manifestHref = await page
    .locator('link[rel="manifest"]')
    .getAttribute("href");
  const manifestResponse = await request.get(manifestHref ?? "");
  expect(manifestResponse.headers()["content-type"]).toContain(
    "application/manifest+json",
  );
  const manifest = (await manifestResponse.json()) as Manifest;
  expect(manifest).toMatchObject({
    name: "JJ Bot",
    short_name: "JJ Bot",
    start_url: "/",
    scope: "/",
    display: "standalone",
  });
  const icons = new Map(
    manifest.icons.map((icon) => [`${icon.sizes} ${icon.purpose}`, icon]),
  );
  expect([...icons.keys()].sort()).toEqual([
    "192x192 any",
    "512x512 any",
    "512x512 maskable",
  ]);
  const touchIcon = await page
    .locator('link[rel="apple-touch-icon"]')
    .getAttribute("href");
  for (const { src, sizes, type } of [
    ...manifest.icons,
    { src: touchIcon ?? "", sizes: "180x180", type: "image/png" },
  ]) {
    const icon = await request.get(src);
    expect(icon.status(), src).toBe(200);
    expect(icon.headers()["content-type"], src).toBe(type);
    const [width, height] = sizes.split("x").map(Number);
    expect(pngSize(await icon.body()), src).toEqual({
      png: true,
      width,
      height,
    });
  }
});

test("serves the shell from its cache and never /api, even offline", async ({
  page,
  request,
}) => {
  await createBot(request, "Nova");
  // A token in an old link's address is dropped by the app, and must never
  // reach the cache either.
  await page.goto("/?token=not-for-the-cache");
  await expect(
    page.getByRole("heading", { level: 1, name: "Nova" }),
  ).toBeVisible();
  await controlled(page);
  // The first, uncontrolled load's fonts arrive first, so only the
  // reload's answers are counted below.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));

  const responses: Response[] = [];
  page.on("response", (response) => responses.push(response));
  await page.reload();
  await page.goto("/#/settings");
  await expect(
    page.getByRole("heading", { level: 1, name: "Settings" }),
  ).toBeVisible();

  const path = (response: Response) => new URL(response.url()).pathname;
  const api = responses.filter((response) => path(response).startsWith("/api"));
  // The workspace's reads and its event stream all went to the network.
  expect(api.map(path)).toEqual(
    expect.arrayContaining(["/api/bootstrap", "/api/stream", "/api/models"]),
  );
  for (const response of api)
    expect(response.fromServiceWorker(), path(response)).toBe(false);
  // The shell did come from the service worker, its scripts included.
  const shell = responses.filter(
    (response) =>
      path(response) === "/" || path(response).startsWith("/assets/"),
  );
  expect(shell.length).toBeGreaterThan(2);
  for (const response of shell)
    expect(response.fromServiceWorker(), path(response)).toBe(true);

  const stored = await cached(page);
  const entry = await page.locator('script[type="module"]').getAttribute("src");
  expect(stored.map((item) => item.request)).toEqual(
    expect.arrayContaining(["/index.html", entry]),
  );
  for (const item of stored) {
    expect(item.request).toMatch(/^\/(index\.html$|assets\/)/);
    expect(item.response).not.toContain("token");
  }

  // Offline the app still opens from the stored shell, and the API is not
  // answered from anywhere: the app says it could not start.
  const failed: string[] = [];
  page.on("requestfailed", (failure) => failed.push(failure.url()));
  await page.context().setOffline(true);
  const offline = await page.reload();
  expect(offline?.fromServiceWorker()).toBe(true);
  // The stored shell runs under the security headers the server sent with
  // it, so offline the page is no easier to frame or inject into.
  const served = (await request.get("/")).headers();
  const shellHeaders = offline?.headers() ?? {};
  expect(served["content-security-policy"]).toContain("frame-ancestors 'none'");
  for (const name of [
    "content-security-policy",
    "x-frame-options",
    "referrer-policy",
    "x-content-type-options",
  ])
    expect(shellHeaders[name], name).toBe(served[name]);
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
  // Its first API request, the sign-in state, went to the network and failed.
  expect(failed.map((url) => new URL(url).pathname)).toContain(
    "/api/auth/session",
  );
  await page.context().setOffline(false);
});

test("a new deploy shows on the next load: the page comes from the network first", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page).toHaveTitle("JJ Bot");
  await controlled(page);

  // The server now answers with another index.html, as after a deploy.
  await page.context().route(
    (url) => url.pathname === "/",
    async (route) => {
      const response = await route.fetch();
      const html = (await response.text()).replace(
        "<title>JJ Bot</title>",
        "<title>JJ Bot, deployed again</title>",
      );
      await route.fulfill({ response, body: html });
    },
  );
  const next = await page.reload();
  expect(next?.fromServiceWorker()).toBe(true);
  await expect(page).toHaveTitle("JJ Bot, deployed again");

  // And the cache follows the network: offline, the last shell opens.
  await expect
    .poll(() =>
      page.evaluate(async () =>
        (await (await caches.match("/index.html"))?.text())?.includes(
          "deployed again",
        ),
      ),
    )
    .toBe(true);
  await page.context().unrouteAll();
  await page.context().setOffline(true);
  await page.reload();
  await expect(page).toHaveTitle("JJ Bot, deployed again");
  await page.context().setOffline(false);

  // So does a proxy's error page while the server is down.
  await page.context().route(
    (url) => url.pathname === "/",
    (route) =>
      route.fulfill({
        status: 502,
        contentType: "text/html",
        body: "<title>Bad gateway</title>",
      }),
  );
  await page.reload();
  await expect(page).toHaveTitle("JJ Bot, deployed again");
  await page.context().unrouteAll();
});

// A bad answer must never stick: the worker keeps only what is really the
// app's file, so the app works again as soon as the server does.

test("an asset answered once with a web page is not kept: the next load works", async ({
  page,
  request,
}) => {
  await createBot(request, "Nova");
  const html = await (await request.get("/")).text();
  const entry = html.match(/<script type="module"[^>]*src="([^"]+)"/)?.[1];
  expect(entry).toMatch(/^\/assets\/index-[\w-]+\.js$/);
  // As the worker installs, a proxy answers its fetch of the entry script
  // with a maintenance page (200, HTML); the page itself is served fine.
  let answered = false;
  await page.context().route(
    (url) => url.pathname === entry,
    async (route) => {
      if (route.request().serviceWorker() && !answered) {
        answered = true;
        await route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<title>Down for maintenance</title>",
        });
      } else await route.continue();
    },
  );
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "Nova" }),
  ).toBeVisible();
  await controlled(page);
  expect(answered).toBe(true);
  await page.context().unrouteAll();

  // The server is healthy again: the app loads, from the network.
  await page.reload();
  await expect(
    page.getByRole("heading", { level: 1, name: "Nova" }),
  ).toBeVisible();
  // What the worker keeps under the entry's name now is the script.
  const kept = await page.evaluate(
    async (path) =>
      (await caches.match(path))?.headers.get("content-type") ?? null,
    entry ?? "",
  );
  expect(kept ?? "text/javascript").toContain("javascript");
});

test("a chunk redirected to a login page is not kept: the screen loads after a reload", async ({
  page,
  request,
}) => {
  await createBot(request, "Nova");
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "Nova" }),
  ).toBeVisible();
  await controlled(page);
  // A proxy sends the Settings chunk to its login page.
  const redirected = await proxyFault(
    page,
    /\/assets\/SettingsScreen-[\w-]+\.js$/,
    (route) => route.fulfill({ status: 302, headers: { location: "/login" } }),
  );
  await page.goto("/#/settings");
  await expect
    .poll(redirected, {
      message: "the worker's fetch of the Settings chunk reached the proxy",
    })
    .toBeGreaterThan(0);
  // This time the screen cannot load, and says so.
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
  await page.context().unrouteAll();

  await page.reload();
  await expect(
    page.getByRole("heading", { level: 1, name: "Settings" }),
  ).toBeVisible();
});

test("a chunk labelled JavaScript whose body is a web page is not kept", async ({
  page,
  request,
}) => {
  await createBot(request, "Nova");
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "Nova" }),
  ).toBeVisible();
  await controlled(page);
  // A proxy answers the Settings chunk with its login page, mislabelled.
  const answered = await proxyFault(
    page,
    /\/assets\/SettingsScreen-[\w-]+\.js$/,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/javascript",
        body: "﻿\n  <!doctype html><title>Sign in</title>",
      }),
  );
  await page.goto("/#/settings");
  await expect
    .poll(answered, {
      message: "the worker's fetch of the Settings chunk reached the proxy",
    })
    .toBeGreaterThan(0);
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
  await page.context().unrouteAll();

  await page.reload();
  await expect(
    page.getByRole("heading", { level: 1, name: "Settings" }),
  ).toBeVisible();
});

test("a page that is not the app is never kept as the offline shell", async ({
  page,
  request,
}) => {
  await createBot(request, "Nova");
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "Nova" }),
  ).toBeVisible();
  await controlled(page);
  // A proxy's maintenance page, answered 200: shown, as the network said.
  await page.context().route(
    (url) => url.pathname === "/",
    (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html",
        body: "<!doctype html><title>Down for maintenance</title>",
      }),
    { times: 1 },
  );
  await page.reload();
  await expect(page).toHaveTitle("Down for maintenance");
  await page.context().unrouteAll();

  // Offline, the app's own shell opens, not the maintenance page.
  await page.context().setOffline(true);
  await page.reload();
  await expect(page).toHaveTitle("JJ Bot");
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
  await page.context().setOffline(false);
});

test("offline, the app says the API is unreachable and never shows the demo data instead", async ({
  page,
  request,
}) => {
  await createBot(request, "Nova");
  await page.goto("/");
  await expect(
    page.getByRole("heading", { level: 1, name: "Nova" }),
  ).toBeVisible();
  await controlled(page);
  // Once opened with ?demo under the worker, the demo chunk has loaded...
  const demoChunk = page.waitForRequest(/\/assets\/demoApi-[\w-]+\.js$/);
  await page.goto("/?demo");
  await demoChunk;
  await expect(page.getByText("Demo data").first()).toBeVisible();
  // ...but the worker does not keep it.
  expect(
    (await cached(page)).some((item) => item.request.includes("demoApi")),
  ).toBe(false);

  await page.context().setOffline(true);
  await page.goto("/");
  await expect(page.getByText("The JJ Bot API isn't reachable.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
  await expect(page.getByText("Demo data")).toHaveCount(0);
  await page.context().setOffline(false);
});
