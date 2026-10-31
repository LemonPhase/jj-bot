// `@jj/backend`: the JJ Bot engine (domain services and the worker) over the
// relational store. The legacy JSONB-store service is re-exported unchanged
// until `apps/api` switches to the engine.
export {
  type ArtifactLimits,
  clampOutputCap,
  configFromEnv,
  DEFAULT_ARTIFACT_LIMITS,
  type EngineConfig,
  type EngineConfigInput,
  resolveConfig,
} from "./config";
export { consoleLogger, type EngineContext, type Logger } from "./context";
export { createDriverRegistry, type DriverEntry } from "./drivers";
export { createEngine, type Engine, type EngineOptions } from "./engine";
export { DomainError, HTTP_STATUS } from "./errors";
export * from "./legacy/service";
export type * from "./ports";
export type { TaskStreamOptions, TaskSubscription } from "./services/stream";
export type { Worker } from "./worker/worker";
