// What the API and worker processes do with an error nothing caught, and with
// a stop signal. An uncaught error is logged through their own log, which
// redacts like task history, and the process exits 1, as Node would; without
// this Node prints it raw to stderr, keys included.
import type { Logger } from "@jj/backend";

/** How long a stop may take besides the drain itself: sandboxes, connections, the database and the trace flush. */
export const SHUTDOWN_AFTER_DRAIN_MS = 20_000;

export interface StopOnSignals {
  /** The line logged when the first signal arrives. */
  announce(signal: NodeJS.Signals): string;
  /** The graceful stop, drain included. */
  stop(): Promise<void>;
  /** A stop still running after this long exits 1 at once. */
  limitMs: number;
}

/**
 * SIGINT and SIGTERM stop the process gracefully with `stop`, then it exits
 * 0, or 1 when the stop failed. A second signal, or a stop that outlasts
 * `limitMs`, exits 1 at once.
 */
export function stopOnSignals(logger: Logger, options: StopOnSignals) {
  let stopping = false;
  const onSignal = (signal: NodeJS.Signals) => {
    if (stopping) {
      logger.error(`${signal} again: exiting now.`);
      process.exit(1);
    }
    stopping = true;
    logger.info(options.announce(signal));
    setTimeout(() => {
      logger.error("Shutdown timed out: exiting.");
      process.exit(1);
    }, options.limitMs).unref();
    options.stop().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error("Shutdown failed", { error });
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
}

export function exitOnUncaught(logger: Logger) {
  const fatal = (what: string) => (error: unknown) => {
    try {
      logger.error(`${what}: exiting`, { error });
    } finally {
      process.exit(1);
    }
  };
  process.on("uncaughtException", fatal("Uncaught exception"));
  process.on("unhandledRejection", fatal("Unhandled rejection"));
}
