// The API process: boots the server, and on SIGINT or SIGTERM drains (for
// JJ_DRAIN_TIMEOUT_SEC: not ready, the embedded worker lets running sessions
// reach a turn boundary), then shuts down gracefully and exits 0. A second
// signal, or a shutdown that hangs, exits 1 at once.
import { createLogger, logSettings } from "@jj/backend";
import { ConfigError } from "./config";
import {
  exitOnUncaught,
  SHUTDOWN_AFTER_DRAIN_MS,
  stopOnSignals,
} from "./process";
import { startServer } from "./server";

// The process's log; a JJ_LOG_* value that cannot work is the ConfigError
// startServer reports, printed here with the defaults.
const logger = createLogger(logSettings(process.env, true));
exitOnUncaught(logger);

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

const { drainTimeoutMs, embedWorker } = server.config;
stopOnSignals(logger, {
  announce: (signal) =>
    embedWorker
      ? `${signal}: draining (running sessions get up to ${drainTimeoutMs / 1000} s to reach a turn boundary), then shutting down.`
      : `${signal}: shutting down.`,
  stop: () => server.close({ drainMs: drainTimeoutMs }),
  limitMs: drainTimeoutMs + SHUTDOWN_AFTER_DRAIN_MS,
});
