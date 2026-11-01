import react from "@vitejs/plugin-react";
import { defineConfig, type ProxyOptions } from "vite";
// The extensions keep the config loadable by Vite's native config loader.
import { apiTarget } from "./devEnv.ts";
import { closeClientWithUpstream } from "./devProxy.ts";

/**
 * `/api` and `/health` go to the API on loopback (`API_PORT` from the
 * environment or the repository root's `.env`, default 3001).
 * Server-sent event streams (`/api/stream`, `/api/tasks/:id/stream`) pass
 * through unbuffered. The upstream request is aborted when the browser closes
 * the stream, so the API does not keep writing to a dead socket, and the
 * browser's stream is destroyed when the upstream one closes or aborts, so an
 * API restart makes the UI reconnect instead of freezing silently.
 */
const apiProxy = (target: string): ProxyOptions => ({
  target,
  configure(proxy) {
    proxy.on("proxyReq", (proxyReq, _req, res) => {
      res.on("close", () => {
        if (!res.writableFinished) proxyReq.destroy();
      });
    });
    proxy.on("proxyRes", (proxyRes, _req, res) => {
      if (
        !String(proxyRes.headers["content-type"]).includes("text/event-stream")
      )
        return;
      // Tell any buffering layer in front of the dev server to stream as well.
      proxyRes.headers["cache-control"] = "no-cache, no-transform";
      proxyRes.headers["x-accel-buffering"] = "no";
      res.on("pipe", () => res.flushHeaders());
      closeClientWithUpstream(proxyRes, res);
    });
  },
});

export default defineConfig(({ mode }) => {
  const target = apiTarget(mode);
  return {
    plugins: [react()],
    server: {
      port: 5173,
      strictPort: true,
      proxy: {
        "/api": apiProxy(target),
        "/health": { target },
      },
    },
  };
});
