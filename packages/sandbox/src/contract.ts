import { z } from "zod";

/**
 * Execution isolation boundary. A driver turns a SandboxSpec into a running
 * Sandbox; the agent runtime only ever talks to the Sandbox interface, so
 * swapping local/docker/daytona never reaches the orchestration layer.
 */

export const networkPolicySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("none") }),
  z.object({
    mode: z.literal("allowlist"),
    hosts: z.array(z.string().min(1)).min(1).max(256),
  }),
  z.object({ mode: z.literal("open") }),
]);

export const resourceLimitsSchema = z.object({
  cpus: z.number().positive().max(64).optional(),
  memoryMb: z.number().int().positive().max(262_144).optional(),
  diskMb: z.number().int().positive().max(4_194_304).optional(),
  processes: z.number().int().positive().max(100_000).optional(),
});

/** Where a workspace lives between sessions. `task` is the useful default: sibling sessions share files. */
export const workspaceModeSchema = z.enum(["ephemeral", "task", "bot"]);

export const sandboxLimitsSchema = z.object({
  execTimeoutMs: z.number().int().positive().max(86_400_000).default(120_000),
  maxOutputBytes: z.number().int().positive().max(100_000_000).default(262_144),
});

export const sandboxSpecSchema = z.object({
  driver: z.string().min(1),
  /** Driver-specific image, snapshot or template reference. */
  image: z.string().min(1).optional(),
  resources: resourceLimitsSchema.default({}),
  network: networkPolicySchema.default({ mode: "none" }),
  workspace: workspaceModeSchema.default("task"),
  limits: sandboxLimitsSchema.prefault({}),
  /** Non-secret environment entries. Secrets arrive separately and are never persisted here. */
  env: z.record(z.string().min(1), z.string()).default({}),
  /** Opaque per-driver settings, validated by that driver's `validateSpec`. */
  driverConfig: z.record(z.string().min(1), z.unknown()).default({}),
});

export type NetworkPolicy = z.infer<typeof networkPolicySchema>;
export type ResourceLimits = z.infer<typeof resourceLimitsSchema>;
export type WorkspaceMode = z.infer<typeof workspaceModeSchema>;
export type SandboxLimits = z.infer<typeof sandboxLimitsSchema>;
export type SandboxSpec = z.infer<typeof sandboxSpecSchema>;
export type SandboxSpecInput = z.input<typeof sandboxSpecSchema>;

/** Why a command stopped early. `unknown` means the effect may or may not have completed. */
export type Interrupted = "no" | "yes" | "unknown";

export interface ExecOptions {
  /** Workspace-relative working directory. Absolute paths and escapes are rejected. */
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
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
  interruptReason?: "timeout" | "abort" | string;
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
  release(options?: { persist?: boolean }): Promise<void>;
}

/** What a driver can actually enforce. Declared, not assumed, so the backend never over-promises. */
export interface DriverCapabilities {
  /** Enforces `network.mode` other than "open". */
  networkPolicy: boolean;
  /** Enforces `resources` limits. */
  resourceLimits: boolean;
  /** Isolates the filesystem from the host. */
  filesystemIsolation: boolean;
  exposePort: boolean;
  snapshot: boolean;
  metrics: boolean;
}

export interface AcquireRequest {
  sessionId: string;
  taskId: string;
  spec: SandboxSpec;
  /** Identity of the reusable workspace when `spec.workspace` is not "ephemeral". */
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
  /** Parses and rejects a spec this driver cannot honor. Must never silently downgrade isolation. */
  validateSpec(spec: unknown): SandboxSpec;
  /** Cheap reachability check for readiness probes. */
  probe(): Promise<DriverHealth>;
  acquire(request: AcquireRequest): Promise<Sandbox>;
}

export class SandboxPathError extends Error {
  constructor(path: string) {
    super(`Path escapes the sandbox workspace: ${path}`);
    this.name = "SandboxPathError";
  }
}

export class SandboxCapabilityError extends Error {
  constructor(driverId: string, capability: string) {
    super(`Driver ${driverId} cannot enforce ${capability}`);
    this.name = "SandboxCapabilityError";
  }
}

/**
 * Rejects a spec whose isolation requirements exceed the driver's capabilities.
 * Honesty gate: downgrading silently is how a "sandbox" stops being one.
 */
export function assertSpecSupported(
  driver: Pick<SandboxDriver, "id" | "capabilities">,
  spec: SandboxSpec,
): void {
  if (spec.network.mode !== "open" && !driver.capabilities.networkPolicy)
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
