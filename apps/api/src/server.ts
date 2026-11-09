// Process boot for the API: settings, the log, trace export, outbound proxy,
// database, drivers, models, engine, the embedded worker, then listening.
// `close()` is the graceful shutdown: optionally drain (not ready, the
// worker lets running sessions reach a turn boundary, requests are still
// served), then stop accepting connections, end event streams, stop the
// worker, close the database, flush the traces.
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type ServerType, serve } from "@hono/node-server";
import { createLogger, type Logger } from "@jj/backend";
import { configureOutboundProxy } from "@jj/runtime";
import { createApp, type JJApp } from "./app";
import {
  type Env,
  loadServerConfig,
  redactEndpoint,
  type ServerConfig,
  stopGraceWarning,
} from "./config";
import {
  type DeadlineOptions,
  enforceDeadlines,
  isUploadWrite,
  REQUEST_TIMEOUT_MS,
} from "./deadlines";
import { sendsHsts } from "./headers";
import { type ApiAuth, describeAuth, resolveApiToken } from "./token";
import { startTracing, type Tracing } from "./tracing";
import { openServices, type Services } from "./wiring";

export interface StartOptions {
  /** Settings and provider keys. Default `process.env`. */
  env?: Env;
  /** Default: JSON lines (JJ_LOG_FORMAT, JJ_LOG_LEVEL) on stdout and stderr. */
  logger?: Logger;
  /**
   * How long a request may take to arrive, an upload that needs longer
   * excepted (deadlines.ts). Default 300 s, Node's own; tests shorten it.
   */
  requestTimeoutMs?: number;
}

export interface CloseOptions {
  /**
   * Drain first, for up to this long (the stop signals pass
   * `config.drainTimeoutMs`): `/health/ready` answers 503 while the embedded
   * worker claims nothing and lets running sessions reach a turn boundary
   * (`Worker.drain`); other requests are still served meanwhile. Absent: the
   * worker hands running work back at once.
   */
  drainMs?: number;
}

export interface RunningServer {
  /** `http://host:port`, with the port actually bound (API_PORT=0 picks one). */
  url: string;
  config: ServerConfig;
  /** The bearer token in force, and where it came from. */
  auth: ApiAuth;
  services: Services;
  app: JJApp;
  /** Trace export, when OTEL_EXPORTER_OTLP_ENDPOINT is set. */
  tracing?: Tracing;
  /** Graceful shutdown. Idempotent: a later call waits for the first. */
  close(options?: CloseOptions): Promise<void>;
}

/** How long open connections get to finish before they are cut on shutdown. */
const DRAIN_MS = 5_000;

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

function listen(
  app: JJApp,
  hostname: string,
  port: number,
  deadlines: DeadlineOptions,
): Promise<{ server: ServerType; address: AddressInfo }> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname, port }, (address) =>
      resolve({ server, address }),
    );
    server.once("error", reject);
    enforceDeadlines(server as Server, deadlines);
    // `Expect: 100-continue`: Node answers 100 at once unless someone
    // listens. An upload's route answers it itself, once its limits pass, so
    // a body it refuses is never sent; every other request is invited as before.
    server.on(
      "checkContinue",
      (request: IncomingMessage, response: ServerResponse) => {
        if (!isUploadWrite(request)) response.writeContinue();
        server.emit("request", request, response);
      },
    );
  });
}

const hostForUrl = (host: string) => (host.includes(":") ? `[${host}]` : host);

export async function startServer(
  options: StartOptions = {},
): Promise<RunningServer> {
  const env = options.env ?? process.env;
  // Settings that cannot work fail here, before anything opens.
  const config = loadServerConfig(env);
  const logger = options.logger ?? createLogger(config.log);

  const tracing = await startTracing(env, "jj-api", logger);
  if (tracing)
    logger.info(`Exporting traces over OTLP to ${redactEndpoint(tracing.url)}`);
  const proxy = configureOutboundProxy(env);
  if (proxy)
    logger.info(
      `Model calls use the outbound proxy ${proxy.httpsProxy ?? proxy.httpProxy}`,
    );
  const services = await openServices(config, env, logger, {
    ...(tracing ? { tracer: tracing.tracer } : {}),
    processMetrics: true,
  }).catch(async (error) => {
    // The boot error is the one reported, whatever the flush does.
    await proxy?.restore().catch(() => {});
    await tracing?.shutdown().catch(() => {});
    throw error;
  });
  const { engine, database } = services;
  let server: ServerType | undefined;
  try {
    const auth = await resolveApiToken(config, database.db);
    const app = createApp({
      engine,
      logger,
      config: {
        ...(auth.kind === "none" ? {} : { apiToken: auth.token }),
        allowedHosts: config.allowedHosts,
        workerEmbedded: config.embedWorker,
        webDist: config.webDist,
        strictTransportSecurity: sendsHsts(config.publicUrl),
      },
    });
    // Listen first: a port clash fails before the worker claims any run.
    const listening = await listen(app, config.host, config.port, {
      requestTimeoutMs: options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      uploadReceiveMs: (sizeBytes) => engine.uploads.receiveMs(sizeBytes),
      headers: { strictTransportSecurity: sendsHsts(config.publicUrl) },
      logger,
    });
    server = listening.server;
    const url = `http://${hostForUrl(config.host)}:${listening.address.port}`;
    if (config.embedWorker) await engine.worker.start();

    const { drivers } = await engine.drivers();
    const providers = services.models
      .providers()
      .filter((provider) => provider.configured)
      .map((provider) => provider.id);
    logger.info(
      [
        `JJ Bot API at ${url}`,
        `database ${database.mode}${config.database.mode === "pglite" ? ` (${config.database.path})` : ""}`,
        `worker ${config.embedWorker ? "embedded" : "separate"}`,
        `drivers ${drivers.map((info) => `${info.id}${info.available ? "" : " (unavailable)"}`).join(", ")}`,
        `models ${providers.length > 0 ? providers.join(", ") : "none configured"}`,
        `auth ${describeAuth(auth)}`,
        `web ${config.webDist ? "served" : "not built"}`,
      ].join(" · "),
    );
    const defaultModelWarning = services.models.defaultModelWarning();
    if (defaultModelWarning) logger.warn(defaultModelWarning);
    const graceWarning = stopGraceWarning(config);
    if (graceWarning) logger.warn(graceWarning);
    // The one line that carries a generated token: the user opens it once,
    // and the web app keeps the token and drops it from the address bar.
    // Every other line redacts it, from now on even one generated just now.
    if (auth.kind === "generated") {
      await engine.context.redactor();
      const line = `Open JJ Bot: ${config.publicUrl ?? `http://127.0.0.1:${listening.address.port}`}/?token=${auth.token}`;
      if (logger.reveal) logger.reveal(line, auth.token);
      else logger.info(line);
    }

    const http = server;
    let closing: Promise<void> | undefined;
    const close = (options: CloseOptions = {}) => {
      closing ??= (async () => {
        if (options.drainMs !== undefined) {
          app.startDraining();
          if (config.embedWorker) await engine.worker.drain(options.drainMs);
        }
        const drained = new Promise<void>((resolve) =>
          http.close(() => resolve()),
        );
        app.endStreams();
        // Connections go idle as their responses (streams included) finish;
        // close them as they do instead of waiting out client keep-alive.
        const sweep = setInterval(() => {
          if ("closeIdleConnections" in http) http.closeIdleConnections();
        }, 25);
        try {
          await engine.worker.stop();
          await Promise.race([drained, delay(DRAIN_MS)]);
        } finally {
          clearInterval(sweep);
        }
        if ("closeAllConnections" in http) http.closeAllConnections();
        await database.close();
        await proxy?.restore();
        // Bounded, and logs its own failure: a dead collector never holds
        // the shutdown up or fails it.
        await tracing?.shutdown();
      })();
      return closing;
    };
    return {
      url,
      config,
      auth,
      services,
      app,
      close,
      ...(tracing ? { tracing } : {}),
    };
  } catch (error) {
    server?.close();
    await engine.worker.stop().catch(() => {});
    await database.close().catch(() => {});
    await proxy?.restore();
    await tracing?.shutdown().catch(() => {});
    throw error;
  }
}
