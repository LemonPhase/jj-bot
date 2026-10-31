import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv, type ProxyOptions } from "vite";

/**
 * `/api` and `/health` go to the API on loopback (`API_PORT`, default 3001).
 * Server-sent event streams (`/api/stream`, `/api/tasks/:id/stream`) pass
 * through unbuffered, and the upstream request is aborted when the browser
 * closes the stream so the API does not keep writing to a dead socket.
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
    });
  },
});

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = `http://127.0.0.1:${env.API_PORT || "3001"}`;
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
