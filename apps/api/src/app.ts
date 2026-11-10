// The HTTP app over an engine: the 1.0 routes under `/api`, health under
// `/health`, Prometheus metrics at `/metrics`, and the built web app when
// there is one. Process boot (database, drivers, models, listening, signals)
// is in server.ts, so tests drive this with `app.request`.
import type { Engine, Logger } from "@jj/backend";
import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { TrustedProxies } from "./auth/clients";
import { authGuard } from "./auth/guard";
import type { PasswordHash } from "./auth/password";
import { authRoutes } from "./auth/routes";
import { AuthService } from "./auth/service";
import { isUploadWrite, originGuard, requireJson } from "./guard";
import { securityHeaders } from "./headers";
import { healthRoutes } from "./health";
import { errorResponse, onError } from "./http";
import { requestLog } from "./request-log";
import { apiRoutes } from "./routes";
import { StreamRegistry } from "./sse";
import { mountWeb, spaFallback } from "./web";

export interface AppConfig {
  /**
   * The access token: when set, `/api/*` and `/metrics` need it as
   * `Authorization: Bearer`, or a session cookie from signing in.
   */
  apiToken?: string;
  /** Signing in beyond the token. */
  auth?: AuthSettings;
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
  /** A readiness check that has not answered by then fails. Default 3 s. */
  readinessTimeoutMs?: number;
  /** The built web app to serve, or null. */
  webDist?: string | null;
  /** Largest request body. Default 1 MiB. */
  bodyLimitBytes?: number;
  /** Send Strict-Transport-Security: users open the app over https (API_PUBLIC_URL). */
  strictTransportSecurity?: boolean;
}

export interface AuthSettings {
  /** `apiToken` is the generated token, which Settings → Security can rotate, not API_TOKEN. */
  generated?: boolean;
  /** `JJ_PASSWORD_HASH`, parsed, with its text. */
  password?: { hash: PasswordHash; text: string };
  /** `API_PUBLIC_URL`: the session cookie's flags and the origin cookie writes come from. */
  publicUrl?: string;
  /** `JJ_TRUSTED_PROXIES`; default loopback. */
  trustedProxies?: TrustedProxies;
  /** The clock sessions, codes and limits use; tests inject one. */
  now?: () => number;
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
  /**
   * The process is stopping: `/health/ready` answers 503 from now on, while
   * everything else is still served (the worker drains meanwhile).
   */
  startDraining(): void;
  readonly draining: boolean;
  /** Signing in: sessions, login codes, the token in force. */
  readonly auth: AuthService;
};

export function createApp({
  engine,
  config,
  logger = engine.context.logger,
}: AppOptions): JJApp {
  const app = new Hono();
  const streams = new StreamRegistry();
  let draining = false;
  const handleError = onError(logger);
  const maxBytes = config.bodyLimitBytes ?? 1024 * 1024;

  app.onError(handleError);
  // First, so every line a request logs carries its id.
  app.use("*", requestLog(logger));
  // On every answer, errors and the SPA fallback included (headers.ts).
  app.use(
    "*",
    securityHeaders({
      strictTransportSecurity: config.strictTransportSecurity ?? false,
    }),
  );
  app.route(
    "/health",
    healthRoutes(
      engine,
      {
        workerEmbedded: config.workerEmbedded,
        workerStaleMs: config.workerStaleMs ?? 30_000,
        ...(config.readinessTimeoutMs
          ? { checkTimeoutMs: config.readinessTimeoutMs }
          : {}),
        draining: () => draining,
      },
      logger,
    ),
  );

  const settings = config.auth ?? {};
  const auth = new AuthService({
    db: engine.context.db,
    token: config.apiToken
      ? {
          kind: settings.generated ? "generated" : "configured",
          token: config.apiToken,
        }
      : { kind: "none" },
    ...(settings.password ? { password: settings.password } : {}),
    ...(settings.publicUrl ? { publicUrl: settings.publicUrl } : {}),
    ...(settings.trustedProxies
      ? { trustedProxies: settings.trustedProxies }
      : {}),
    ...(settings.now ? { now: settings.now } : {}),
    logger,
    // The redactor reads the generated token afresh, so it covers a rotated one.
    onTokenChanged: () => engine.context.redactor(),
  });

  // `/api` and `/metrics` answer the same callers: the browser protection,
  // then, when the API requires them, the token or a session (auth/guard.ts).
  const guards: MiddlewareHandler[] = [
    originGuard({
      tokenRequired: auth.required,
      allowedHosts: config.allowedHosts ?? [],
    }),
    authGuard(auth),
  ];
  const metrics = new Hono();
  metrics.onError(handleError);
  for (const guard of guards) metrics.use("*", guard);
  metrics.get("/", async (c) => {
    c.header("Content-Type", engine.metrics.contentType);
    c.header("Cache-Control", "no-store");
    return c.body(await engine.metrics.text());
  });
  app.route("/metrics", metrics);

  const api = new Hono();
  api.onError(handleError);
  for (const guard of guards) api.use("*", guard);
  api.use("*", requireJson());
  const jsonLimit = bodyLimit({
    maxSize: maxBytes,
    onError: (c) =>
      errorResponse(
        c,
        413,
        "VALIDATION_FAILED",
        `The request body is larger than ${maxBytes} bytes.`,
      ),
  });
  // An upload's body is bounded by the upload limits instead, checked
  // against its Content-Length before it is read (routes.ts).
  api.use("*", (c, next) => (isUploadWrite(c) ? next() : jsonLimit(c, next)));
  api.route("/auth", authRoutes(auth, streams));
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
    startDraining: {
      value: () => {
        draining = true;
      },
    },
    draining: { get: () => draining },
    auth: { value: auth },
  }) as JJApp;
}
