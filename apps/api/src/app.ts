// The HTTP app over an engine: the 1.0 routes under `/api`, health under
// `/health`, and the built web app when there is one. Process boot (database,
// drivers, models, listening, signals) is in server.ts, so tests drive this
// with `app.request`.
import { consoleLogger, type Engine, type Logger } from "@jj/backend";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { originGuard, requireJson } from "./guard";
import { healthRoutes } from "./health";
import { bearerAuth, errorResponse, onError } from "./http";
import { apiRoutes } from "./routes";
import { StreamRegistry } from "./sse";
import { mountWeb, spaFallback } from "./web";

export interface AppConfig {
  /** Required as `Authorization: Bearer` on `/api/*` when set. */
  apiToken?: string;
  /**
   * Without a token, `Host` values besides loopback that `/api/*` answers
   * (API_ALLOWED_HOSTS): a hostname with any port, or an exact `host:port`.
   */
  allowedHosts?: readonly string[];
  /** The job loop runs in this process; readiness checks its heartbeat. */
  workerEmbedded: boolean;
  /** Comment heartbeat on open streams. Default 15 s. */
  heartbeatMs?: number;
  /** A worker poll older than this makes the API not ready. Default 30 s. */
  workerStaleMs?: number;
  /** The built web app to serve, or null. */
  webDist?: string | null;
  /** Largest request body. Default 1 MiB. */
  bodyLimitBytes?: number;
}

export interface AppOptions {
  engine: Engine;
  config: AppConfig;
  logger?: Logger;
}

export type JJApp = Hono & {
  /** Ends every open event stream, so the HTTP server can drain on shutdown. */
  endStreams(): void;
  /** Event streams open right now. */
  readonly openStreams: number;
};

export const apiLogger: Logger = {
  info: (message, details) => log("info", message, details),
  warn: (message, details) => log("warn", message, details),
  error: (message, details) => log("error", message, details),
};

function log(
  level: "info" | "warn" | "error",
  message: string,
  details?: unknown,
) {
  if (details === undefined) console[level](`[api] ${message}`);
  else console[level](`[api] ${message}`, details);
}

export function createApp({
  engine,
  config,
  logger = consoleLogger,
}: AppOptions): JJApp {
  const app = new Hono();
  const streams = new StreamRegistry();
  const handleError = onError(logger);
  const maxBytes = config.bodyLimitBytes ?? 1024 * 1024;

  app.onError(handleError);
  app.route(
    "/health",
    healthRoutes(
      engine,
      {
        workerEmbedded: config.workerEmbedded,
        workerStaleMs: config.workerStaleMs ?? 30_000,
      },
      logger,
    ),
  );

  const api = new Hono();
  api.onError(handleError);
  api.use(
    "*",
    originGuard({
      tokenRequired: Boolean(config.apiToken),
      allowedHosts: config.allowedHosts ?? [],
    }),
  );
  if (config.apiToken) api.use("*", bearerAuth(config.apiToken));
  api.use("*", requireJson());
  api.use(
    "*",
    bodyLimit({
      maxSize: maxBytes,
      onError: (c) =>
        errorResponse(
          c,
          413,
          "VALIDATION_FAILED",
          `The request body is larger than ${maxBytes} bytes.`,
        ),
    }),
  );
  api.route(
    "/",
    apiRoutes({
      engine,
      streams,
      heartbeatMs: config.heartbeatMs ?? 15_000,
      logger,
    }),
  );
  app.route("/api", api);

  const fallback = config.webDist ? spaFallback(config.webDist) : null;
  if (config.webDist) mountWeb(app, config.webDist);
  app.notFound(async (c) => {
    const page = fallback ? await fallback(c) : null;
    return (
      page ??
      errorResponse(
        c,
        404,
        "NOT_FOUND",
        `No route for ${c.req.method} ${c.req.path}.`,
      )
    );
  });

  return Object.defineProperties(app, {
    endStreams: { value: () => streams.endAll() },
    openStreams: { get: () => streams.size },
  }) as JJApp;
}
