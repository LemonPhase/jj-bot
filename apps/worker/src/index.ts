// The standalone worker: the API's wiring without HTTP. It claims and runs
// jobs from PostgreSQL next to an API started with JJ_EMBED_WORKER=false.
// PGlite is single-process, so it is refused. It logs like the API and
// exports traces when OTEL_EXPORTER_OTLP_ENDPOINT is set; it serves no
// metrics, so its runs are not in the API's `/metrics`.
import { ConfigError, loadWorkerConfig } from "@jj/api/config";
import { startTracing } from "@jj/api/tracing";
import { openServices } from "@jj/api/wiring";
import { createLogger, logSettings } from "@jj/backend";
import { configureOutboundProxy } from "@jj/runtime";

const SHUTDOWN_TIMEOUT_MS = 20_000;

const logger = createLogger(logSettings(process.env, true));

async function main() {
  const env = process.env;
  const config = loadWorkerConfig(env);
  const tracing = await startTracing(env, "jj-worker", logger);
  if (tracing) logger.info(`Exporting traces over OTLP to ${tracing.url}`);
  const proxy = configureOutboundProxy(env);
  const { engine, database, models } = await openServices(config, env, logger, {
    ...(tracing ? { tracer: tracing.tracer } : {}),
  });
  await engine.worker.start();
  const { drivers } = await engine.drivers();
  logger.info(
    `JJ Bot worker running · database postgres · drivers ${drivers
      .map((info) => `${info.id}${info.available ? "" : " (unavailable)"}`)
      .join(", ")} · concurrency ${engine.context.config.concurrency}`,
  );
  const defaultModelWarning = models.defaultModelWarning();
  if (defaultModelWarning) logger.warn(defaultModelWarning);

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) {
      logger.error(`${signal} again: exiting now.`);
      process.exit(1);
    }
    stopping = true;
    logger.info(`${signal}: handing running work back and shutting down.`);
    setTimeout(() => {
      logger.error("Shutdown timed out: exiting.");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS).unref();
    (async () => {
      await engine.worker.stop();
      await database.close();
      await proxy?.restore();
      await tracing?.shutdown();
    })().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error("Shutdown failed", { error });
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError)
    logger.error(`JJ Bot worker: ${error.message}`);
  else
    logger.error(
      `JJ Bot worker failed to start: ${error instanceof Error ? error.message : String(error)}`,
    );
  process.exit(1);
});
