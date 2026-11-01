// Process boot for the API: settings, outbound proxy, database, drivers,
// models, engine, the embedded worker, then listening. `close()` is the
// graceful shutdown: stop accepting connections, end event streams, stop the
// worker, close the database.
import type { AddressInfo } from "node:net";
import { type ServerType, serve } from "@hono/node-server";
import type { Logger } from "@jj/backend";
import { configureOutboundProxy } from "@jj/runtime";
import { apiLogger, createApp, type JJApp } from "./app";
import {
  type Env,
  isLoopbackHost,
  loadServerConfig,
  type ServerConfig,
} from "./config";
import { openServices, type Services } from "./wiring";

export interface StartOptions {
  /** Settings and provider keys. Default `process.env`. */
  env?: Env;
  logger?: Logger;
}

export interface RunningServer {
  /** `http://host:port`, with the port actually bound (API_PORT=0 picks one). */
  url: string;
  config: ServerConfig;
  services: Services;
  app: JJApp;
  /** Graceful shutdown. Idempotent. */
  close(): Promise<void>;
}

/** How long open connections get to finish before they are cut on shutdown. */
const DRAIN_MS = 5_000;

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

function listen(
  app: JJApp,
  hostname: string,
  port: number,
): Promise<{ server: ServerType; address: AddressInfo }> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname, port }, (address) =>
      resolve({ server, address }),
    );
    server.once("error", reject);
  });
}

const hostForUrl = (host: string) => (host.includes(":") ? `[${host}]` : host);

function authSummary(config: ServerConfig): string {
  if (config.apiToken) return "bearer token";
  if (isLoopbackHost(config.host)) return "none (loopback only)";
  return "none (API_ALLOW_UNAUTHENTICATED: publish the port on loopback only)";
}

export async function startServer(
  options: StartOptions = {},
): Promise<RunningServer> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? apiLogger;
  // Refuses a non-loopback host without a token before anything opens.
  const config = loadServerConfig(env);

  const proxy = configureOutboundProxy(env);
  if (proxy)
    logger.info(
      `Model calls use the outbound proxy ${proxy.httpsProxy ?? proxy.httpProxy}`,
    );
  const services = await openServices(config, env).catch(async (error) => {
    await proxy?.restore();
    throw error;
  });
  const { engine, database } = services;
  try {
    if (config.embedWorker) await engine.worker.start();
    const app = createApp({
      engine,
      logger,
      config: {
        ...(config.apiToken ? { apiToken: config.apiToken } : {}),
        workerEmbedded: config.embedWorker,
        webDist: config.webDist,
      },
    });
    const { server, address } = await listen(app, config.host, config.port);
    const url = `http://${hostForUrl(config.host)}:${address.port}`;

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
        `auth ${authSummary(config)}`,
        `web ${config.webDist ? "served" : "not built"}`,
      ].join(" · "),
    );

    let closing: Promise<void> | undefined;
    const close = () => {
      closing ??= (async () => {
        const drained = new Promise<void>((resolve) =>
          server.close(() => resolve()),
        );
        app.endStreams();
        // Connections go idle as their responses (streams included) finish;
        // close them as they do instead of waiting out client keep-alive.
        const sweep = setInterval(() => {
          if ("closeIdleConnections" in server) server.closeIdleConnections();
        }, 25);
        try {
          await engine.worker.stop();
          await Promise.race([drained, delay(DRAIN_MS)]);
        } finally {
          clearInterval(sweep);
        }
        if ("closeAllConnections" in server) server.closeAllConnections();
        await database.close();
        await proxy?.restore();
      })();
      return closing;
    };
    return { url, config, services, app, close };
  } catch (error) {
    await engine.worker.stop().catch(() => {});
    await database.close().catch(() => {});
    await proxy?.restore();
    throw error;
  }
}
