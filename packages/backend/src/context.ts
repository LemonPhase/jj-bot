import type { Bus, Db, IdKind } from "@jj/db";
import { newId } from "@jj/db";
import type { EngineConfig } from "./config";
import type { DriverRegistry, ModelCatalog } from "./ports";
import type { Redactor, Secret } from "./redact";
import type { SecretStore } from "./secrets/store";

export interface Logger {
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
}

export const consoleLogger: Logger = {
  info: (message, details) =>
    details === undefined
      ? console.info(`[engine] ${message}`)
      : console.info(`[engine] ${message}`, details),
  warn: (message, details) =>
    details === undefined
      ? console.warn(`[engine] ${message}`)
      : console.warn(`[engine] ${message}`, details),
  error: (message, details) =>
    details === undefined
      ? console.error(`[engine] ${message}`)
      : console.error(`[engine] ${message}`, details),
};

/** What every service and worker module shares. */
export interface EngineContext {
  db: Db;
  bus: Bus;
  config: EngineConfig;
  drivers: DriverRegistry;
  models: ModelCatalog;
  /** Timestamps the engine writes (records, cancellation); events use the database clock. */
  clock: () => Date;
  ids: (kind: IdKind) => string;
  logger: Logger;
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
}

export const defaultIds = (kind: IdKind) => newId(kind);
