// The API process: boots the server, and shuts it down gracefully on SIGINT
// or SIGTERM. A second signal, or a shutdown that hangs, exits at once.
import { createLogger, logSettings } from "@jj/backend";
import { ConfigError } from "./config";
import { startServer } from "./server";

const SHUTDOWN_TIMEOUT_MS = 20_000;

// The process's log; a JJ_LOG_* value that cannot work is the ConfigError
// startServer reports, printed here with the defaults.
const logger = createLogger(logSettings(process.env, true));

let server: Awaited<ReturnType<typeof startServer>>;
try {
  server = await startServer({ logger });
} catch (error) {
  if (error instanceof ConfigError)
    logger.error(`JJ Bot API: ${error.message}`);
  else
    logger.error(
      `JJ Bot API failed to start: ${error instanceof Error ? error.message : String(error)}`,
    );
  process.exit(1);
}

let stopping = false;
function shutdown(signal: string) {
  if (stopping) {
    logger.error(`${signal} again: exiting now.`);
    process.exit(1);
  }
  stopping = true;
  logger.info(`${signal}: shutting down.`);
  setTimeout(() => {
    logger.error("Shutdown timed out: exiting.");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  server.close().then(
    () => process.exit(0),
    (error: unknown) => {
      logger.error("Shutdown failed", { error });
      process.exit(1);
    },
  );
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
