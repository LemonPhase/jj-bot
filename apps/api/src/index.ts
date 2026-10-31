import { serve } from "@hono/node-server";
import { BackendService } from "@jj/backend";
import { openStore } from "@jj/db";
import { GeminiSessionExecutor } from "@jj/runtime";
import { createApp } from "./app";

const port = Number(process.env.API_PORT ?? 3001);
if (!Number.isInteger(port) || port < 1 || port > 65535)
  throw new Error("API_PORT must be a valid port.");
const hostname = process.env.API_HOST ?? "127.0.0.1";
if (
  !["127.0.0.1", "localhost", "::1"].includes(hostname) &&
  !process.env.API_TOKEN
)
  throw new Error("API_TOKEN is required when listening beyond loopback.");
const mode = process.env.JJ_DATABASE_MODE === "pglite" ? "pglite" : "postgres";
const store = await openStore({
  mode,
  path: process.env.JJ_DATABASE_PATH ?? "../../.jj-data",
  connectionString:
    process.env.DATABASE_URL ??
    "postgresql://jj:jj_local@localhost:5433/jj_bot",
});
const apiKey = process.env.GEMINI_API_KEY?.trim() ?? "";
const model = process.env.GEMINI_MODEL?.trim() ?? "";
const service = new BackendService({
  store,
  executor: new GeminiSessionExecutor({ apiKey, model }),
  concurrency: Number(process.env.JJ_CONCURRENCY ?? 3),
});
if (process.env.JJ_EMBED_WORKER !== "false") service.start();
const app = createApp({
  agentUrl: process.env.AGENT_URL ?? `http://127.0.0.1:${port}/api/agent`,
  modelConfigured: Boolean(apiKey && model),
  service,
  apiToken: process.env.API_TOKEN,
});
const server = serve({ fetch: app.fetch, port, hostname }, () =>
  console.info(`JJ backend listening at http://${hostname}:${port} (${mode})`),
);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  await service.stop();
  await store.close();
}
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
