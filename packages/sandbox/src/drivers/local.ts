import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  type AcquireRequest,
  assertSpecSupported,
  assertWorkspaceKey,
  type DriverCapabilities,
  type DriverHealth,
  type ExecOptions,
  type ExecResult,
  resolveExecTimeoutMs,
  type Sandbox,
  SandboxCapabilityError,
  type SandboxDirEntry,
  type SandboxDriver,
  type SandboxFs,
  SandboxPathError,
  SandboxReleasedError,
  SandboxRequestError,
  type SandboxSpec,
  type SandboxStat,
  sandboxSpecSchema,
} from "../contract";

/**
 * Host-process driver. Fast and dependency-free, for development and
 * single-user self-hosting on a trusted machine. It is not an isolation
 * boundary.
 *
 * What it does: builds each command's environment from scratch, so commands
 * do not *inherit* host variables or credentials; contains `fs` paths and
 * `cwd` to the workspace, checked on real paths so a symlink cannot lead the
 * fs API outside; keeps workspaces in separate directories namespaced by mode
 * (`task/<key>`, `bot/<key>`, `ephemeral/<key>-<random>`); and stops the
 * processes each sandbox starts on interruption and on release.
 *
 * What it does not do: hide anything. Commands run as the server's user on the
 * host kernel, filesystem and network. They can read every file that user can
 * (a `.env`, key files, other workspaces) and the server's startup environment
 * through `/proc/$PPID/environ`. So the driver declares no isolation
 * capabilities, refuses specs that need them, and the product labels it
 * unisolated.
 *
 * Process cleanup limit: without cgroups the driver cannot guarantee that a
 * whole process tree is gone. Each command runs in its own process group and
 * carries a marker variable (`JJ_SANDBOX_EXEC`). On Linux the driver also
 * scans `/proc` for marked processes, which finds descendants that left the
 * group with `setsid`; a descendant that both leaves the group and clears its
 * environment escapes detection. Without `/proc` (macOS) only the process
 * groups are stopped, and an interrupted command reports `"unknown"`. Windows
 * is not supported.
 */

const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const SHELL = "/bin/sh";
const KILL_GRACE_MS = 2_000;
/** Once the process tree is gone, how long to let output drain before closing the pipes. */
const DRAIN_MS = 250;
/** How often finished commands' leftover process groups are checked, so a reused group id is never signalled. */
const PRUNE_INTERVAL_MS = 1_000;
const MARKER = "JJ_SANDBOX_EXEC";
const UNSUPPORTED_PLATFORM = "The local sandbox driver does not run on Windows";

/** Linux exposes each process's group and initial environment under /proc. */
const PROC_SCAN =
  process.platform === "linux" && existsSync("/proc/self/environ");

export interface LocalDriverOptions {
  /** Parent directory for workspaces. Default: a temporary directory. */
  root?: string;
  shell?: string;
  /** How long a stopped command gets between SIGTERM and SIGKILL. Default 2000. */
  killGraceMs?: number;
}

const delay = (ms: number) =>
  new Promise<void>((done) => setTimeout(done, Math.max(ms, 0)));

const inside = (root: string, path: string) =>
  path === root || path.startsWith(root + sep);

/** Lexical containment: rejects `..` escapes and absolute paths outside the root. */
function lexicalPath(root: string, candidate: string): string {
  const resolved = isAbsolute(candidate)
    ? resolve(candidate)
    : resolve(root, candidate);
  if (!inside(root, resolved)) throw new SandboxPathError(candidate);
  return resolved;
}

/**
 * The real location of `path`: every symlink followed, including a dangling
 * final one (whose target a write would create). Missing trailing components
 * are appended unchanged, since they cannot be links yet.
 */
async function physicalPath(path: string, hops = 0): Promise<string> {
  if (hops > 64) throw new Error(`Too many symbolic links: ${path}`);
  try {
    return await realpath(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
  }
  const link = await readlink(path).catch(() => undefined);
  if (link !== undefined)
    return physicalPath(resolve(dirname(path), link), hops + 1);
  const parent = dirname(path);
  if (parent === path) return path;
  return join(await physicalPath(parent, hops + 1), basename(path));
}

/**
 * Resolves a workspace path and re-checks containment on its real path.
 * `followFinal: false` is for operations on a symlink itself (remove, rename):
 * only its parent directory has to resolve inside the workspace.
 */
async function containedPath(
  root: string,
  candidate: string,
  followFinal: boolean,
): Promise<string> {
  const lexical = lexicalPath(root, candidate);
  const real =
    followFinal || lexical === root
      ? await physicalPath(lexical)
      : join(await physicalPath(dirname(lexical)), basename(lexical));
  if (!inside(root, real)) throw new SandboxPathError(candidate);
  return real;
}

function kind(mode: {
  isFile(): boolean;
  isDirectory(): boolean;
}): SandboxStat["kind"] {
  if (mode.isFile()) return "file";
  if (mode.isDirectory()) return "directory";
  return "other";
}

function createFs(root: string, assertLive: () => void): SandboxFs {
  const at = (path: string, followFinal = true) => {
    assertLive();
    return containedPath(root, path, followFinal);
  };
  return {
    async read(path) {
      return readFile(await at(path));
    },
    async write(path, data) {
      const target = await at(path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, data);
    },
    async remove(path, options) {
      await rm(await at(path, false), {
        recursive: options?.recursive ?? false,
        force: true,
      });
    },
    async mkdir(path) {
      await mkdir(await at(path), { recursive: true });
    },
    async stat(path) {
      const target = await at(path).catch((error: unknown) => {
        if (error instanceof SandboxPathError) throw error;
        return undefined; // Unresolvable, such as a symlink loop.
      });
      if (target === undefined) return undefined;
      try {
        const info = await stat(target);
        return {
          path: target,
          kind: kind(info),
          size: info.size,
          modifiedAt: info.mtime.toISOString(),
        };
      } catch {
        return undefined;
      }
    },
    async list(path, options) {
      const target = await at(path);
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
      const source = await at(from, false);
      const target = await at(to, false);
      await mkdir(dirname(target), { recursive: true });
      await rename(source, target);
    },
  };
}

// --- Process control ------------------------------------------------------

function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // The group is already gone.
  }
}

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    // The process is already gone.
  }
}

/** True while the group has a member this user may signal. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

interface ProcessInfo {
  pid: number;
  pgid: number;
  marker?: string;
}

/** Live (non-zombie) processes with their group and marker. Linux only. */
async function listProcesses(): Promise<ProcessInfo[]> {
  const prefix = `${MARKER}=`;
  const names = await readdir("/proc");
  const found = await Promise.all(
    names.map(async (name): Promise<ProcessInfo | undefined> => {
      if (!/^\d+$/.test(name) || Number(name) === process.pid) return;
      try {
        const line = await readFile(`/proc/${name}/stat`, "latin1");
        // "pid (comm) state ppid pgrp ...": comm may contain spaces and parens.
        const [state, , pgrp] = line
          .slice(line.lastIndexOf(")") + 2)
          .split(" ");
        if (state === "Z" || state === "X") return;
        const environ = await readFile(`/proc/${name}/environ`, "latin1").catch(
          () => "",
        );
        const entry = environ
          .split("\0")
          .find((item) => item.startsWith(prefix));
        return {
          pid: Number(name),
          pgid: Number(pgrp),
          marker: entry?.slice(prefix.length),
        };
      } catch {
        return; // Exited while scanning.
      }
    }),
  );
  return found.filter((info) => info !== undefined);
}

/** What a stop aims at: process groups the driver created, plus every process carrying a matching marker. */
interface StopTarget {
  groups: ReadonlySet<number>;
  marked(marker: string): boolean;
}

interface Survivors {
  groups: number[];
  pids: number[];
}

async function findSurvivors(target: StopTarget): Promise<Survivors> {
  if (!PROC_SCAN)
    return { groups: [...target.groups].filter(groupAlive), pids: [] };
  const groups = new Set<number>();
  const pids: number[] = [];
  for (const info of await listProcesses()) {
    const member = target.groups.has(info.pgid);
    if (member) groups.add(info.pgid);
    if (member || (info.marker !== undefined && target.marked(info.marker)))
      pids.push(info.pid);
  }
  return { groups: [...groups], pids };
}

/**
 * SIGTERM, up to `graceMs` to exit, then SIGKILL for whatever is left. The
 * escalation never depends on a shell having exited. Resolves true only when a
 * `/proc` scan verified that nothing targeted survived.
 */
async function stopProcesses(
  target: StopTarget,
  graceMs: number,
): Promise<boolean> {
  const send = (found: Survivors, signal: NodeJS.Signals) => {
    for (const pgid of found.groups) signalGroup(pgid, signal);
    for (const pid of found.pids) signalProcess(pid, signal);
  };
  const empty = (found: Survivors) =>
    found.groups.length === 0 && found.pids.length === 0;

  let found = await findSurvivors(target);
  send(found, "SIGTERM");
  const deadline = Date.now() + graceMs;
  for (
    let pause = 10;
    !empty(found) && Date.now() < deadline;
    pause = Math.min(pause * 2, 100)
  ) {
    await delay(Math.min(pause, deadline - Date.now()));
    found = await findSurvivors(target);
  }
  for (let attempt = 0; !empty(found) && attempt < 40; attempt++) {
    send(found, "SIGKILL");
    await delay(25);
    found = await findSurvivors(target);
  }
  // Without /proc, a descendant that left the group cannot be ruled out.
  return PROC_SCAN && empty(found);
}

interface RunningCommand {
  stop(reason: string): void;
  done: Promise<unknown>;
}

class LocalSandbox implements Sandbox {
  readonly id = randomUUID();
  readonly driverId = "local";
  readonly fs: SandboxFs;
  private released = false;
  private releasing?: Promise<void>;
  private commands = 0;
  private readonly running = new Set<RunningCommand>();
  /** Process groups of finished commands that left background processes behind. */
  private readonly background = new Set<number>();
  private pruneTimer?: NodeJS.Timeout;

  constructor(
    readonly workspaceDir: string,
    private readonly spec: SandboxSpec,
    private readonly secrets: Record<string, string>,
    private readonly shell: string,
    private readonly ephemeral: boolean,
    private readonly killGraceMs: number,
  ) {
    this.fs = createFs(workspaceDir, () => this.assertLive());
  }

  private assertLive(): void {
    if (this.released) throw new SandboxReleasedError(this.id);
  }

  /** Built from scratch every call: the host environment is never inherited. */
  private environment(
    marker: string,
    extra?: Record<string, string>,
  ): Record<string, string> {
    return {
      PATH: DEFAULT_PATH,
      HOME: this.workspaceDir,
      TMPDIR: join(this.workspaceDir, ".tmp"),
      TERM: "dumb",
      ...this.spec.env,
      ...this.secrets,
      ...extra,
      // Last, so nothing overrides the tag that release and interruption rely on.
      [MARKER]: marker,
    };
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    this.assertLive();
    const cwd = options.cwd
      ? await containedPath(this.workspaceDir, options.cwd, true)
      : this.workspaceDir;
    await mkdir(join(this.workspaceDir, ".tmp"), { recursive: true });
    const timeoutMs = resolveExecTimeoutMs(this.spec.limits, options.timeoutMs);
    const budget = this.spec.limits.maxOutputBytes;
    const startedAt = Date.now();

    // No await between these checks and registering the command, so neither an
    // abort nor a release can slip in unseen.
    this.assertLive();
    if (options.signal?.aborted)
      return {
        exitCode: null,
        stdout: "",
        stderr: "",
        truncated: false,
        durationMs: 0,
        interrupted: "yes",
        interruptReason: "abort",
      };

    const marker = `${this.id}:${++this.commands}`;
    const child = spawn(this.shell, ["-c", command], {
      cwd,
      env: this.environment(marker, options.env),
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pgid = child.pid;

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

    let closed = false;
    const finished = new Promise<number | null>((settle, fail) => {
      child.once("error", fail);
      child.once("close", (code, signalName) => {
        closed = true;
        if (code !== null) return settle(code);
        // Report a signalled exit the way POSIX shells do.
        settle(signalName ? 128 + (constants.signals[signalName] ?? 0) : null);
      });
    });

    let interruptReason: string | undefined;
    let stopped: Promise<boolean> | undefined;
    const stop = (reason: string) => {
      if (closed || stopped || pgid === undefined) return;
      interruptReason = reason;
      stopped = stopProcesses(
        { groups: new Set([pgid]), marked: (value) => value === marker },
        this.killGraceMs,
      ).then((verified) => {
        // A descendant that escaped detection may still hold the pipes open.
        setTimeout(() => {
          if (closed) return;
          child.stdout?.destroy();
          child.stderr?.destroy();
        }, DRAIN_MS).unref();
        return verified;
      });
    };

    const deadline = setTimeout(() => stop("timeout"), timeoutMs);
    const onAbort = () => stop("abort");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const running: RunningCommand = { stop, done: finished.catch(() => {}) };
    this.running.add(running);

    try {
      const exitCode = await finished;
      clearTimeout(deadline);
      const verified = stopped ? await stopped : undefined;
      // Background processes it left keep running until release().
      if (pgid !== undefined && !this.released && groupAlive(pgid))
        this.track(pgid);
      return {
        exitCode,
        stdout: Buffer.concat(chunks.stdout).toString("utf8"),
        stderr: Buffer.concat(chunks.stderr).toString("utf8"),
        truncated,
        durationMs: Date.now() - startedAt,
        interrupted:
          verified === undefined ? "no" : verified ? "yes" : "unknown",
        ...(interruptReason ? { interruptReason } : {}),
      };
    } finally {
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", onAbort);
      this.running.delete(running);
    }
  }

  private track(pgid: number): void {
    this.background.add(pgid);
    this.pruneTimer ??= setInterval(() => {
      for (const group of this.background)
        if (!groupAlive(group)) this.background.delete(group);
      if (this.background.size === 0) {
        clearInterval(this.pruneTimer);
        this.pruneTimer = undefined;
      }
    }, PRUNE_INTERVAL_MS).unref();
  }

  release(options: { persist?: boolean } = {}): Promise<void> {
    this.releasing ??= (async () => {
      this.released = true;
      const running = [...this.running];
      for (const command of running) command.stop("release");
      const prefix = `${this.id}:`;
      await Promise.all([
        ...running.map((command) => command.done),
        stopProcesses(
          {
            groups: new Set(this.background),
            marked: (value) => value.startsWith(prefix),
          },
          this.killGraceMs,
        ),
      ]);
      clearInterval(this.pruneTimer);
      this.pruneTimer = undefined;
      this.background.clear();
      if (this.ephemeral && !options.persist)
        await rm(this.workspaceDir, { recursive: true, force: true });
    })();
    return this.releasing;
  }
}

export class LocalSandboxDriver implements SandboxDriver {
  readonly id = "local";
  readonly capabilities: DriverCapabilities = {
    networkModes: ["open"],
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
    if (parsed.image !== undefined)
      throw new SandboxCapabilityError(
        this.id,
        `image "${parsed.image}": commands run directly on the host`,
      );
    const configKeys = Object.keys(parsed.driverConfig);
    if (configKeys.length > 0)
      throw new SandboxRequestError(
        `Driver local takes no driverConfig; got ${configKeys.join(", ")}`,
      );
    return parsed;
  }

  async probe(): Promise<DriverHealth> {
    if (process.platform === "win32")
      return { ok: false, detail: UNSUPPORTED_PLATFORM };
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
    if (process.platform === "win32") throw new Error(UNSUPPORTED_PLATFORM);
    const spec = this.validateSpec(request.spec);
    const key = assertWorkspaceKey(request.workspaceKey);
    request.signal?.throwIfAborted();
    // Namespaced by mode, so the same key in two modes never shares files.
    const parent = join(await this.root(), spec.workspace);
    await mkdir(parent, { recursive: true });
    const ephemeral = spec.workspace === "ephemeral";
    const directory = ephemeral
      ? await mkdtemp(join(parent, `${key}-`))
      : join(parent, key);
    await mkdir(directory, { recursive: true });
    return new LocalSandbox(
      await realpath(directory),
      spec,
      request.secrets ?? {},
      this.options.shell ?? SHELL,
      ephemeral,
      this.options.killGraceMs ?? KILL_GRACE_MS,
    );
  }
}
