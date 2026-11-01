// Process boot for the API: settings, outbound proxy, database, drivers,
// models, engine, the embedded worker, then listening. `close()` is the
// graceful shutdown: stop accepting connections, end event streams, stop the
// worker, close the database.
import type { AddressInfo } from "node:net";
import { type ServerType, serve } from "@hono/node-server";
import type { Logger } from "@jj/backend";
import { configureOutboundProxy } from "@jj/runtime";
import { apiLogger, createApp, type JJApp } from "./app";
import { type Env, loadServerConfig, type ServerConfig } from "./config";
import { type ApiAuth, describeAuth, resolveApiToken } from "./token";
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
  /** The bearer token in force, and where it came from. */
  auth: ApiAuth;
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

export async function startServer(
  options: StartOptions = {},
): Promise<RunningServer> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? apiLogger;
  // Settings that cannot work fail here, before anything opens.
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
  let server: ServerType | undefined;
  try {
    const auth = await resolveApiToken(config, database.db);
    if (auth.kind !== "none") services.secrets.add(auth.token);
    const app = createApp({
      engine,
      logger,
      config: {
        ...(auth.kind === "none" ? {} : { apiToken: auth.token }),
        allowedHosts: config.allowedHosts,
        workerEmbedded: config.embedWorker,
        webDist: config.webDist,
      },
    });
    // Listen first: a port clash fails before the worker claims any run.
    const listening = await listen(app, config.host, config.port);
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
    // The one line that carries a generated token: the user opens it once,
    // and the web app keeps the token and drops it from the address bar.
    if (auth.kind === "generated")
      logger.info(
        `Open JJ Bot: ${config.publicUrl ?? `http://127.0.0.1:${listening.address.port}`}/?token=${auth.token}`,
      );

    const http = server;
    let closing: Promise<void> | undefined;
    const close = () => {
      closing ??= (async () => {
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
      })();
      return closing;
    };
    return { url, config, auth, services, app, close };
  } catch (error) {
    server?.close();
    await engine.worker.stop().catch(() => {});
    await database.close().catch(() => {});
    await proxy?.restore();
    throw error;
  }
}
