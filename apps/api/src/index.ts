import { serve } from "@hono/node-server";
import { createApp } from "./app";

const port = Number(process.env.API_PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("API_PORT must be a valid port.");
const hostname = process.env.API_HOST ?? "127.0.0.1";
const app = createApp({
  agentUrl: process.env.AGENT_URL ?? `http://127.0.0.1:${port}/api/agent`,
  modelConfigured: Boolean(
    process.env.GEMINI_API_KEY?.trim() && process.env.GEMINI_MODEL?.trim(),
  ),
});
const server = serve({ fetch: app.fetch, port, hostname }, () => {
  console.info(
    `JJ API listening at http://${hostname}:${port} (scaffold mode)`,
  );
});
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => server.close());
}
