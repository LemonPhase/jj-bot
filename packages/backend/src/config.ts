import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import {
  EVENT_PAYLOAD_CAP_BYTES,
  MAX_SPEND_CAP_USD,
  MAX_UPLOAD_FILES,
  TOOL_OUTPUT_PREVIEW_LIMIT,
  UPLOAD_COMMAND_MAX_BYTES,
} from "@jj/contracts";

/** Longest `JJ_EVENT_RETENTION_DAYS`: ten years. */
export const MAX_EVENT_RETENTION_DAYS = 3650;
export const DEFAULT_EVENT_RETENTION_DAYS = 30;
/** Smallest `JJ_EVENT_PAYLOAD_CAP_BYTES`, so ordinary events never spill. */
export const MIN_EVENT_PAYLOAD_CAP_BYTES = 128 * 1024;
export const DEFAULT_EVENT_PAYLOAD_CAP_BYTES = 256 * 1024;

const MiB = 1024 * 1024;

/**
 * What the server takes as uploads (`capabilities.uploads`). Each limit is
 * set by an environment variable, up to a hard ceiling (UPLOAD_CEILINGS).
 */
export interface UploadSettings {
  /** One file (`JJ_UPLOAD_MAX_FILE_MB`, default 16 MiB, at most 64). */
  maxFileBytes: number;
  /** Files one command attaches (`JJ_UPLOAD_MAX_FILES`, default and at most 20). */
  maxFiles: number;
  /** One command's files in all: 64 MiB. */
  maxCommandBytes: number;
  /** A task's uploads in all (`JJ_UPLOAD_MAX_TASK_MB`, default 128 MiB, at most 1024). */
  maxTaskBytes: number;
  /** Staged bytes not yet attached, across the server (`JJ_UPLOAD_MAX_STAGED_MB`, default 256 MiB, at most 4096). */
  maxStagedBytes: number;
  /** Uploads one process receives at once; more answer 429 RATE_LIMITED. */
  maxInFlight: number;
  /** How long a staged upload waits to be attached before it is deleted. */
  stagedTtlMs: number;
  /**
   * The slowest an upload's body may come: under this many bytes a second
   * over `slowWindowMs` (16 KiB over 30 s), it is abandoned with 408.
   */
  minBytesPerSecond: number;
  slowWindowMs: number;
  /**
   * Extensions a name must end with (`JJ_UPLOAD_EXTENSIONS`, lowercase,
   * with the dot), or null for any regular file.
   */
  extensions: readonly string[] | null;
}

/** The highest value each upload limit may be set to. */
export const UPLOAD_CEILINGS = {
  maxFileBytes: 64 * MiB,
  maxFiles: MAX_UPLOAD_FILES,
  maxTaskBytes: 1024 * MiB,
  maxStagedBytes: 4096 * MiB,
} as const;

export const DEFAULT_UPLOAD_SETTINGS: UploadSettings = {
  maxFileBytes: 16 * MiB,
  maxFiles: MAX_UPLOAD_FILES,
  maxCommandBytes: UPLOAD_COMMAND_MAX_BYTES,
  maxTaskBytes: 128 * MiB,
  maxStagedBytes: 256 * MiB,
  maxInFlight: 4,
  stagedTtlMs: 60 * 60_000,
  minBytesPerSecond: 16 * 1024,
  slowWindowMs: 30_000,
  extensions: null,
};

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
  /**
   * With `concurrency` 1, how long a queued discovery yields to session runs
   * and chat replies before it takes the next free slot, default 60 s.
   * With more slots, a waiting discovery goes first into its own.
   */
  discoveryMaxWaitMs: number;
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
  /** What the server takes as uploads; null when it serves none (`JJ_UPLOADS=off`). */
  uploads: UploadSettings | null;
  /**
   * `JJ_EVENT_RETENTION_DAYS`: a completed, failed or cancelled task's
   * events are compacted this many days after it finished (default 30, at
   * most 3650); 0 never compacts.
   */
  eventRetentionDays: number;
  /**
   * `JJ_EVENT_PAYLOAD_CAP_BYTES`: an event payload whose JSON is larger is
   * stored in full as an `output` artifact and clipped in the event (default
   * 256 KiB, from 128 KiB to the contract's 1 MiB ceiling).
   */
  eventPayloadCapBytes: number;
  /** Time between compaction passes (one hour). */
  compactionIntervalMs: number;
  /** Most tasks one compaction pass compacts. */
  compactionMaxTasks: number;
  /** A compaction pass starts no task after this long. */
  compactionMaxMs: number;
}

export type EngineConfigInput = Partial<
  Omit<EngineConfig, "artifacts" | "uploads">
> & {
  artifacts?: Partial<ArtifactLimits>;
  uploads?: Partial<UploadSettings> | null;
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
  const { artifacts, uploads, ...rest } = input;
  const config: EngineConfig = {
    workerId: `worker-${hostname()}-${process.pid}-${randomUUID().slice(0, 8)}`,
    concurrency: 4,
    maxConcurrentDiscoveries: 1,
    discoveryAcquireMs: 60_000,
    discoveryMaxWaitMs: 60_000,
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
    eventRetentionDays: DEFAULT_EVENT_RETENTION_DAYS,
    eventPayloadCapBytes: DEFAULT_EVENT_PAYLOAD_CAP_BYTES,
    compactionIntervalMs: 60 * 60_000,
    compactionMaxTasks: 50,
    compactionMaxMs: 30_000,
    ...stripUndefined(rest),
    artifacts: {
      ...DEFAULT_ARTIFACT_LIMITS,
      ...stripUndefined(artifacts ?? {}),
    },
    uploads:
      uploads === null
        ? null
        : { ...DEFAULT_UPLOAD_SETTINGS, ...stripUndefined(uploads ?? {}) },
  };
  config.outputCapBytes = clampOutputCap(config.outputCapBytes);
  if (config.uploads) checkUploadSettings(config.uploads);
  checkRetentionDays(config.eventRetentionDays, "eventRetentionDays");
  checkPayloadCap(config.eventPayloadCapBytes, "eventPayloadCapBytes");
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
    "compactionIntervalMs",
    "compactionMaxTasks",
    "compactionMaxMs",
    "maxConcurrentDiscoveries",
    "discoveryAcquireMs",
    "discoveryMaxWaitMs",
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

function checkUploadSettings(settings: UploadSettings) {
  for (const key of [
    "maxFileBytes",
    "maxFiles",
    "maxCommandBytes",
    "maxTaskBytes",
    "maxStagedBytes",
    "maxInFlight",
    "stagedTtlMs",
    "minBytesPerSecond",
    "slowWindowMs",
  ] as const) {
    const value = settings[key];
    if (!Number.isSafeInteger(value) || value < 1)
      throw new RangeError(`uploads.${key} must be a positive integer.`);
  }
  for (const key of Object.keys(
    UPLOAD_CEILINGS,
  ) as (keyof typeof UPLOAD_CEILINGS)[])
    if (settings[key] > UPLOAD_CEILINGS[key])
      throw new RangeError(
        `uploads.${key} must be at most ${UPLOAD_CEILINGS[key]}.`,
      );
}

function checkRetentionDays(value: number, name: string): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_EVENT_RETENTION_DAYS
  )
    throw new RangeError(
      `${name} must be a whole number of days from 0 (never compact) to ${MAX_EVENT_RETENTION_DAYS}.`,
    );
  return value;
}

function checkPayloadCap(value: number, name: string): number {
  if (
    !Number.isSafeInteger(value) ||
    value < MIN_EVENT_PAYLOAD_CAP_BYTES ||
    value > EVENT_PAYLOAD_CAP_BYTES
  )
    throw new RangeError(
      `${name} must be a number of bytes from ${MIN_EVENT_PAYLOAD_CAP_BYTES} (128 KiB) to ${EVENT_PAYLOAD_CAP_BYTES} (1 MiB).`,
    );
  return value;
}

/**
 * `JJ_EVENT_RETENTION_DAYS` alone, read as `configFromEnv` reads it: the
 * default when unset. Throws on a value the server would refuse to boot with.
 */
export function eventRetentionDaysFromEnv(
  env: Readonly<Record<string, string | undefined>> = process.env,
): number {
  const raw = env.JJ_EVENT_RETENTION_DAYS?.trim();
  return raw
    ? checkRetentionDays(Number(raw), "JJ_EVENT_RETENTION_DAYS")
    : DEFAULT_EVENT_RETENTION_DAYS;
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
  const checked = (
    name: string,
    check: (value: number, name: string) => number,
  ) => {
    const raw = env[name]?.trim();
    return raw ? check(Number(raw), name) : undefined;
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
    uploads: uploadsFromEnv(env, int),
    eventRetentionDays: env.JJ_EVENT_RETENTION_DAYS?.trim()
      ? eventRetentionDaysFromEnv(env)
      : undefined,
    eventPayloadCapBytes: checked(
      "JJ_EVENT_PAYLOAD_CAP_BYTES",
      checkPayloadCap,
    ),
    persistence: !inMemory,
    workerHeartbeat: Boolean(env.DATABASE_URL?.trim()),
  };
}

/**
 * Upload settings from `JJ_UPLOADS` (`off` serves none), the
 * `JJ_UPLOAD_MAX_*` limits (megabytes are MiB) and `JJ_UPLOAD_EXTENSIONS`.
 */
function uploadsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  int: (name: string) => number | undefined,
): Partial<UploadSettings> | null {
  const switched = env.JJ_UPLOADS?.trim().toLowerCase();
  if (switched === "off" || switched === "false") return null;
  if (switched && switched !== "on" && switched !== "true")
    throw new RangeError("JJ_UPLOADS must be on or off.");
  const megabytes = (name: string, ceiling: number) => {
    const value = int(name);
    if (value === undefined) return undefined;
    if (value * MiB > ceiling)
      throw new RangeError(`${name} must be at most ${ceiling / MiB}.`);
    return value * MiB;
  };
  const maxFiles = int("JJ_UPLOAD_MAX_FILES");
  if (maxFiles !== undefined && maxFiles > UPLOAD_CEILINGS.maxFiles)
    throw new RangeError(
      `JJ_UPLOAD_MAX_FILES must be at most ${UPLOAD_CEILINGS.maxFiles}.`,
    );
  const listed = env.JJ_UPLOAD_EXTENSIONS?.trim();
  let extensions: string[] | undefined;
  if (listed) {
    extensions = listed
      .split(",")
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
      .map((entry) => (entry.startsWith(".") ? entry : `.${entry}`));
    for (const extension of extensions)
      if (!/^[.][a-z0-9][a-z0-9._+-]*$/.test(extension))
        throw new RangeError(
          `JJ_UPLOAD_EXTENSIONS: ${extension} is not a file extension; list them comma-separated, such as .csv,.txt`,
        );
  }
  return {
    maxFileBytes: megabytes(
      "JJ_UPLOAD_MAX_FILE_MB",
      UPLOAD_CEILINGS.maxFileBytes,
    ),
    maxFiles,
    maxTaskBytes: megabytes(
      "JJ_UPLOAD_MAX_TASK_MB",
      UPLOAD_CEILINGS.maxTaskBytes,
    ),
    maxStagedBytes: megabytes(
      "JJ_UPLOAD_MAX_STAGED_MB",
      UPLOAD_CEILINGS.maxStagedBytes,
    ),
    extensions,
  };
}

const minutes = (value: number | undefined) =>
  value === undefined ? undefined : value * 60_000;

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}
