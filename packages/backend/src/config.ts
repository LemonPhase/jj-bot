import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { TOOL_OUTPUT_PREVIEW_LIMIT } from "@jj/contracts";

export interface ArtifactLimits {
  /** Files larger than this are not snapshotted. */
  maxFileBytes: number;
  /** Most file artifacts one run records. */
  maxFilesPerRun: number;
  /** Most workspace entries listed per snapshot. */
  maxListEntries: number;
  /** Directory names never descended into. */
  ignoreDirectories: readonly string[];
}

export interface EngineConfig {
  /** Lease owner name for this worker; unique per process. */
  workerId: string;
  /** Jobs (session runs and chat replies) one worker runs at once. `JJ_CONCURRENCY`. */
  concurrency: number;
  leaseMs: number;
  /** How often the worker claims when no wake arrives. */
  pollIntervalMs: number;
  /** `JJ_MAX_SESSIONS_PER_TASK`. */
  maxSessionsPerTask: number;
  /** `JJ_MAX_DELEGATION_DEPTH`: the coordinator is depth 0. */
  maxDelegationDepth: number;
  /** `JJ_TASKS_PER_BOT_PER_HOUR`: tasks a bot may create from direct chat per hour. */
  tasksPerBotPerHour: number;
  /** `JJ_OUTPUT_CAP_BYTES`, clamped to the contract's preview limit. */
  outputCapBytes: number;
  /** Goal versions a task may reach; a further change answers GOAL_VERSION_BUDGET. */
  maxGoalVersions: number;
  /** A task's sandbox is released after this long without a run (ephemeral workspaces excepted). */
  sandboxIdleMs: number;
  /** Conversation messages a chat reply sees. */
  chatHistoryLimit: number;
  chatMaxTurns: number;
  chatTimeoutMs: number;
  artifacts: ArtifactLimits;
  /** False for an in-memory database; reported by bootstrap. */
  persistence: boolean;
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
    leaseMs: 30_000,
    pollIntervalMs: 1_000,
    maxSessionsPerTask: 16,
    maxDelegationDepth: 3,
    tasksPerBotPerHour: 10,
    outputCapBytes: TOOL_OUTPUT_PREVIEW_LIMIT,
    maxGoalVersions: 20,
    sandboxIdleMs: 10 * 60_000,
    chatHistoryLimit: 40,
    chatMaxTurns: 6,
    chatTimeoutMs: 120_000,
    persistence: true,
    streamPollMs: 15_000,
    probeTtlMs: 10_000,
    ...stripUndefined(rest),
    artifacts: {
      ...DEFAULT_ARTIFACT_LIMITS,
      ...stripUndefined(artifacts ?? {}),
    },
  };
  config.outputCapBytes = clampOutputCap(config.outputCapBytes);
  for (const key of [
    "concurrency",
    "leaseMs",
    "pollIntervalMs",
    "maxSessionsPerTask",
    "maxDelegationDepth",
    "tasksPerBotPerHour",
    "maxGoalVersions",
    "chatHistoryLimit",
    "chatMaxTurns",
  ] as const) {
    const value = config[key];
    if (!Number.isSafeInteger(value) || value < 1)
      throw new RangeError(`${key} must be a positive integer.`);
  }
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
  const mode = env.JJ_DATABASE_MODE?.trim() || "postgres";
  const path = env.JJ_DATABASE_PATH?.trim();
  return {
    concurrency: int("JJ_CONCURRENCY"),
    maxSessionsPerTask: int("JJ_MAX_SESSIONS_PER_TASK"),
    maxDelegationDepth: int("JJ_MAX_DELEGATION_DEPTH"),
    tasksPerBotPerHour: int("JJ_TASKS_PER_BOT_PER_HOUR"),
    outputCapBytes: int("JJ_OUTPUT_CAP_BYTES"),
    persistence: !(mode === "pglite" && path?.startsWith("memory://")),
  };
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}
