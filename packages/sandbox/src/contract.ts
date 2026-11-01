import { z } from "zod";

/**
 * Execution isolation boundary. A driver turns a SandboxSpec into a running
 * Sandbox; the agent runtime only ever talks to the Sandbox interface, so
 * swapping drivers (the in-tree `local` and `docker`, or a remote provider
 * such as Daytona) never reaches the orchestration layer.
 */

export const networkModeSchema = z.enum(["none", "allowlist", "open"]);

/**
 * One `allowlist` entry: a host name (letters, digits, hyphens and dots; IPv4
 * literals included), optionally prefixed with `*.` to match every subdomain
 * of a name of at least two labels (not the name itself), optionally followed
 * by `:port`. Without a port an entry allows ports 80 and 443. No scheme,
 * path, whitespace, IPv6 literal or bare `*`. Case-insensitive; stored
 * lowercase.
 */
export const NETWORK_HOST_PATTERN =
  /^(?:\*\.)?(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?::[0-9]{1,5})?$/;

const NETWORK_HOST_HINT =
  "Use a host such as registry.npmjs.org or *.pythonhosted.org, optionally with :port; no scheme, path or spaces.";

export const networkHostSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(260)
  .regex(NETWORK_HOST_PATTERN, NETWORK_HOST_HINT)
  .refine(
    (entry) => {
      const port = /:(\d+)$/.exec(entry)?.[1];
      return (
        port === undefined || (Number(port) >= 1 && Number(port) <= 65_535)
      );
    },
    { message: "A port must be between 1 and 65535." },
  )
  .refine(
    (entry) => {
      const name = entry.replace(/:\d+$/, "");
      return name.length <= 253 + (name.startsWith("*.") ? 2 : 0);
    },
    { message: "A host name has at most 253 characters." },
  )
  .refine(
    (entry) =>
      !entry.startsWith("*.") ||
      entry.replace(/:\d+$/, "").split(".").length > 2,
    {
      message:
        "A wildcard needs at least two labels after it, as in *.example.com.",
    },
  );

export const networkPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }),
  z.object({
    mode: z.literal("allowlist"),
    /** Duplicates (after lowercasing) are dropped. */
    hosts: z
      .array(networkHostSchema)
      .min(1)
      .max(256)
      .transform((hosts) => [...new Set(hosts)]),
  }),
  z.object({ mode: z.literal("open") }),
]);

export const resourceLimitsSchema = z.object({
  cpus: z.number().positive().max(64).optional(),
  memoryMb: z.number().int().positive().max(262_144).optional(),
  diskMb: z.number().int().positive().max(4_194_304).optional(),
  processes: z.number().int().positive().max(100_000).optional(),
});

/**
 * Lifetime of a workspace. A workspace is identified by its mode *and* its
 * `workspaceKey`: the same key in two modes never shares files.
 *
 * - `task` (default): persists across releases and is shared by every sandbox
 *   acquired with the same key. For task execution the key is the task id.
 *   No call in this contract deletes a `task` or `bot` workspace, so deleting
 *   a task does not delete its files: the operator clears a driver's storage.
 * - `ephemeral`: a fresh, empty workspace per acquisition, discarded on
 *   release unless `persist` is set. The key is not used for reuse.
 * - `bot`: persists for one bot across tasks. Task execution never uses it:
 *   it would expose a coordinator's files from earlier tasks to every
 *   participant of a later one.
 */
export const workspaceModeSchema = z.enum(["ephemeral", "task", "bot"]);

export const sandboxLimitsSchema = z.object({
  /** Ceiling for every command; a per-call `timeoutMs` can only shorten it. */
  execTimeoutMs: z.number().int().positive().max(86_400_000).default(120_000),
  maxOutputBytes: z.number().int().positive().max(100_000_000).default(262_144),
});

export const sandboxSpecSchema = z.object({
  /** Must equal the `id` of the driver that validates it. */
  driver: z.string().min(1),
  /** Driver-specific image, snapshot or template reference. A driver without images refuses it. */
  image: z.string().min(1).optional(),
  resources: resourceLimitsSchema.default({}),
  network: networkPolicySchema.default({ mode: "none" }),
  workspace: workspaceModeSchema.default("task"),
  limits: sandboxLimitsSchema.prefault({}),
  /** Non-secret environment entries. Secrets arrive separately and are never persisted here. */
  env: z.record(z.string().min(1), z.string()).default({}),
  /** Opaque per-driver settings, validated by that driver's `validateSpec`; unknown keys are refused. */
  driverConfig: z.record(z.string().min(1), z.unknown()).default({}),
});

export type NetworkMode = z.infer<typeof networkModeSchema>;
export type NetworkPolicy = z.infer<typeof networkPolicySchema>;
export type ResourceLimits = z.infer<typeof resourceLimitsSchema>;
export type WorkspaceMode = z.infer<typeof workspaceModeSchema>;
export type SandboxLimits = z.infer<typeof sandboxLimitsSchema>;
export type SandboxSpec = z.infer<typeof sandboxSpecSchema>;
export type SandboxSpecInput = z.input<typeof sandboxSpecSchema>;

/**
 * Allowed `workspaceKey` values: 1–128 characters of `[A-Za-z0-9_-]`.
 * Deliberately conservative, because drivers turn keys into directory, volume
 * or resource names: no separators, no `.` or `..`, no whitespace, no
 * encodings. Task ids (UUIDs) fit.
 *
 * Keys are compared case-sensitively. On a case-insensitive filesystem the
 * `local` driver may alias keys that differ only by case; the keys the engine
 * generates are lowercase or fixed-case ids, so they never collide that way.
 */
export const WORKSPACE_KEY_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Whether a command was stopped early.
 *
 * - `no`: it ran to completion. Background processes it started may still be
 *   running; they live until `release()`.
 * - `yes`: it was stopped (or, with an already-aborted signal, never started),
 *   and the driver verified that none of its processes, background
 *   descendants included, are still running when `exec` resolves.
 * - `unknown`: a stop was attempted but the driver cannot prove the whole
 *   process tree is gone. Its effects may have happened or still be happening.
 */
export type Interrupted = "no" | "yes" | "unknown";

export interface ExecOptions {
  /**
   * Working directory: workspace-relative, or an absolute path inside the
   * workspace. A path that resolves outside it (`..`, another absolute path,
   * or a symlink pointing out) is rejected with `SandboxPathError`.
   */
  cwd?: string;
  /** Added to the sandbox environment for this command only. */
  env?: Record<string, string>;
  /**
   * Per-call timeout. It can only shorten `spec.limits.execTimeoutMs`, never
   * extend it. Drivers apply the rule with `resolveExecTimeoutMs`.
   */
  timeoutMs?: number;
  /**
   * Stops the command when aborted (`interruptReason: "abort"`). An
   * already-aborted signal means the command never starts: `exitCode: null`,
   * `interrupted: "yes"`, and no side effects.
   */
  signal?: AbortSignal;
  onData?: (chunk: Buffer, stream: "stdout" | "stderr") => void;
}

export interface ExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** True when output hit `limits.maxOutputBytes`; callers should spill to an artifact. */
  truncated: boolean;
  durationMs: number;
  interrupted: Interrupted;
  /** Set whenever `interrupted` is not "no". `release` means the sandbox was released mid-command. */
  interruptReason?: "timeout" | "abort" | "release" | string;
}

export interface SandboxStat {
  path: string;
  kind: "file" | "directory" | "other";
  size: number;
  modifiedAt: string;
}

export interface SandboxDirEntry {
  path: string;
  kind: "file" | "directory" | "other";
}

/**
 * Workspace file access. Paths are workspace-relative, or absolute inside the
 * workspace. Containment is checked on the real path, once per call: a path
 * that leaves the workspace once symlinks are followed (including a dangling
 * link whose target would be created outside) is rejected with
 * `SandboxPathError`. The check is best effort against concurrent changes: a
 * command inside the sandbox that swaps a directory for a symlink while a call
 * runs can redirect that call. `remove` and `move` act on a symlink itself,
 * never its target, so an outward link can still be deleted or renamed.
 *
 * An isolating driver resolves paths inside the sandbox, never on the host:
 * an absolute link such as `/etc` means the sandbox's `/etc`.
 */
export interface SandboxFs {
  read(path: string): Promise<Buffer>;
  write(path: string, data: Buffer | string): Promise<void>;
  remove(path: string, options?: { recursive?: boolean }): Promise<void>;
  mkdir(path: string): Promise<void>;
  stat(path: string): Promise<SandboxStat | undefined>;
  list(
    path: string,
    options?: { recursive?: boolean },
  ): Promise<SandboxDirEntry[]>;
  move(from: string, to: string): Promise<void>;
}

export interface SandboxMetrics {
  cpuPercent?: number;
  memoryMb?: number;
  costUsd?: number;
}

export interface Sandbox {
  readonly id: string;
  readonly driverId: string;
  /** Absolute workspace root as the agent sees it. Tool cwd is always this path. */
  readonly workspaceDir: string;
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;
  readonly fs: SandboxFs;
  /** Returns a reachable URL for a port inside the sandbox. Optional capability. */
  exposePort?(port: number): Promise<string>;
  /** Returns a driver-scoped snapshot reference for retry-from-checkpoint. Optional capability. */
  snapshot?(): Promise<string>;
  metrics?(): Promise<SandboxMetrics>;
  /**
   * Ends the sandbox. Stops every process it started, background ones
   * included; commands still running resolve with `interruptReason:
   * "release"`. Then discards an `ephemeral` workspace unless `persist` is
   * set. Idempotent. Afterwards `exec` and every `fs` call reject with
   * `SandboxReleasedError`.
   */
  release(options?: { persist?: boolean }): Promise<void>;
}

/** What a driver can actually enforce. Declared, not assumed, so the backend never over-promises. */
export interface DriverCapabilities {
  /**
   * The `network.mode` values this driver can enforce; `assertSpecSupported`
   * refuses any other. List a mode only if it is really enforced: `none`
   * means egress is blocked, not merely unconfigured.
   */
  networkModes: ReadonlyArray<NetworkMode>;
  /** Enforces `resources` limits. */
  resourceLimits: boolean;
  /**
   * Agent-run code cannot reach the host filesystem, the host or worker
   * process environment (including through `/proc`), or other workspaces.
   * Model keys are kept from agent-run code only by drivers that declare this.
   */
  filesystemIsolation: boolean;
  exposePort: boolean;
  snapshot: boolean;
  metrics: boolean;
}

export interface AcquireRequest {
  /** The session that asked for the sandbox, for attribution. A task's sessions share one sandbox. */
  sessionId: string;
  taskId: string;
  spec: SandboxSpec;
  /**
   * Identity of the workspace together with `spec.workspace`: the same key in
   * `task` or `bot` mode reuses and shares files; a different key or mode
   * never does. Must match `WORKSPACE_KEY_PATTERN`; drivers check it with
   * `assertWorkspaceKey`, in every mode. Task execution passes the task id.
   */
  workspaceKey: string;
  /** Injected into the sandbox environment and never written to events or logs. */
  secrets?: Record<string, string>;
  signal?: AbortSignal;
}

export interface DriverHealth {
  ok: boolean;
  detail?: string;
}

export interface SandboxDriver {
  readonly id: string;
  readonly capabilities: DriverCapabilities;
  /**
   * Parses and rejects a spec this driver cannot honor: one addressed to
   * another driver, one asking for isolation it cannot enforce (both via
   * `assertSpecSupported`), or one carrying settings it would ignore, such as
   * an `image` or unknown `driverConfig` keys. Must never silently downgrade.
   */
  validateSpec(spec: unknown): SandboxSpec;
  /** Cheap reachability check for readiness probes. Unhealthy where the driver cannot run. */
  probe(): Promise<DriverHealth>;
  acquire(request: AcquireRequest): Promise<Sandbox>;
  /**
   * Optional. Ends sandboxes that an earlier run of the server left behind,
   * such as containers still running after a worker crash, and returns what
   * it removed. The engine calls it once at worker start, before the first
   * `acquire`, so it must never touch sandboxes of the current process.
   * Workspaces are never deleted: `task` and `bot` files survive it.
   */
  reapOrphans?(): Promise<{ removed: string[] }>;
}

export class SandboxPathError extends Error {
  constructor(path: string) {
    super(`Path escapes the sandbox workspace: ${path}`);
    this.name = "SandboxPathError";
  }
}

/** The spec asks for isolation or a setting the driver cannot enforce. */
export class SandboxCapabilityError extends Error {
  constructor(driverId: string, capability: string) {
    super(`Driver ${driverId} cannot enforce ${capability}`);
    this.name = "SandboxCapabilityError";
  }
}

/** A spec or acquire request that is malformed for this driver, such as one addressed to another driver or an invalid workspace key. */
export class SandboxRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxRequestError";
  }
}

/** A call on a sandbox after `release()`. */
export class SandboxReleasedError extends Error {
  constructor(sandboxId: string) {
    super(`Sandbox ${sandboxId} has been released`);
    this.name = "SandboxReleasedError";
  }
}

/** Throws `SandboxRequestError` unless `key` matches `WORKSPACE_KEY_PATTERN`. */
export function assertWorkspaceKey(key: unknown): string {
  if (typeof key === "string" && WORKSPACE_KEY_PATTERN.test(key)) return key;
  const shown = JSON.stringify(key)?.slice(0, 80) ?? String(key);
  throw new SandboxRequestError(
    `Invalid workspaceKey ${shown}: expected 1-128 characters of [A-Za-z0-9_-]`,
  );
}

/** Largest delay a Node timer represents; anything longer overflows and fires at once. */
export const MAX_TIMER_MS = 2_147_483_647;

/**
 * The timeout an `exec` call actually gets: the per-call value when it is a
 * positive finite number, capped by `limits.execTimeoutMs` and by what a
 * timer can represent. Anything else falls back to the limit.
 */
export function resolveExecTimeoutMs(
  limits: Pick<SandboxLimits, "execTimeoutMs">,
  requested?: number,
): number {
  const ceiling = Math.min(limits.execTimeoutMs, MAX_TIMER_MS);
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0)
    return ceiling;
  return Math.max(1, Math.min(Math.floor(requested), ceiling));
}

/**
 * Rejects a spec addressed to another driver, or whose isolation requirements
 * exceed the driver's capabilities. Honesty gate: downgrading silently is how
 * a "sandbox" stops being one. Every driver calls this from `validateSpec`.
 */
export function assertSpecSupported(
  driver: Pick<SandboxDriver, "id" | "capabilities">,
  spec: SandboxSpec,
): void {
  if (spec.driver !== driver.id)
    throw new SandboxRequestError(
      `Spec is addressed to driver "${spec.driver}", not "${driver.id}"`,
    );
  if (!driver.capabilities.networkModes.includes(spec.network.mode))
    throw new SandboxCapabilityError(
      driver.id,
      `network.mode="${spec.network.mode}"`,
    );
  const wantsLimits = Object.values(spec.resources).some(
    (value) => value !== undefined,
  );
  if (wantsLimits && !driver.capabilities.resourceLimits)
    throw new SandboxCapabilityError(driver.id, "resources");
}
