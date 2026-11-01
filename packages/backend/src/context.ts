import type { Bus, Db, IdKind } from "@jj/db";
import { newId } from "@jj/db";
import type { EngineConfig } from "./config";
import type { DriverRegistry, ModelCatalog } from "./ports";

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
}

export const defaultIds = (kind: IdKind) => newId(kind);
