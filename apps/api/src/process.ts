// What the API and worker processes do with an error nothing caught: log it
// through their own log, which redacts like task history, and exit 1, as
// Node would. Without this Node prints it raw to stderr, keys included.
import type { Logger } from "@jj/backend";

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
