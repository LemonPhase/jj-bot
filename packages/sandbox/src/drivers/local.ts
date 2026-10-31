import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve, sep } from "node:path";
import {
  type AcquireRequest,
  assertSpecSupported,
  type DriverCapabilities,
  type DriverHealth,
  type ExecOptions,
  type ExecResult,
  type Sandbox,
  type SandboxDirEntry,
  type SandboxDriver,
  type SandboxFs,
  SandboxPathError,
  type SandboxSpec,
  type SandboxStat,
  sandboxSpecSchema,
} from "../contract";

/**
 * Host-process driver. Fast and dependency-free, for development and
 * single-user self-hosting on a trusted machine.
 *
 * It isolates the *environment* (no host variables, no inherited credentials)
 * and contains declared paths to the workspace, but it shares the host kernel,
 * filesystem and network. It reports that honestly through `capabilities` and
 * refuses specs it cannot enforce, so nothing upstream can mistake it for
 * real isolation. Symlinks inside the workspace can still point outward.
 */

const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const SHELL = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
const KILL_GRACE_MS = 2_000;

export interface LocalDriverOptions {
  /** Parent directory for reusable workspaces. Default: a temporary directory. */
  root?: string;
  shell?: string;
}

function containedPath(root: string, candidate: string): string {
  const resolved = isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(root, candidate);
  if (resolved !== root && !resolved.startsWith(root + sep))
    throw new SandboxPathError(candidate);
  return resolved;
}

function kind(mode: {
  isFile(): boolean;
  isDirectory(): boolean;
}): SandboxStat["kind"] {
  if (mode.isFile()) return "file";
  if (mode.isDirectory()) return "directory";
  return "other";
}

function createFs(root: string): SandboxFs {
  return {
    async read(path) {
      return readFile(containedPath(root, path));
    },
    async write(path, data) {
      const target = containedPath(root, path);
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, data);
    },
    async remove(path, options) {
      await rm(containedPath(root, path), {
        recursive: options?.recursive ?? false,
        force: true,
      });
    },
    async mkdir(path) {
      await mkdir(containedPath(root, path), { recursive: true });
    },
    async stat(path) {
      try {
        const target = containedPath(root, path);
        const info = await stat(target);
        return {
          path: target,
          kind: kind(info),
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
        };
      } catch (error) {
        if (error instanceof SandboxPathError) throw error;
        return undefined;
      }
    },
    async list(path, options) {
      const target = containedPath(root, path);
      const entries = await readdir(target, {
        withFileTypes: true,
        recursive: options?.recursive ?? false,
      });
      const results: SandboxDirEntry[] = [];
      for (const entry of entries)
        results.push({
          path: join(entry.parentPath ?? target, entry.name),
          kind: kind(entry),
        });
      return results;
    },
    async move(from, to) {
      const target = containedPath(root, to);
      await mkdir(resolve(target, ".."), { recursive: true });
      await rename(containedPath(root, from), target);
    },
  };
}

class LocalSandbox implements Sandbox {
  readonly id = randomUUID();
  readonly driverId = "local";
  readonly fs: SandboxFs;

  constructor(
    readonly workspaceDir: string,
    private readonly spec: SandboxSpec,
    private readonly secrets: Record<string, string>,
    private readonly shell: string,
    private readonly ephemeral: boolean,
  ) {
    this.fs = createFs(workspaceDir);
  }

  /** Built from scratch every call: the host environment never reaches a sandbox. */
  private environment(extra?: Record<string, string>): Record<string, string> {
    return {
      PATH: DEFAULT_PATH,
      HOME: this.workspaceDir,
      TMPDIR: join(this.workspaceDir, ".tmp"),
      TERM: "dumb",
      ...this.spec.env,
      ...this.secrets,
      ...extra,
    };
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const cwd = options.cwd
      ? containedPath(this.workspaceDir, options.cwd)
      : this.workspaceDir;
    await mkdir(join(this.workspaceDir, ".tmp"), { recursive: true });
    const timeoutMs = options.timeoutMs ?? this.spec.limits.execTimeoutMs;
    const budget = this.spec.limits.maxOutputBytes;
    const startedAt = Date.now();

    const child = spawn(this.shell, ["-c", command], {
      cwd,
      env: this.environment(options.env),
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const chunks: Record<"stdout" | "stderr", Buffer[]> = {
      stdout: [],
      stderr: [],
    };
    let written = 0;
    let truncated = false;
    const collect = (stream: "stdout" | "stderr") => (chunk: Buffer) => {
      options.onData?.(chunk, stream);
      const remaining = budget - written;
      if (remaining <= 0) {
        truncated = true;
        return;
      }
      if (chunk.length > remaining) {
        chunks[stream].push(chunk.subarray(0, remaining));
        written = budget;
        truncated = true;
        return;
      }
      chunks[stream].push(chunk);
      written += chunk.length;
    };
    child.stdout?.on("data", collect("stdout"));
    child.stderr?.on("data", collect("stderr"));

    let interrupted: ExecResult["interrupted"] = "no";
    let interruptReason: ExecResult["interruptReason"];
    const stop = (reason: "timeout" | "abort") => {
      if (interrupted !== "no") return;
      interrupted = "yes";
      interruptReason = reason;
      const { pid } = child;
      if (pid === undefined) return;
      const signal = (name: NodeJS.Signals) => {
        try {
          if (process.platform === "win32") child.kill(name);
          else process.kill(-pid, name);
        } catch {
          // The process group is already gone.
        }
      };
      signal("SIGTERM");
      const escalation = setTimeout(() => signal("SIGKILL"), KILL_GRACE_MS);
      escalation.unref();
      child.once("close", () => clearTimeout(escalation));
    };

    const deadline = setTimeout(() => stop("timeout"), timeoutMs);
    const onAbort = () => stop("abort");
    options.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const exitCode = await new Promise<number | null>((settle, fail) => {
        child.once("error", fail);
        child.once("close", (code, signalName) => {
          if (code !== null) return settle(code);
          // Report a signalled exit the way POSIX shells do.
          settle(signalName ? 128 + (constantFor(signalName) ?? 0) : null);
        });
      });
      return {
        exitCode,
        stdout: Buffer.concat(chunks.stdout).toString("utf8"),
        stderr: Buffer.concat(chunks.stderr).toString("utf8"),
        truncated,
        durationMs: Date.now() - startedAt,
        interrupted,
        ...(interruptReason ? { interruptReason } : {}),
      };
    } finally {
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  async release(options: { persist?: boolean } = {}): Promise<void> {
    if (this.ephemeral && !options.persist)
      await rm(this.workspaceDir, { recursive: true, force: true });
  }
}

function constantFor(signalName: NodeJS.Signals): number | undefined {
  const table: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  return table[signalName];
}

export class LocalSandboxDriver implements SandboxDriver {
  readonly id = "local";
  readonly capabilities: DriverCapabilities = {
    networkPolicy: false,
    resourceLimits: false,
    filesystemIsolation: false,
    exposePort: false,
    snapshot: false,
    metrics: false,
  };
  private rootPromise?: Promise<string>;

  constructor(private readonly options: LocalDriverOptions = {}) {}

  validateSpec(spec: unknown): SandboxSpec {
    const parsed = sandboxSpecSchema.parse(spec);
    assertSpecSupported(this, parsed);
    return parsed;
  }

  async probe(): Promise<DriverHealth> {
    try {
      await this.root();
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        detail: error instanceof Error ? error.message : "unavailable",
      };
    }
  }

  private root(): Promise<string> {
    this.rootPromise ??= (async () => {
      const base =
        this.options.root ?? (await mkdtemp(join(tmpdir(), "jj-sandbox-")));
      await mkdir(base, { recursive: true });
      // Resolve symlinks once so containment checks match agent-visible paths.
      return realpath(base);
    })();
    return this.rootPromise;
  }

  async acquire(request: AcquireRequest): Promise<Sandbox> {
    const spec = this.validateSpec(request.spec);
    request.signal?.throwIfAborted();
    const base = await this.root();
    const ephemeral = spec.workspace === "ephemeral";
    const directory = ephemeral
      ? await mkdtemp(join(base, "session-"))
      : join(base, encodeURIComponent(request.workspaceKey));
    await mkdir(directory, { recursive: true });
    return new LocalSandbox(
      await realpath(directory),
      spec,
      request.secrets ?? {},
      this.options.shell ?? SHELL,
      ephemeral,
    );
  }
}
