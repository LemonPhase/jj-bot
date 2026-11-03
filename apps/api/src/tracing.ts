// Trace export over OTLP/HTTP, on only when OTEL_EXPORTER_OTLP_ENDPOINT is
// set. The SDK and the exporter are imported here and only then, so a server
// without an endpoint never loads them and creates no exporter; the engine's
// spans are then no-ops (`@opentelemetry/api` alone).
import type { Logger } from "@jj/backend";
import type { Tracer } from "@opentelemetry/api";
import type { Env } from "./config";

export interface Tracing {
  /** The tracer the engine builds its spans with. */
  tracer: Tracer;
  /** Where spans are sent: `<OTEL_EXPORTER_OTLP_ENDPOINT>/v1/traces`, or the traces endpoint. */
  url: string;
  /**
   * Exports what is still buffered, then stops. Never rejects and never
   * takes much longer than the export timeout: a collector that refuses or
   * does not answer is logged as a warning, and the spans it did not take
   * are dropped, so a shutdown is never held up or failed by it.
   */
  shutdown(): Promise<void>;
}

/** How long one batch export, and the flush at shutdown, may take. */
export const EXPORT_TIMEOUT_MS = 5_000;

/** The variables the OTLP trace exporter reads headers from, generic first. */
export const OTLP_HEADER_VARIABLES = [
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
] as const;

export interface TracingOptions {
  /** Imports the SDK; replaced in tests to see whether it is called. */
  load?: () => Promise<Modules>;
  /** Default `EXPORT_TIMEOUT_MS`. */
  exportTimeoutMs?: number;
}

type Modules = [
  typeof import("@opentelemetry/sdk-trace"),
  typeof import("@opentelemetry/exporter-trace-otlp-http"),
  typeof import("@opentelemetry/resources"),
  typeof import("@opentelemetry/api"),
];

/** Imports the SDK, the OTLP exporter and resources; replaced in tests to see whether it is called. */
export const loadTracingModules = (): Promise<Modules> =>
  Promise.all([
    import("@opentelemetry/sdk-trace"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/resources"),
    import("@opentelemetry/api"),
  ]);

const text = (env: Env, name: string) => env[name]?.trim() || undefined;

/** One headers variable: `key=value` pairs, comma-separated, values URL-encoded. */
export function headersOf(env: Env, name: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const pair of (text(env, name) ?? "").split(",")) {
    const at = pair.indexOf("=");
    if (at <= 0) continue;
    const key = pair.slice(0, at).trim();
    const raw = pair.slice(at + 1).trim();
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      // Not URL-encoded: as written.
    }
    if (key && value) headers[key] = value;
  }
  return headers;
}

/**
 * The headers sent with every export: `OTEL_EXPORTER_OTLP_HEADERS`, and
 * `OTEL_EXPORTER_OTLP_TRACES_HEADERS` over them, as the exporter reads them.
 */
export function otlpHeaders(env: Env): Record<string, string> {
  return Object.assign(
    {},
    ...OTLP_HEADER_VARIABLES.map((name) => headersOf(env, name)),
  );
}

/** The traces endpoint, or undefined when OTEL_EXPORTER_OTLP_ENDPOINT is unset (no export). */
export function tracesUrl(env: Env): string | undefined {
  const endpoint = text(env, "OTEL_EXPORTER_OTLP_ENDPOINT");
  if (!endpoint) return undefined;
  return (
    text(env, "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT") ??
    `${endpoint.replace(/\/+$/, "")}/v1/traces`
  );
}

/**
 * Starts exporting the engine's spans when OTEL_EXPORTER_OTLP_ENDPOINT is
 * set; otherwise loads nothing and returns undefined. The service name is
 * `service` unless OTEL_SERVICE_NAME or OTEL_RESOURCE_ATTRIBUTES set one.
 * Export failures are logged as warnings.
 */
export async function startTracing(
  env: Env,
  service: string,
  logger: Logger,
  options: TracingOptions = {},
): Promise<Tracing | undefined> {
  const url = tracesUrl(env);
  if (!url) return undefined;
  const timeoutMs = options.exportTimeoutMs ?? EXPORT_TIMEOUT_MS;
  const [sdk, otlp, resources, api] = await (
    options.load ?? loadTracingModules
  )();
  api.diag.setLogger(
    {
      error: (message, ...args) =>
        logger.warn(`Trace export: ${message}`, args.length ? { args } : {}),
      warn: (message, ...args) =>
        logger.warn(`Trace export: ${message}`, args.length ? { args } : {}),
      info: () => {},
      debug: () => {},
      verbose: () => {},
    },
    { logLevel: api.DiagLogLevel.WARN, suppressOverrideMessage: true },
  );
  const fromEnv = resources.detectResources({
    detectors: [resources.envDetector],
  });
  const resource = resources
    .defaultResource()
    .merge(resources.resourceFromAttributes({ "service.name": service }))
    .merge(fromEnv);
  const provider = new sdk.TracerProvider({
    resource,
    spanProcessors: [
      new sdk.BatchSpanProcessor({
        exporter: new otlp.OTLPTraceExporter({
          url,
          headers: otlpHeaders(env),
          timeoutMillis: timeoutMs,
        }),
        exportTimeoutMillis: timeoutMs,
      }),
    ],
  });
  let stopping: Promise<void> | undefined;
  return {
    tracer: provider.getTracer("jj-bot"),
    url,
    shutdown: () => {
      stopping ??= flush(provider.shutdown(), timeoutMs, logger);
      return stopping;
    },
  };
}

/** `done` or, past `timeoutMs` (with a second's grace), a warning; never a rejection. */
async function flush(
  done: Promise<void>,
  timeoutMs: number,
  logger: Logger,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), timeoutMs + 1_000);
    timer.unref();
  });
  try {
    const result = await Promise.race([done.then(() => "done" as const), late]);
    if (result === "late")
      logger.warn(
        `Flushing the traces did not finish within ${timeoutMs} ms; the spans not yet exported are dropped`,
      );
  } catch (error) {
    logger.warn(
      "Flushing the traces failed; the spans not yet exported are dropped",
      {
        error: error instanceof Error ? error.message : String(error),
      },
    );
  } finally {
    clearTimeout(timer);
  }
}
