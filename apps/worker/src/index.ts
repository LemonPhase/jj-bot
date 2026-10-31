import { BackendService } from "@jj/backend";
import { openStore } from "@jj/db";
import { GeminiSessionExecutor } from "@jj/runtime";

if (process.env.JJ_EMBED_WORKER !== "false") {
  console.info(
    "Worker runs inside the API by default. Set JJ_EMBED_WORKER=false to use this separate PostgreSQL worker.",
  );
} else {
  if (process.env.JJ_DATABASE_MODE === "pglite")
    throw new Error(
      "Separate workers require PostgreSQL; embedded PGlite has one owning process.",
    );
  const store = await openStore({
    mode: "postgres",
    connectionString:
      process.env.DATABASE_URL ??
      "postgresql://jj:jj_local@localhost:5433/jj_bot",
  });
  const service = new BackendService({
    store,
    executor: new GeminiSessionExecutor({
      apiKey: process.env.GEMINI_API_KEY ?? "",
      model: process.env.GEMINI_MODEL ?? "",
    }),
    concurrency: Number(process.env.JJ_CONCURRENCY ?? 3),
  });
  service.start();
  console.info("JJ PostgreSQL worker started.");
  let stopping = false;
  async function stop() {
    if (stopping) return;
    stopping = true;
    await service.stop();
    await store.close();
  }
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}
