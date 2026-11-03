import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { MAX_SPEND_CAP_USD, TOOL_OUTPUT_PREVIEW_LIMIT } from "@jj/contracts";

export interface ArtifactLimits {
  /** Files larger than this are not snapshotted. */
  maxFileBytes: number;
  /** Most new file artifacts one snapshot records, counted after deduplication. */
  maxFilesPerRun: number;
  /** Most workspace entries listed per snapshot. */
  maxListEntries: number;
  /** Directory names never descended into. */
  ignoreDirectories: readonly string[];
}

export interface EngineConfig {
  /** Lease owner name for this worker; unique per process. */
  workerId: string;
  /** Jobs (session runs, chat replies and MCP discoveries) one worker runs at once. `JJ_CONCURRENCY`. */
  concurrency: number;
  /**
   * MCP discoveries one worker runs at once, default 1: they take slots of
   * `concurrency`, so the rest always stay for session runs and chat
   * replies (with `concurrency` 1, a discovery takes the only one while it
   * runs). Never more than `concurrency - 1` when that is at least 1.
   */
  maxConcurrentDiscoveries: number;
  /** How long a discovery waits for its ephemeral sandbox to start, default 60 s. */
  discoveryAcquireMs: number;
  leaseMs: number;
  /** How often the worker claims when no wake arrives. */
  pollIntervalMs: number;
  /** `JJ_MAX_SESSIONS_PER_TASK`. */
  maxSessionsPerTask: number;
  /** `JJ_MAX_DELEGATION_DEPTH`: the coordinator is depth 0. */
  maxDelegationDepth: number;
  /** `JJ_TASKS_PER_BOT_PER_HOUR`: tasks a bot may create from direct chat per hour. */
  tasksPerBotPerHour: number;
  /**
   * `JJ_MAX_USD_PER_DAY`: what the whole instance may spend on models with a
   * listed price in any rolling 24 hours, chat included; null for no cap.
   */
  maxUsdPerDay: number | null;
  /** `JJ_OUTPUT_CAP_BYTES`, clamped to the contract's preview limit. */
  outputCapBytes: number;
  /** Goal versions a task may reach; a further change answers GOAL_VERSION_BUDGET. */
  maxGoalVersions: number;
  /**
   * Verification gate runs one coordinator run may make
   * (`JJ_MAX_VERIFICATION_ATTEMPTS`, default 3). After the last failed one the
   * task waits for the user.
   */
  maxVerificationAttempts: number;
  /**
   * A task's sandbox is released after this long without a run. Ephemeral
   * workspaces use `ephemeralIdleMs` instead, since releasing one discards
   * its files.
   */
  sandboxIdleMs: number;
  /**
   * An ephemeral workspace's sandbox is released, discarding the files,
   * after this long without a run (`JJ_EPHEMERAL_IDLE_MINUTES`, default 6 h).
   * A later session of its task then fails visibly.
   */
  ephemeralIdleMs: number;
  /**
   * Sandboxes one worker holds at once (`JJ_MAX_HELD_SANDBOXES`). Over it,
   * the least recently used idle one is released, a `task` workspace first.
   */
  maxHeldSandboxes: number;
  /** Conversation messages a chat reply sees. */
  chatHistoryLimit: number;
  chatMaxTurns: number;
  chatTimeoutMs: number;
  artifacts: ArtifactLimits;
  /** False for an in-memory database; reported by bootstrap. */
  persistence: boolean;
  /**
   * Record the worker's row in `worker_heartbeats`. Only another process
   * reads it (an API without an embedded worker), so it is off on PGlite,
   * which no other process can open.
   */
  workerHeartbeat: boolean;
  /** Fallback re-read interval of a task stream, in case a notification is lost. */
  streamPollMs: number;
  /** How long a driver probe result is reused. */
  probeTtlMs: number;
}

export type EngineConfigInput = Partial<Omit<EngineConfig, "artifacts">> & {
  artifacts?: Partial<ArtifactLimits>;
};

export const DEFAULT_ARTIFACT_LIMITS: ArtifactLimits = {
  maxFileBytes: 5 * 1024 * 1024,
  maxFilesPerRun: 50,
  maxListEntries: 2000,
  ignoreDirectories: [
    "node_modules",
    ".git",
    "dist",
    "build",
    ".cache",
    ".tmp",
  ],
};

export function resolveConfig(input: EngineConfigInput = {}): EngineConfig {
  const { artifacts, ...rest } = input;
  const config: EngineConfig = {
    workerId: `worker-${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`,
    concurrency: 4,
    maxConcurrentDiscoveries: 1,
    discoveryAcquireMs: 60_000,
    leaseMs: 30_000,
    pollIntervalMs: 1_000,
    maxSessionsPerTask: 16,
    maxDelegationDepth: 3,
    tasksPerBotPerHour: 10,
    maxUsdPerDay: null,
    outputCapBytes: TOOL_OUTPUT_PREVIEW_LIMIT,
    maxGoalVersions: 20,
    maxVerificationAttempts: 3,
    sandboxIdleMs: 10 * 60_000,
    ephemeralIdleMs: 6 * 60 * 60_000,
    maxHeldSandboxes: 32,
    chatHistoryLimit: 40,
    chatMaxTurns: 6,
    chatTimeoutMs: 120_000,
    persistence: true,
    workerHeartbeat: true,
    streamPollMs: 15_000,
    probeTtlMs: 10_000,
    ...stripUndefined(rest),
    artifacts: {
      ...DEFAULT_ARTIFACT_LIMITS,
      ...stripUndefined(artifacts ?? {}),
    },
  };
  config.outputCapBytes = clampOutputCap(config.outputCapBytes);
  if (
    config.maxUsdPerDay !== null &&
    !(
      Number.isFinite(config.maxUsdPerDay) &&
      config.maxUsdPerDay > 0 &&
      config.maxUsdPerDay <= MAX_SPEND_CAP_USD
    )
  )
    throw new RangeError(
      `maxUsdPerDay must be a positive number of US dollars, at most ${MAX_SPEND_CAP_USD}, or null.`,
    );
  for (const key of [
    "concurrency",
    "leaseMs",
    "pollIntervalMs",
    "maxSessionsPerTask",
    "maxDelegationDepth",
    "tasksPerBotPerHour",
    "maxGoalVersions",
    "maxVerificationAttempts",
    "chatHistoryLimit",
    "chatMaxTurns",
    "ephemeralIdleMs",
    "maxHeldSandboxes",
    "maxConcurrentDiscoveries",
    "discoveryAcquireMs",
  ] as const) {
    const value = config[key];
    if (!Number.isSafeInteger(value) || value < 1)
      throw new RangeError(`${key} must be a positive integer.`);
  }
  config.maxConcurrentDiscoveries = Math.min(
    config.maxConcurrentDiscoveries,
    Math.max(1, config.concurrency - 1),
  );
  return config;
}

/** The output cap the engine and events use: at most the contract's preview limit. */
export function clampOutputCap(requested: number): number {
  if (!Number.isFinite(requested) || requested <= 0)
    return TOOL_OUTPUT_PREVIEW_LIMIT;
  return Math.max(
    1024,
    Math.min(Math.floor(requested), TOOL_OUTPUT_PREVIEW_LIMIT),
  );
}

/** Engine settings from the environment (`JJ_*`); unset variables keep the defaults. */
export function configFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): EngineConfigInput {
  const int = (name: string) => {
    const raw = env[name]?.trim();
    if (!raw) return undefined;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < 1)
      throw new RangeError(`${name} must be a positive integer.`);
    return value;
  };
  const usd = (name: string) => {
    const raw = env[name]?.trim();
    if (!raw) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0 || value > MAX_SPEND_CAP_USD)
      throw new RangeError(
        `${name} must be a positive number of US dollars, at most ${MAX_SPEND_CAP_USD}.`,
      );
    return value;
  };
  // PostgreSQL when DATABASE_URL is set, else PGlite at JJ_DATABASE_PATH,
  // where `memory://` keeps nothing across restarts.
  const inMemory =
    !env.DATABASE_URL?.trim() &&
    (env.JJ_DATABASE_PATH?.trim() ?? "").startsWith("memory://");
  return {
    concurrency: int("JJ_CONCURRENCY"),
    maxSessionsPerTask: int("JJ_MAX_SESSIONS_PER_TASK"),
    maxDelegationDepth: int("JJ_MAX_DELEGATION_DEPTH"),
    tasksPerBotPerHour: int("JJ_TASKS_PER_BOT_PER_HOUR"),
    maxUsdPerDay: usd("JJ_MAX_USD_PER_DAY"),
    outputCapBytes: int("JJ_OUTPUT_CAP_BYTES"),
    maxVerificationAttempts: int("JJ_MAX_VERIFICATION_ATTEMPTS"),
    ephemeralIdleMs: minutes(int("JJ_EPHEMERAL_IDLE_MINUTES")),
    maxHeldSandboxes: int("JJ_MAX_HELD_SANDBOXES"),
    persistence: !inMemory,
    workerHeartbeat: Boolean(env.DATABASE_URL?.trim()),
  };
}

const minutes = (value: number | undefined) =>
  value === undefined ? undefined : value * 60_000;

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}
