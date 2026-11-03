import type { Bus, Db, IdKind } from "@jj/db";
import { newId } from "@jj/db";
import type { Tracer } from "@opentelemetry/api";
import type { EngineConfig } from "./config";
import type { Logger } from "./observability/logger";
import type { EngineMetrics } from "./observability/metrics";
import type { DriverRegistry, McpDiscoverer, ModelCatalog } from "./ports";
import type { Redactor, Secret } from "./redact";
import type { SecretStore } from "./secrets/store";

export type { Logger } from "./observability/logger";

/** What every service and worker module shares. */
export interface EngineContext {
  db: Db;
  bus: Bus;
  config: EngineConfig;
  drivers: DriverRegistry;
  models: ModelCatalog;
  /** Tests MCP server configurations; absent, this server runs no MCP server. */
  mcp?: McpDiscoverer;
  /** Timestamps the engine writes (records, cancellation); events use the database clock. */
  clock: () => Date;
  ids: (kind: IdKind) => string;
  logger: Logger;
  /** The engine's Prometheus metrics (`GET /metrics`). */
  metrics: EngineMetrics;
  /** Spans of runs, model turns, tool calls and sandbox starts; a no-op without a tracer provider. */
  tracer: Tracer;
  /**
   * Builds a redactor over the server's secret values as they are now (a
   * token generated after boot and the stored secrets included), plus
   * `extra`. Each run builds one at its start, which also refreshes the
   * stored secrets, and again with its sandbox's injected values once the
   * sandbox is held.
   */
  redactor: (extra?: readonly Secret[]) => Promise<Redactor>;
  /** Provider keys and sandbox secrets entered through settings, encrypted at rest. */
  secretStore: SecretStore;
  /**
   * The server's own secrets: provider keys from its environment, the API
   * token, the database password and the master key. Not the stored ones.
   */
  serverSecrets: () => Promise<readonly Secret[]>;
  /**
   * The values injected into the sandboxes this process's worker holds,
   * which `redactor` always covers: a replaced or removed secret's old value
   * can still come out of a sandbox, and reach another task through a
   * shared file. Set by the worker; empty without one.
   */
  heldSecrets: () => readonly Secret[];
}

export const defaultIds = (kind: IdKind) => newId(kind);
