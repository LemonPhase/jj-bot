// The standalone worker: the API's wiring without HTTP. It claims and runs
// jobs from PostgreSQL next to an API started with JJ_EMBED_WORKER=false.
// PGlite is single-process, so it is refused. It logs like the API and
// exports traces when OTEL_EXPORTER_OTLP_ENDPOINT is set; it serves no
// metrics, so its runs are not in the API's `/metrics`. SIGINT and SIGTERM
// drain it as they drain the API's embedded worker.
import {
  ConfigError,
  loadWorkerConfig,
  redactEndpoint,
  stopGraceWarning,
} from "@jj/api/config";
import {
  exitOnUncaught,
  SHUTDOWN_AFTER_DRAIN_MS,
  stopOnSignals,
} from "@jj/api/process";
import { startTracing } from "@jj/api/tracing";
import { openServices } from "@jj/api/wiring";
import { createLogger, logSettings } from "@jj/backend";
import { configureOutboundProxy } from "@jj/runtime";

const logger = createLogger(logSettings(process.env, true));
exitOnUncaught(logger);

async function main() {
  const env = process.env;
  const config = loadWorkerConfig(env);
  const tracing = await startTracing(env, "jj-worker", logger);
  if (tracing)
    logger.info(`Exporting traces over OTLP to ${redactEndpoint(tracing.url)}`);
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
  const graceWarning = stopGraceWarning(config);
  if (graceWarning) logger.warn(graceWarning);

  const { drainTimeoutMs } = config;
  stopOnSignals(logger, {
    announce: (signal) =>
      `${signal}: draining (running sessions get up to ${drainTimeoutMs / 1000} s to reach a turn boundary), then shutting down.`,
    stop: async () => {
      // Hands back or interrupts what runs, releases the sandboxes and
      // removes this worker's heartbeat.
      await engine.worker.drain(drainTimeoutMs);
      await database.close();
      await proxy?.restore();
      // Bounded, and logs its own failure: a dead collector never holds the
      // shutdown up or fails it.
      await tracing
        ?.shutdown()
        .catch((error: unknown) =>
          logger.warn("Flushing the traces failed", { error }),
        );
    },
    limitMs: drainTimeoutMs + SHUTDOWN_AFTER_DRAIN_MS,
  });
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
