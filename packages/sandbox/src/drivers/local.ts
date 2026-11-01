import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  lstat,
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
 * do not *inherit* host variables or credentials, with
 * `GIT_CEILING_DIRECTORIES` set to the root so git never finds a repository
 * above it (such as a checkout the root sits in); contains `fs` paths and
 * `cwd` to the workspace, checked on real paths per call so a symlink cannot
 * lead the fs API outside (best effort against a command swapping links
 * concurrently); keeps workspaces in separate directories under a fixed root,
 * namespaced by mode (`task/<key>`, `bot/<key>`, `ephemeral/<key>-<random>`);
 * and stops the processes each sandbox starts on interruption and on release.
 * Nothing here deletes a `task` or `bot` workspace: the operator clears the
 * root. Keys that differ only by case may alias on a case-insensitive
 * filesystem.
 *
 * What it does not do: hide anything. Commands run as the server's user on the
 * host kernel, filesystem and network. They can read every file that user can
 * (a `.env`, key files, other workspaces) and the server's startup environment
 * through `/proc/$PPID/environ`. So the driver declares no isolation
 * capabilities, refuses specs that need them, and the product labels it
 * unisolated.
 *
 * Process cleanup limit: without cgroups the driver cannot guarantee that a
 * whole process tree is gone. Each command runs in its own session and process
 * group and carries a marker variable (`JJ_SANDBOX_EXEC`). On Linux the driver
 * also scans `/proc` for the command's session and for marked processes,
 * which finds descendants that left the group or session; a descendant that
 * both leaves the session and clears its environment escapes detection. A
 * process the scan cannot read (such as a non-dumpable one owned by the same
 * user) or a scan that fails makes the result `"unknown"`. Without `/proc`
 * (macOS) only the process groups are stopped, and an interrupted command
 * reports `"unknown"`. Windows is not supported.
 */

const DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
const SHELL = "/bin/sh";
const KILL_GRACE_MS = 2_000;
/** Once the process tree is gone, how long to let output drain before closing the pipes. */
const DRAIN_MS = 250;
/** How often finished commands' leftover process groups are checked, so a reused group id is never signalled. */
const PRUNE_INTERVAL_MS = 1_000;
const MARKER = "JJ_SANDBOX_EXEC";
const GIT_CEILING = "GIT_CEILING_DIRECTORIES";
const UNSUPPORTED_PLATFORM = "The local sandbox driver does not run on Windows";
/** Default workspace root, under the OS temporary directory. */
const DEFAULT_ROOT_NAME = "jj-sandbox";
/** Most `/proc` reads in flight at once during a scan. */
const SCAN_CONCURRENCY = 32;

/** Linux exposes each process's group, session and initial environment under /proc. */
const PROC_SCAN =
  process.platform === "linux" && existsSync("/proc/self/environ");

export interface LocalDriverOptions {
  /**
   * Parent directory for workspaces. Default: `JJ_SANDBOX_ROOT` from `env`,
   * else `<os.tmpdir()>/jj-sandbox`. The default is fixed rather than random,
   * so `task` and `bot` workspaces survive a server restart; the OS may still
   * clear a temporary directory, so point it somewhere durable for that. No
   * call deletes `task` or `bot` workspaces; the operator clears the root.
   */
  root?: string;
  /** Where the driver reads `JJ_SANDBOX_ROOT`. Default `process.env`. Never passed to commands. */
  env?: Readonly<Record<string, string | undefined>>;
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
 * are appended unchanged, since they cannot be links yet. `hops` counts only
 * symlinks followed, so a deep path of new directories is fine.
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
  return join(await physicalPath(parent, hops), basename(path));
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

/** The fs API, contained to `root`. The sandbox adds its lifecycle checks around it. */
function createFs(root: string): SandboxFs {
  const at = (path: string, followFinal = true) =>
    containedPath(root, path, followFinal);
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

/**
 * What a stop aims at: the sessions the driver created (each command is a
 * session and process group leader, so its group id is also its session id),
 * plus every process carrying a matching marker.
 */
interface StopTarget {
  groups: ReadonlySet<number>;
  /** `/proc` start time (clock ticks since boot) of the earliest targeted command; older processes cannot be its descendants. */
  since: number;
  marked(marker: string): boolean;
}

interface Survivors {
  groups: number[];
  pids: number[];
  /** A process could not be checked, or the scan failed: an empty result proves nothing. */
  unverified: boolean;
}

type Inspection = "unrelated" | "unverified" | { group?: number };

const UID = process.getuid?.();

/** The process exited while it was being read. Any other error leaves it unchecked. */
function exited(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ESRCH";
}

/** Fields of `/proc/<pid>/stat` from the third (state) on; `comm` may contain spaces and parens. */
const statFields = (line: string) =>
  line.slice(line.lastIndexOf(")") + 2).split(" ");
/** Index of field 22, `starttime`, in `statFields`. */
const STARTTIME = 19;

/** `/proc` start time of a live or unreaped process, in clock ticks since boot; 0 when unknown. */
function startTime(pid: number | undefined): number {
  if (!PROC_SCAN || pid === undefined) return 0;
  try {
    const fields = statFields(readFileSync(`/proc/${pid}/stat`, "latin1"));
    return Number(fields[STARTTIME]) || 0;
  } catch {
    return 0;
  }
}

/** Whether one process belongs to `target`. Reads only what it needs. */
async function inspect(pid: number, target: StopTarget): Promise<Inspection> {
  try {
    const fields = statFields(await readFile(`/proc/${pid}/stat`, "latin1"));
    const [state, , pgrp, session] = fields;
    if (state === "Z" || state === "X") return "unrelated";
    const group = Number(pgrp);
    if (target.groups.has(group)) return { group };
    if (target.groups.has(Number(session))) return {};
    // Started before the command, so it is not a descendant.
    if (Number(fields[STARTTIME]) < target.since) return "unrelated";
    const status = await readFile(`/proc/${pid}/status`, "latin1");
    const uid = /^Uid:\s*(\d+)/m.exec(status)?.[1];
    if (uid === undefined) return "unverified";
    if (Number(uid) !== UID) return "unrelated"; // Commands run as this user.
    // EACCES here (a non-dumpable process of this user) cannot rule it out.
    const environ = await readFile(`/proc/${pid}/environ`, "latin1");
    const prefix = `${MARKER}=`;
    const entry = environ.split("\0").find((item) => item.startsWith(prefix));
    return entry !== undefined && target.marked(entry.slice(prefix.length))
      ? {}
      : "unrelated";
  } catch (error) {
    return exited(error) ? "unrelated" : "unverified";
  }
}

async function findSurvivors(target: StopTarget): Promise<Survivors> {
  const groupsOnly = (): Survivors => ({
    groups: [...target.groups].filter(groupAlive),
    pids: [],
    unverified: true,
  });
  if (!PROC_SCAN) return groupsOnly();
  let names: string[];
  try {
    names = await readdir("/proc");
  } catch {
    return groupsOnly();
  }
  const pids = names
    .filter((name) => /^\d+$/.test(name))
    .map(Number)
    .filter((pid) => pid !== process.pid);
  const found: Survivors = { groups: [], pids: [], unverified: false };
  const groups = new Set<number>();
  let next = 0;
  const worker = async () => {
    for (let pid = pids[next++]; pid !== undefined; pid = pids[next++]) {
      const result = await inspect(pid, target);
      if (result === "unverified") found.unverified = true;
      else if (result !== "unrelated") {
        found.pids.push(pid);
        if (result.group !== undefined) groups.add(result.group);
      }
    }
  };
  await Promise.all(Array.from({ length: SCAN_CONCURRENCY }, worker));
  found.groups = [...groups];
  return found;
}

/**
 * SIGTERM, up to `graceMs` to exit, then SIGKILL for whatever is left. The
 * escalation never depends on a shell having exited. Resolves true only when a
 * complete `/proc` scan verified that nothing targeted survived; never rejects.
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
  // Without a complete /proc scan, a descendant that left the group cannot be ruled out.
  return empty(found) && !found.unverified;
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
  /** `/proc` start time of the first command, so release skips older processes. */
  private firstStart?: number;
  private readonly running = new Set<RunningCommand>();
  /** In-flight fs calls and exec setup, which release waits for before deleting the workspace. */
  private readonly pending = new Set<Promise<unknown>>();
  /** Process groups of finished commands that left background processes behind. */
  private readonly background = new Set<number>();
  private pruneTimer?: NodeJS.Timeout;

  constructor(
    readonly workspaceDir: string,
    /** The driver root; git never searches above it. */
    private readonly root: string,
    private readonly spec: SandboxSpec,
    private readonly secrets: Record<string, string>,
    private readonly shell: string,
    private readonly ephemeral: boolean,
    private readonly killGraceMs: number,
  ) {
    const fs = createFs(workspaceDir);
    this.fs = {
      read: (path) => this.guard(() => fs.read(path)),
      write: (path, data) => this.guard(() => fs.write(path, data)),
      remove: (path, options) => this.guard(() => fs.remove(path, options)),
      mkdir: (path) => this.guard(() => fs.mkdir(path)),
      stat: (path) => this.guard(() => fs.stat(path)),
      list: (path, options) => this.guard(() => fs.list(path, options)),
      move: (from, to) => this.guard(() => fs.move(from, to)),
    };
  }

  private assertLive(): void {
    if (this.released) throw new SandboxReleasedError(this.id);
  }

  /** Runs a workspace operation that release waits for. Rejects, never throws, once released. */
  private guard<T>(operation: () => Promise<T>): Promise<T> {
    if (this.released) return Promise.reject(new SandboxReleasedError(this.id));
    const result = operation();
    const settled: Promise<unknown> = result.then(
      () => this.pending.delete(settled),
      () => this.pending.delete(settled),
    );
    this.pending.add(settled);
    return result;
  }

  /** Built from scratch every call: the host environment is never inherited. */
  private environment(
    marker: string,
    extra?: Record<string, string>,
  ): Record<string, string> {
    const env: Record<string, string> = {
      PATH: DEFAULT_PATH,
      HOME: this.workspaceDir,
      TMPDIR: join(this.workspaceDir, ".tmp"),
      TERM: "dumb",
      ...this.spec.env,
      ...this.secrets,
      ...extra,
    };
    // git never searches above the root, so a workspace without a repository
    // of its own never reaches one that encloses the root (such as a checkout
    // the root sits in). Ceilings a spec adds are kept after it.
    env[GIT_CEILING] = [this.root, env[GIT_CEILING]]
      .filter((entry) => entry)
      .join(":");
    // Last, so nothing overrides the tag that release and interruption rely on.
    env[MARKER] = marker;
    return env;
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    const cwd = await this.guard(async () => {
      const cwd = options.cwd
        ? await containedPath(this.workspaceDir, options.cwd, true)
        : this.workspaceDir;
      await mkdir(join(this.workspaceDir, ".tmp"), { recursive: true });
      return cwd;
    });
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
    // Read before any await, while the child is alive or at least unreaped.
    const since = startTime(pgid);
    this.firstStart ??= since;

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
        { groups: new Set([pgid]), since, marked: (value) => value === marker },
        this.killGraceMs,
      )
        .catch(() => false)
        .then((verified) => {
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
    this.releasing ??= this.shutdown(options).catch((error: unknown) => {
      this.releasing = undefined; // Never cache a failure: a later call retries.
      throw error;
    });
    return this.releasing;
  }

  private async shutdown(options: { persist?: boolean }): Promise<void> {
    this.released = true;
    const running = [...this.running];
    for (const command of running) command.stop("release");
    const prefix = `${this.id}:`;
    await Promise.all([
      ...running.map((command) => command.done),
      ...this.pending,
      this.firstStart === undefined
        ? undefined
        : stopProcesses(
            {
              groups: new Set(this.background),
              since: this.firstStart,
              marked: (value) => value.startsWith(prefix),
            },
            this.killGraceMs,
          ).catch(() => false),
    ]);
    clearInterval(this.pruneTimer);
    this.pruneTimer = undefined;
    this.background.clear();
    // Only now: an fs call still in flight could otherwise recreate the directory.
    if (this.ephemeral && !options.persist)
      await rm(this.workspaceDir, { recursive: true, force: true });
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
    if (!this.rootPromise) {
      const pending = this.prepareRoot();
      this.rootPromise = pending;
      // Never cache a failure: a later probe or acquire retries.
      pending.catch(() => {
        if (this.rootPromise === pending) this.rootPromise = undefined;
      });
    }
    return this.rootPromise;
  }

  private async prepareRoot(): Promise<string> {
    const configured =
      this.options.root || (this.options.env ?? process.env).JJ_SANDBOX_ROOT;
    const base = resolve(configured || join(tmpdir(), DEFAULT_ROOT_NAME));
    await mkdir(base, { recursive: true, mode: 0o700 });
    // The default is a fixed name in a shared temp directory: refuse one that
    // another user created or replaced with a symlink.
    const info = await lstat(base);
    if (!configured && (!info.isDirectory() || info.uid !== process.getuid?.()))
      throw new Error(`${base} is not a directory owned by this user`);
    // Resolve symlinks once so containment checks match agent-visible paths.
    return realpath(base);
  }

  async acquire(request: AcquireRequest): Promise<Sandbox> {
    if (process.platform === "win32") throw new Error(UNSUPPORTED_PLATFORM);
    const spec = this.validateSpec(request.spec);
    const key = assertWorkspaceKey(request.workspaceKey);
    request.signal?.throwIfAborted();
    // Namespaced by mode, so the same key in two modes never shares files.
    const root = await this.root();
    const parent = join(root, spec.workspace);
    await mkdir(parent, { recursive: true });
    const ephemeral = spec.workspace === "ephemeral";
    const directory = ephemeral
      ? await mkdtemp(join(parent, `${key}-`))
      : join(parent, key);
    await mkdir(directory, { recursive: true });
    return new LocalSandbox(
      await realpath(directory),
      root,
      spec,
      request.secrets ?? {},
      this.options.shell ?? SHELL,
      ephemeral,
      this.options.killGraceMs ?? KILL_GRACE_MS,
    );
  }
}
