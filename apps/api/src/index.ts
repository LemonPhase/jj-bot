// The API process: boots the server, and shuts it down gracefully on SIGINT
// or SIGTERM. A second signal, or a shutdown that hangs, exits at once.
import { ConfigError } from "./config";
import { startServer } from "./server";

const SHUTDOWN_TIMEOUT_MS = 20_000;

let server: Awaited<ReturnType<typeof startServer>>;
try {
  server = await startServer();
} catch (error) {
  if (error instanceof ConfigError)
    console.error(`JJ Bot API: ${error.message}`);
  else
    console.error(
      "JJ Bot API failed to start:",
      error instanceof Error ? error.message : error,
    );
  process.exit(1);
}

let stopping = false;
function shutdown(signal: string) {
  if (stopping) {
    console.error(`[api] ${signal} again: exiting now.`);
    process.exit(1);
  }
  stopping = true;
  console.info(`[api] ${signal}: shutting down.`);
  setTimeout(() => {
    console.error("[api] Shutdown timed out: exiting.");
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  server.close().then(
    () => process.exit(0),
    (error: unknown) => {
      console.error("[api] Shutdown failed:", error);
      process.exit(1);
    },
  );
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
