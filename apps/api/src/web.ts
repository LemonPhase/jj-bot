// The built web app (`apps/web/dist`), so one process serves everything in
// production. `/api` and `/health` are never answered from here.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { serveStatic } from "@hono/node-server/serve-static";
import type { Context, Hono, MiddlewareHandler } from "hono";

/** Paths the API owns; static files and the SPA fallback never answer them. */
export const isApiPath = (path: string) =>
  path === "/api" ||
  path.startsWith("/api/") ||
  path === "/health" ||
  path.startsWith("/health/");

/** Static files from `root`, with long caching for Vite's hashed assets. */
export function webStatic(root: string): MiddlewareHandler {
  const files = serveStatic({ root });
  return async (c, next) => {
    if (isApiPath(c.req.path)) return next();
    const response = await files(c, next);
    if (response instanceof Response && response.ok)
      response.headers.set(
        "Cache-Control",
        c.req.path.startsWith("/assets/")
          ? "public, max-age=31536000, immutable"
          : "no-cache",
      );
    return response;
  };
}

/**
 * The SPA fallback: `index.html` for a page route (a GET for a path without a
 * file extension) that no file matched, so client-side routes survive reload.
 * Returns null when the request is not one.
 */
export function spaFallback(root: string) {
  let index: Promise<string> | undefined;
  return async (c: Context): Promise<Response | null> => {
    const { method, path } = c.req;
    if (method !== "GET" && method !== "HEAD") return null;
    if (isApiPath(path)) return null;
    if (/\.[^/]*$/.test(path.split("/").pop() ?? "")) return null;
    index ??= readFile(join(root, "index.html"), "utf8").catch((error) => {
      index = undefined;
      throw error;
    });
    c.header("Cache-Control", "no-cache");
    return c.html(await index);
  };
}

export function mountWeb(app: Hono, root: string) {
  app.use("*", webStatic(root));
}
