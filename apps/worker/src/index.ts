// The standalone worker: the API's wiring without HTTP. It claims and runs
// jobs from PostgreSQL next to an API started with JJ_EMBED_WORKER=false.
// PGlite is single-process, so it is refused.
import { ConfigError, loadWorkerConfig } from "@jj/api/config";
import { openServices } from "@jj/api/wiring";
import { configureOutboundProxy } from "@jj/runtime";

const SHUTDOWN_TIMEOUT_MS = 20_000;

async function main() {
  const env = process.env;
  const config = loadWorkerConfig(env);
  const proxy = configureOutboundProxy(env);
  const { engine, database } = await openServices(config, env);
  await engine.worker.start();
  const { drivers } = await engine.drivers();
  console.info(
    `[worker] JJ Bot worker running · database postgres · drivers ${drivers
      .map((info) => `${info.id}${info.available ? "" : " (unavailable)"}`)
      .join(", ")} · concurrency ${engine.context.config.concurrency}`,
  );

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) {
      console.error(`[worker] ${signal} again: exiting now.`);
      process.exit(1);
    }
    stopping = true;
    console.info(
      `[worker] ${signal}: handing running work back and shutting down.`,
    );
    setTimeout(() => {
      console.error("[worker] Shutdown timed out: exiting.");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    (async () => {
      await engine.worker.stop();
      await database.close();
      await proxy?.restore();
    })().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error("[worker] Shutdown failed:", error);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError)
    console.error(`JJ Bot worker: ${error.message}`);
  else
    console.error(
      "JJ Bot worker failed to start:",
      error instanceof Error ? error.message : error,
    );
  process.exit(1);
});
