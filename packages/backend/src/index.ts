// `@jj/backend`: the JJ Bot engine (domain services and the worker) over the
// relational store.
export {
  type ArtifactLimits,
  clampOutputCap,
  configFromEnv,
  DEFAULT_ARTIFACT_LIMITS,
  type EngineConfig,
  type EngineConfigInput,
  resolveConfig,
} from "./config";
export type { EngineContext } from "./context";
export { createDriverRegistry, type DriverEntry } from "./drivers";
export { createEngine, type Engine, type EngineOptions } from "./engine";
export { DomainError, HTTP_STATUS } from "./errors";
export {
  createLogger,
  LOG_FORMATS,
  LOG_LEVELS,
  type LogFields,
  type LogFormat,
  type Logger,
  type LoggerOptions,
  type LogLevel,
  type LogSettings,
  logFields,
  logSettings,
  type StructuredLogger,
  withLogFields,
} from "./observability/logger";
export {
  createMetrics,
  type EngineMetrics,
  type MetricsOptions,
} from "./observability/metrics";
export { SPAN_ATTRIBUTES, SPANS } from "./observability/tracing";
export type * from "./ports";
export { MIN_BARE_SECRET_LENGTH, type Secret } from "./redact";
export {
  createKeyring,
  type Keyring,
  MasterKeyError,
  parseMasterKey,
} from "./secrets/keyring";
export {
  SecretStore,
  type SecretStoreOptions,
  type StoredProviderKey,
} from "./secrets/store";
export type { TaskStreamOptions, TaskSubscription } from "./services/stream";
export type { Worker } from "./worker/worker";
