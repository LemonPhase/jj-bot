import { randomBytes, randomUUID } from "node:crypto";
import { posix } from "node:path";
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
  type WorkspaceMode,
} from "../contract";
import {
  type AttachedExec,
  DockerEngine,
  DockerOutputLimitError,
  describeEndpoint,
  directoryTar,
  type ExecOutput,
  isNotFound,
  parseDockerHost,
} from "./docker-engine";
import {
  egressListeningCheck,
  egressProxyCommand,
  egressProxyEnv,
  sandboxProxyEnv,
} from "./egress";

/**
 * Container driver over the Docker Engine API. One container per acquired
 * sandbox, started as a sibling of the server through the daemon's socket
 * (or `DOCKER_HOST`), so it also works when JJ Bot itself runs in a container
 * with only the host socket mounted.
 *
 * Hardening: never privileged, every capability dropped, `no-new-privileges`,
 * uid:gid 1000:1000 for the container and every exec, a process limit, no
 * Docker socket and no host bind mounts. The workspace is a named volume
 * mounted at `/workspace`, namespaced by mode and key; ephemeral volumes are
 * removed on release.
 *
 * File access goes through exec, never host paths and never the archive
 * endpoints (which run as root in the daemon). A POSIX shell helper runs as
 * the sandbox user and resolves every path inside the container with
 * `realpath -m`, so containment is checked on the real path the kernel will
 * use, and the fs API can never do more than agent code itself could.
 *
 * Stopping a command: every exec carries a random marker variable
 * (`JJ_SANDBOX_EXEC`). A stop scans `/proc` inside the container through a
 * second exec, sends SIGTERM and then SIGKILL to every process carrying the
 * command's marker or descending from one (which covers `setsid`, `nohup` and
 * double-forked daemons), and reports `"yes"` only when a confirmation scan
 * finds none of them and no process that cannot be attributed (no marker, not
 * under any marked process, started after the command) shows up in two scans
 * in a row. A process that clears its environment and leaves the tree
 * therefore makes the result `"unknown"`. Residual limit: a process that copies another command's marker,
 * or keeps forking and exiting faster than a scan can read it, can escape
 * attribution. `release()` removes the container, which kills its whole PID
 * namespace, so commands interrupted by release report `"yes"`.
 *
 * Network mode `allowlist`: per sandbox, an internal Docker network (no
 * route out, no address on the host, IPv6 off) and an egress proxy container
 * (`egress-proxy.mjs`) on that network and the default bridge. The sandbox
 * joins only the internal network, with the proxy variables pointing at the
 * proxy, which forwards CONNECT and plain HTTP to listed public hosts only.
 * Release and `reapOrphans` remove the sandbox container, then the proxy,
 * then the network.
 *
 * Image requirements: `/bin/sh`, GNU coreutils, findutils and grep
 * (`realpath -m`, `head -z`, `find -printf`, `grep -z`), as in Debian- or Ubuntu-based
 * images such as `jj-sandbox:base-1`. `acquire` checks them and fails with a
 * clear error otherwise. The egress proxy image needs `node` 22 or later.
 */

export const DOCKER_BASE_IMAGE = "jj-sandbox:base-1";
const WORKSPACE_DIR = "/workspace";
const SANDBOX_USER = "1000:1000";
const DEFAULT_NAMESPACE = "jj-sandbox";
const DEFAULT_PIDS_LIMIT = 1024;
/** The egress proxy's cgroup limits. */
const PROXY_PIDS_LIMIT = 64;
const PROXY_MEMORY_BYTES = 256 * 1024 * 1024;
const PROXY_NANO_CPUS = 500_000_000;
/** How long a new egress proxy may take to start listening. */
const PROXY_START_MS = 15_000;
/** Keeps the bridge of an allowlist network without an address on the host. */
const INHIBIT_IPV4 = "com.docker.network.bridge.inhibit_ipv4";
const KILL_GRACE_MS = 2_000;
/** Once a stop is verified, how long output may drain before the stream is dropped. */
const DRAIN_MS = 250;
/** After a stop settles, how long to wait for the daemon to record the exit. */
const EXIT_SETTLE_MS = 500;
const KILL_ROUNDS = 25;
const MARKER = "JJ_SANDBOX_EXEC";
const MiB = 1024 * 1024;
const DEFAULT_MAX_FILE_BYTES = 32 * MiB;
const DEFAULT_MAX_LIST_ENTRIES = 20_000;
/** Ceiling on what any driver helper (list, stat, scans) may return. */
const HELPER_OUTPUT_BYTES = 16 * MiB;
/** Room for a read helper's stderr on top of the file itself. */
const READ_SLACK_BYTES = 64 * 1024;
/** Identifies this process's containers, so a later process can reap them. */
const PROCESS_INSTANCE = randomUUID();
const NAMESPACE_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,39}$/;
const IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._/:@+-]{0,511}$/;
const IPV4_SUBNET = /^\d{1,3}(?:\.\d{1,3}){3}\/\d{1,2}$/;
const ENV_NAME = /^[^=\0]+$/;

/** Labels the driver owns; extra labels may not override them. */
const LABELS = {
  sandbox: "jj.sandbox",
  id: "jj.sandbox.id",
  namespace: "jj.sandbox.namespace",
  task: "jj.sandbox.task",
  session: "jj.sandbox.session",
  mode: "jj.sandbox.workspace-mode",
  key: "jj.sandbox.workspace-key",
  volume: "jj.sandbox.volume",
  /** `egress-proxy` or `egress-network` on the resources of an allowlist sandbox. */
  role: "jj.sandbox.role",
  instance: "jj.instance",
} as const;

/** Keeps the container alive under docker-init; it holds no state. */
const IDLE_SCRIPT = "while :; do sleep 3600; done";

/** Checks the image can host a sandbox: the tools the fs helper needs, and a writable workspace. */
const READY_SCRIPT = `missing=
for tool in cat find grep head id mkdir mv realpath rm stat; do
  command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
done
if [ -n "$missing" ]; then echo "missing tools:$missing"; exit 3; fi
realpath -m -- / >/dev/null 2>&1 && find / -maxdepth 0 -printf '' 2>/dev/null &&
  printf 'x\\0' | grep -qz x 2>/dev/null && printf 'x\\0' | head -z -n 1 >/dev/null 2>&1 || {
  echo "needs GNU coreutils, findutils and grep (realpath -m, head -z, find -printf, grep -z)"; exit 3; }
[ -d "$1" ] && [ -w "$1" ] || { echo "workspace $1 is not a directory writable by uid $(id -u)"; exit 4; }`;

/**
 * Workspace file operations, run as the sandbox user: `$1` op, `$2` workspace
 * root, then lexically normalised absolute paths under it. Every path is
 * resolved with `realpath -m` (all symlinks, a dangling final one included)
 * and must stay inside the root. Exit 97 means it escapes; 95 means stat
 * found nothing; an `E…` code opening stderr names a POSIX error. `read`
 * takes a byte limit and `list` an entry limit, so neither returns more.
 */
const FS_SCRIPT = `op=$1 root=$2
fail() { printf '%s\\n' "$1" >&2; exit 1; }
real() {
  if [ "$2" = follow ] || [ "$1" = "$root" ]; then
    R=$(realpath -m -- "$1" && printf x) || exit 96
    R=\${R%??}
  else
    R=$(realpath -m -- "\${1%/*}" && printf x) || exit 96
    R=\${R%??}
    R=\${R%/}/\${1##*/}
  fi
  case $R in "$root" | "$root"/*) ;; *) exit 97 ;; esac
}
case $op in
read)
  real "$3" follow
  [ -e "$R" ] || fail ENOENT
  [ ! -d "$R" ] || fail EISDIR
  [ -f "$R" ] || fail EINVAL
  size=$(stat -L -c %s -- "$R") || exit 1
  [ "$size" -le "$4" ] || fail "EFBIG $size"
  exec head -c "$(($4 + 1))" -- "$R" ;;
write)
  real "$3" follow
  [ ! -d "$R" ] || fail EISDIR
  [ ! -e "$R" ] || [ -f "$R" ] || fail EINVAL
  mkdir -p -- "\${R%/*}" || exit 1
  exec cat > "$R" ;;
mkdir)
  real "$3" follow
  [ ! -e "$R" ] || [ -d "$R" ] || fail EEXIST
  exec mkdir -p -- "$R" ;;
remove)
  real "$3" nofollow
  [ "$R" != "$root" ] || fail EBUSY
  if [ "$4" = recursive ]; then exec rm -rf -- "$R"; fi
  if [ -d "$R" ] && [ ! -L "$R" ]; then fail EISDIR; fi
  exec rm -f -- "$R" ;;
stat)
  real "$3" follow
  [ -e "$R" ] || exit 95
  if [ -f "$R" ]; then k=file; elif [ -d "$R" ]; then k=directory; else k=other; fi
  s=$(stat -L -c '%s %.3Y' -- "$R") || exit 95
  printf '%s %s %s' "$k" "$s" "$R" ;;
list)
  real "$3" follow
  [ -e "$R" ] || fail ENOENT
  [ -d "$R" ] || fail ENOTDIR
  depth="-maxdepth 1"
  [ "$4" != recursive ] || depth=
  find "$R" -mindepth 1 $depth -printf '%y %p\\0' | head -z -n "$(($5 + 1))" ;;
move)
  real "$3" nofollow
  from=$R
  real "$4" nofollow
  [ "$from" != "$root" ] && [ "$R" != "$root" ] || fail EBUSY
  [ -e "$from" ] || [ -L "$from" ] || fail ENOENT
  mkdir -p -- "\${R%/*}" || exit 1
  exec mv -fT -- "$from" "$R" ;;
dir)
  real "$3" follow
  [ -e "$R" ] || fail ENOENT
  [ -d "$R" ] || fail ENOTDIR
  printf '%s' "$R" ;;
*) exit 2 ;;
esac`;

/**
 * Process scan, optionally signalling pids first: `$1` signal name or `-`,
 * then pids. Prints NUL-terminated records: `S<stat line>` per process,
 * `/proc/<pid>/environ:JJ_SANDBOX_EXEC=<marker>` per marked process, and
 * `A<pid>` for each listed process still alive after the marker pass, so a
 * process that exits mid-scan is never mistaken for an unmarked one.
 */
const SCAN_SCRIPT = `sig=$1
shift
if [ "$sig" != - ] && [ $# -gt 0 ]; then kill -s "$sig" "$@" 2>/dev/null; fi
seen=
for d in /proc/[0-9]*; do
  IFS= read -r st 2>/dev/null < "$d/stat" || continue
  printf 'S%s\\0' "$st"
  seen="$seen \${d#/proc/}"
done
grep -azH -m1 '^${MARKER}=' /proc/[0-9]*/environ 2>/dev/null
for p in $seen; do [ -d "/proc/$p" ] && printf 'A%s\\0' "$p"; done
exit 0`;

export interface DockerDriverOptions {
  /** Engine API address (`unix://…` or `tcp://…`). Default: `DOCKER_HOST`, else `/var/run/docker.sock`. */
  host?: string;
  /** Image for specs that name none. Default `jj-sandbox:base-1`. */
  defaultImage?: string;
  /**
   * Image of the egress proxy that network mode `allowlist` runs next to a
   * sandbox; it needs `node` 22 or later. Never the spec's image, which may
   * lack node. Default `jj-sandbox:base-1`.
   */
  egressProxyImage?: string;
  /** Prefix of container and volume names; separates installs sharing a daemon. Default `jj-sandbox`. */
  namespace?: string;
  /** Extra labels on every container and volume the driver creates. */
  labels?: Record<string, string>;
  /** How long a stopped command gets between SIGTERM and SIGKILL. Default 2000. */
  killGraceMs?: number;
  /** Process limit when a spec sets none. Default 1024. */
  defaultPidsLimit?: number;
  /** Largest file `fs.read` returns; bigger ones are refused before any transfer. Default 32 MiB. */
  maxFileBytes?: number;
  /** Most entries `fs.list` returns, recursive or not. Default 20 000. */
  maxListEntries?: number;
  /** Accept a plain-HTTP `tcp://` host that is not loopback. Default false. */
  allowInsecureTcp?: boolean;
  /**
   * Written to every container as `jj.instance`; `reapOrphans` removes the
   * namespace's containers that carry another value. Default: one random id
   * per process, so drivers in one process never reap each other.
   */
  instanceId?: string;
}

const delay = (ms: number) =>
  new Promise<void>((done) => setTimeout(done, Math.max(ms, 0)));

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

const inside = (root: string, path: string) =>
  path === root || path.startsWith(`${root}/`);

/** Lexical containment: rejects `..` escapes and absolute paths outside the root. */
function lexicalPath(root: string, candidate: string): string {
  if (typeof candidate !== "string" || candidate.includes("\0"))
    throw new SandboxPathError(String(candidate));
  const resolved = posix.isAbsolute(candidate)
    ? posix.resolve(candidate)
    : posix.resolve(root, candidate);
  if (!inside(root, resolved)) throw new SandboxPathError(candidate);
  return resolved;
}

function assertEnv(env: Record<string, string>): void {
  for (const [name, value] of Object.entries(env)) {
    if (!ENV_NAME.test(name))
      throw new SandboxRequestError(
        `Invalid environment variable name ${JSON.stringify(name)}`,
      );
    if (typeof value !== "string" || value.includes("\0"))
      throw new SandboxRequestError(
        `Invalid value for environment variable ${name}`,
      );
  }
}

const ERRNO_TEXT: Array<[RegExp, string]> = [
  [/No such file or directory/, "ENOENT"],
  [/Not a directory/, "ENOTDIR"],
  [/Is a directory/, "EISDIR"],
  [/Permission denied/, "EACCES"],
  [/Directory not empty/, "ENOTEMPTY"],
  [/File exists/, "EEXIST"],
  [/No space left on device/, "ENOSPC"],
  [/Too many levels of symbolic links/, "ELOOP"],
  [/Read-only file system/, "EROFS"],
];

function fsError(op: string, path: string, result: ExecOutput): Error {
  if (result.exitCode === 97) return new SandboxPathError(path);
  const message = result.stderr.toString("utf8").trim();
  const code = /^E[A-Z]+(?: |$)/.test(message)
    ? message.split(" ", 1)[0]
    : result.exitCode === 96
      ? "ELOOP"
      : ERRNO_TEXT.find(([pattern]) => pattern.test(message))?.[1];
  const error: NodeJS.ErrnoException = new Error(
    `${op} ${path}: ${message || code || `helper exited with ${result.exitCode}`}`,
  );
  if (code) error.code = code;
  return error;
}

function tooLarge(message: string, code: "EFBIG" | "E2BIG"): Error {
  const error: NodeJS.ErrnoException = new Error(message);
  error.code = code;
  return error;
}

const entryKind = (type: string): SandboxStat["kind"] =>
  type === "f" ? "file" : type === "d" ? "directory" : "other";

// --- Process attribution -------------------------------------------------

interface ProcessEntry {
  pid: number;
  /** Undefined when the stat line could not be parsed. */
  ppid?: number;
  /** Start time in clock ticks since boot. */
  start?: number;
  marker?: string;
}

function parseStat(line: string): ProcessEntry | "dead" | undefined {
  const pid = Number.parseInt(line, 10);
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  const close = line.lastIndexOf(")");
  if (close < 0) return { pid };
  // "pid (comm) state ppid pgrp session tty tpgid flags … starttime(22) …"
  const fields = line.slice(close + 2).split(" ");
  const state = fields[0];
  if (state === "Z" || state === "X" || state === "x") return "dead";
  const ppid = Number(fields[1]);
  const start = Number(fields[19]);
  return {
    pid,
    ppid: Number.isInteger(ppid) ? ppid : undefined,
    start: Number.isFinite(start) ? start : undefined,
  };
}

/** Live processes from a scan; ones that died during it are dropped. */
function parseProcessTable(output: Buffer): ProcessEntry[] {
  const stats = new Map<number, ProcessEntry>();
  const markers = new Map<number, string>();
  const alive = new Set<number>();
  const markerRecord = new RegExp(`^/proc/(\\d+)/environ:${MARKER}=(.*)$`, "s");
  for (const record of output.toString("latin1").split("\0")) {
    if (record.startsWith("S")) {
      const entry = parseStat(record.slice(1));
      if (entry && entry !== "dead") stats.set(entry.pid, entry);
    } else if (record.startsWith("A")) alive.add(Number(record.slice(1)));
    else {
      const match = markerRecord.exec(record);
      if (match) markers.set(Number(match[1]), match[2] ?? "");
    }
  }
  return [...stats.values()]
    .filter((entry) => alive.has(entry.pid))
    .map((entry) => ({ ...entry, marker: markers.get(entry.pid) }));
}

/** The given processes and all their descendants. */
function subtree(
  entries: ProcessEntry[],
  roots: Iterable<number>,
): Set<number> {
  const children = new Map<number, number[]>();
  for (const entry of entries) {
    if (entry.ppid === undefined) continue;
    const list = children.get(entry.ppid) ?? [];
    list.push(entry.pid);
    children.set(entry.ppid, list);
  }
  const found = new Set<number>();
  const queue = [...roots];
  for (let pid = queue.pop(); pid !== undefined; pid = queue.pop()) {
    if (found.has(pid)) continue;
    found.add(pid);
    queue.push(...(children.get(pid) ?? []));
  }
  return found;
}

/** Every process of a command: carrying its marker, or descending from one that does. */
function commandProcesses(entries: ProcessEntry[], marker: string): number[] {
  const roots = entries.filter((entry) => entry.marker === marker);
  return [
    ...subtree(
      entries,
      roots.map((entry) => entry.pid),
    ),
  ].filter((pid) => pid !== 1);
}

/**
 * Processes that belong to nothing the driver can name: not init, not the
 * idle loop (init's first child), and not under any marked process. Only ones
 * started at or after `since` (or of unknown start) are returned, since older
 * ones cannot belong to a command that started then.
 */
function unattributed(
  entries: ProcessEntry[],
  since: number | undefined,
): ProcessEntry[] {
  const idle = entries
    .filter(
      (entry) =>
        entry.ppid === 1 &&
        entry.marker === undefined &&
        entry.start !== undefined,
    )
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0) || a.pid - b.pid)[0];
  const known = subtree(entries, [
    ...(idle ? [idle.pid] : []),
    ...entries
      .filter((entry) => entry.marker !== undefined)
      .map((entry) => entry.pid),
  ]);
  known.add(1);
  return entries.filter(
    (entry) =>
      !known.has(entry.pid) &&
      (since === undefined ||
        entry.start === undefined ||
        entry.start >= since),
  );
}

// --- Sandbox ---------------------------------------------------------------

interface RunningCommand {
  stop(reason: string): void;
  done: Promise<void>;
}

/** The egress proxy container and internal network of an allowlist sandbox, by name. */
interface EgressResources {
  proxyName: string;
  networkName: string;
}

const removeContainer = (engine: DockerEngine, name: string) =>
  engine
    .json("DELETE", `/containers/${encodeURIComponent(name)}`, {
      query: { force: true, v: true },
      timeoutMs: 120_000,
    })
    .catch((error: unknown) => {
      if (!isNotFound(error)) throw error;
    });

/** Removes a network, retrying briefly while the daemon detaches removed containers. */
async function removeNetwork(
  engine: DockerEngine,
  name: string,
): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await engine.json("DELETE", `/networks/${encodeURIComponent(name)}`);
      return;
    } catch (error) {
      if (isNotFound(error)) return;
      if (attempt >= 4) throw error;
      await delay(100 * 2 ** attempt);
    }
  }
}

/** The proxy, then its network: the sandbox container must already be gone. Idempotent. */
async function removeEgress(
  engine: DockerEngine,
  egress: EgressResources,
): Promise<void> {
  await removeContainer(engine, egress.proxyName);
  await removeNetwork(engine, egress.networkName);
}

interface SandboxSetup {
  id: string;
  containerId: string;
  containerName: string;
  volumeName: string;
  egress?: EgressResources;
  engine: DockerEngine;
  spec: SandboxSpec;
  secrets: Record<string, string>;
  ephemeral: boolean;
  killGraceMs: number;
  maxFileBytes: number;
  maxListEntries: number;
}

class DockerSandbox implements Sandbox {
  readonly id: string;
  readonly driverId = "docker";
  readonly workspaceDir = WORKSPACE_DIR;
  readonly fs: SandboxFs;
  /** Docker container and volume backing this sandbox, for operators and tests. */
  readonly containerId: string;
  readonly containerName: string;
  readonly volumeName: string;
  /** Network mode `allowlist` only: the egress proxy container and the internal network. */
  readonly proxyContainerName?: string;
  readonly networkName?: string;
  private readonly egress?: EgressResources;
  private readonly engine: DockerEngine;
  private readonly spec: SandboxSpec;
  private readonly secrets: Record<string, string>;
  private readonly ephemeral: boolean;
  private readonly killGraceMs: number;
  private readonly maxFileBytes: number;
  private readonly maxListEntries: number;
  private released = false;
  private releasing?: Promise<void>;
  /** Resolves true once the container is gone, which ends every process in it. */
  private removal?: Promise<boolean>;
  private counter = 0;
  private readonly running = new Set<RunningCommand>();

  constructor(setup: SandboxSetup) {
    this.id = setup.id;
    this.containerId = setup.containerId;
    this.containerName = setup.containerName;
    this.volumeName = setup.volumeName;
    this.egress = setup.egress;
    this.proxyContainerName = setup.egress?.proxyName;
    this.networkName = setup.egress?.networkName;
    this.engine = setup.engine;
    this.spec = setup.spec;
    this.secrets = setup.secrets;
    this.ephemeral = setup.ephemeral;
    this.killGraceMs = setup.killGraceMs;
    this.maxFileBytes = setup.maxFileBytes;
    this.maxListEntries = setup.maxListEntries;
    this.fs = this.createFs();
  }

  private assertLive(): void {
    if (this.released) throw new SandboxReleasedError(this.id);
  }

  private marker(kind: "c" | "h"): string {
    return `${kind}${++this.counter}-${randomBytes(9).toString("hex")}`;
  }

  /**
   * Runs a driver helper (fs, scan, readiness) as the sandbox user, without
   * the spec env or secrets. Its output is capped at `maxBytes`, so a helper
   * can never make the worker buffer an unbounded amount.
   */
  private async helper(
    script: string,
    args: string[],
    stdin?: Buffer,
    maxBytes = HELPER_OUTPUT_BYTES,
  ): Promise<ExecOutput> {
    this.assertLive();
    try {
      return await this.engine.run(
        this.containerId,
        {
          Cmd: ["/bin/sh", "-c", script, "jj-sandbox", ...args],
          Env: ["LC_ALL=C", `${MARKER}=${this.marker("h")}`],
          User: SANDBOX_USER,
          WorkingDir: "/",
        },
        stdin,
        maxBytes,
      );
    } catch (error) {
      if (this.released) throw new SandboxReleasedError(this.id);
      throw error;
    }
  }

  /** Fails with a clear message when the image cannot host a sandbox. */
  async checkReady(image: string): Promise<void> {
    const result = await this.helper(READY_SCRIPT, [WORKSPACE_DIR]);
    if (result.exitCode !== 0)
      throw new Error(
        `Image ${image} cannot host a docker sandbox: ${
          result.stdout.toString("utf8").trim() ||
          result.stderr.toString("utf8").trim() ||
          `readiness check exited with ${result.exitCode}`
        }. Use a Debian- or Ubuntu-based image such as ${DOCKER_BASE_IMAGE}.`,
      );
  }

  private async fsCall(
    op: string,
    path: string,
    args: string[],
    stdin?: Buffer,
  ): Promise<ExecOutput> {
    const result = await this.helper(
      FS_SCRIPT,
      [op, WORKSPACE_DIR, ...args],
      stdin,
    );
    if (result.exitCode !== 0) throw fsError(op, path, result);
    return result;
  }

  private createFs(): SandboxFs {
    const at = (path: string) => {
      this.assertLive();
      return lexicalPath(WORKSPACE_DIR, path);
    };
    return {
      read: async (path) => {
        const target = at(path);
        const max = this.maxFileBytes;
        const refuse = (size?: string) =>
          tooLarge(
            `read ${path}: the file is ${size ? `${size} bytes` : "larger than the limit"}, ` +
              `over the ${max}-byte limit of fs.read (maxFileBytes); read part of it through exec, for example with head, tail or sed`,
            "EFBIG",
          );
        let result: ExecOutput;
        try {
          result = await this.helper(
            FS_SCRIPT,
            ["read", WORKSPACE_DIR, target, String(max)],
            undefined,
            max + READ_SLACK_BYTES,
          );
        } catch (error) {
          if (error instanceof DockerOutputLimitError) throw refuse();
          throw error;
        }
        if (result.exitCode !== 0) {
          const size = /^EFBIG (\d+)/.exec(result.stderr.toString("utf8"));
          if (size) throw refuse(size[1]);
          throw fsError("read", path, result);
        }
        // The file grew past the limit between the size check and the read.
        if (result.stdout.length > max) throw refuse();
        return result.stdout;
      },
      write: async (path, data) => {
        const target = at(path);
        const bytes =
          typeof data === "string"
            ? Buffer.from(data, "utf8")
            : Buffer.from(data);
        await this.fsCall("write", path, [target, ""], bytes);
      },
      remove: async (path, options) => {
        await this.fsCall("remove", path, [
          at(path),
          options?.recursive ? "recursive" : "",
        ]);
      },
      mkdir: async (path) => {
        await this.fsCall("mkdir", path, [at(path), ""]);
      },
      stat: async (path) => {
        const target = at(path);
        const result = await this.helper(FS_SCRIPT, [
          "stat",
          WORKSPACE_DIR,
          target,
          "",
        ]);
        if (result.exitCode === 97) throw new SandboxPathError(path);
        if (result.exitCode !== 0) return undefined;
        const [kind = "", size = "", modified = "", ...rest] = result.stdout
          .toString("utf8")
          .split(" ");
        return {
          path: rest.join(" "),
          kind: kind as SandboxStat["kind"],
          size: Number(size),
          modifiedAt: new Date(Number(modified) * 1000).toISOString(),
        };
      },
      list: async (path, options) => {
        const target = at(path);
        const max = this.maxListEntries;
        const refuse = (limit: string) =>
          tooLarge(
            `list ${path}: more than ${limit}, the limit of fs.list; list a narrower directory, or search through exec with find or rg`,
            "E2BIG",
          );
        let result: ExecOutput;
        try {
          result = await this.fsCall("list", path, [
            target,
            options?.recursive ? "recursive" : "",
            String(max),
          ]);
        } catch (error) {
          if (error instanceof DockerOutputLimitError)
            throw refuse(`${HELPER_OUTPUT_BYTES} bytes of entries`);
          throw error;
        }
        const entries: SandboxDirEntry[] = [];
        for (const record of result.stdout.toString("utf8").split("\0")) {
          if (record.length < 3) continue;
          entries.push({
            path: record.slice(2),
            kind: entryKind(record[0] ?? ""),
          });
        }
        // Checked first: cutting the listing short can make find complain.
        if (entries.length > max) throw refuse(`${max} entries`);
        // find's own errors (an unreadable directory) arrive on stderr.
        if (result.stderr.length > 0)
          throw fsError("list", path, { ...result, exitCode: 1 });
        return entries;
      },
      move: async (from, to) => {
        await this.fsCall("move", from, [at(from), at(to)]);
      },
    };
  }

  /** The real path of a working directory, which must be a directory inside the workspace. */
  private async workingDirectory(cwd: string): Promise<string> {
    const target = lexicalPath(WORKSPACE_DIR, cwd);
    const result = await this.fsCall("dir", cwd, [target, ""]);
    return result.stdout.toString("utf8");
  }

  /** Built from scratch: the image's own environment plus spec env, secrets and per-call env. */
  private environment(
    marker: string,
    extra: Record<string, string> = {},
  ): string[] {
    const merged: Record<string, string> = {
      ...this.spec.env,
      ...this.secrets,
      ...extra,
    };
    delete merged[MARKER];
    return [
      ...Object.entries(merged).map(([name, value]) => `${name}=${value}`),
      // Last, so nothing overrides the tag that interruption relies on.
      `${MARKER}=${marker}`,
    ];
  }

  private async processTable(signal?: "TERM" | "KILL", pids: number[] = []) {
    const result = await this.helper(SCAN_SCRIPT, [
      signal ?? "-",
      ...pids.map(String),
    ]);
    if (result.exitCode !== 0) throw new Error("process scan failed");
    return parseProcessTable(result.stdout);
  }

  /**
   * Stops one command's processes and reports whether the stop is verified:
   * none of them survive and no unattributable process appeared since the
   * command started.
   */
  private async stopCommand(marker: string): Promise<boolean> {
    try {
      let table = await this.processTable();
      const own = table.filter(
        (entry) => entry.marker === marker && entry.start !== undefined,
      );
      const since =
        own.length > 0
          ? Math.min(...own.map((entry) => entry.start ?? 0))
          : undefined;
      let targets = commandProcesses(table, marker);
      if (targets.length > 0) {
        table = await this.processTable("TERM", targets);
        targets = commandProcesses(table, marker);
        const deadline = Date.now() + this.killGraceMs;
        for (
          let pause = 20;
          targets.length > 0 && Date.now() < deadline;
          pause = Math.min(pause * 2, 200)
        ) {
          await delay(Math.min(pause, deadline - Date.now()));
          table = await this.processTable();
          targets = commandProcesses(table, marker);
        }
      }
      let suspects: ProcessEntry[] = [];
      for (let round = 0; round < KILL_ROUNDS; round++) {
        if (targets.length > 0) {
          table = await this.processTable("KILL", targets);
          targets = commandProcesses(table, marker);
          suspects = [];
          continue;
        }
        // Confirm on a fresh scan: a descendant forked during the last one is seen now.
        table = await this.processTable();
        targets = commandProcesses(table, marker);
        if (targets.length > 0) continue;
        const found = unattributed(table, since);
        if (found.length === 0) return true;
        // An exec that is still starting has no marker yet, so one sighting
        // proves nothing; the same process in two scans in a row is a survivor.
        const persistent = found.some((entry) =>
          suspects.some(
            (seen) => seen.pid === entry.pid && seen.start === entry.start,
          ),
        );
        if (persistent) return false;
        suspects = found;
      }
      return false;
    } catch {
      return this.containerStopped();
    }
  }

  /** A stopped container has no processes left. */
  private async containerStopped(): Promise<boolean> {
    try {
      const state = await this.engine.json<{ State?: { Running?: boolean } }>(
        "GET",
        `/containers/${this.containerId}/json`,
      );
      return state.State?.Running === false;
    } catch (error) {
      return isNotFound(error);
    }
  }

  async exec(command: string, options: ExecOptions = {}): Promise<ExecResult> {
    this.assertLive();
    if (options.env) assertEnv(options.env);
    const cwd =
      options.cwd === undefined
        ? WORKSPACE_DIR
        : await this.workingDirectory(options.cwd);
    const timeoutMs = resolveExecTimeoutMs(this.spec.limits, options.timeoutMs);
    const budget = this.spec.limits.maxOutputBytes;

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

    const startedAt = Date.now();
    const marker = this.marker("c");
    const chunks: Record<"stdout" | "stderr", Buffer[]> = {
      stdout: [],
      stderr: [],
    };
    let written = 0;
    let truncated = false;
    const collect = (stream: "stdout" | "stderr", chunk: Buffer) => {
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

    // "pending": not started yet, so a stop means it never runs.
    let phase: "pending" | "running" | "ended" = "pending";
    let interruptReason: string | undefined;
    let stopping: Promise<boolean> | undefined;
    let stopSettledAt: number | undefined;
    let attached: AttachedExec | undefined;

    const beginStop = () => {
      const verification =
        interruptReason === "release" && this.removal
          ? this.removal
          : this.stopCommand(marker);
      stopping = verification.then((verified) => {
        stopSettledAt = Date.now();
        // A survivor that escaped attribution may still hold the stream open.
        setTimeout(() => {
          if (phase !== "ended") attached?.destroy();
        }, DRAIN_MS).unref();
        return verified;
      });
    };
    const stop = (reason: string) => {
      if (interruptReason !== undefined || phase === "ended") return;
      interruptReason = reason;
      if (phase === "running") beginStop();
    };

    const deadline = setTimeout(() => stop("timeout"), timeoutMs);
    const onAbort = () => stop("abort");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    let finish!: () => void;
    const running: RunningCommand = {
      stop,
      done: new Promise<void>((done) => {
        finish = done;
      }),
    };
    this.running.add(running);

    const result = (
      exitCode: number | null,
      interrupted: ExecResult["interrupted"],
    ): ExecResult => ({
      exitCode,
      stdout: Buffer.concat(chunks.stdout).toString("utf8"),
      stderr: Buffer.concat(chunks.stderr).toString("utf8"),
      truncated,
      durationMs: Date.now() - startedAt,
      interrupted,
      ...(interruptReason ? { interruptReason } : {}),
    });

    try {
      let execId: string;
      try {
        execId = await this.engine.createExec(this.containerId, {
          Cmd: ["/bin/sh", "-c", command],
          Env: this.environment(marker, options.env),
          User: SANDBOX_USER,
          WorkingDir: cwd,
        });
        if (interruptReason !== undefined) return result(null, "yes");
        attached = await this.engine.startExec(execId, collect);
      } catch (error) {
        if (!this.released) throw error;
        interruptReason ??= "release";
        return result(null, (await this.removal) ? "yes" : "unknown");
      }
      phase = "running";
      if (interruptReason !== undefined) beginStop();
      await attached.ended;

      // The output can close before the process exits; wait for the exit.
      let exitCode: number | null = null;
      try {
        const state = await this.engine.waitExec(
          execId,
          () =>
            this.released ||
            (stopSettledAt !== undefined &&
              Date.now() - stopSettledAt > EXIT_SETTLE_MS),
        );
        exitCode = state.Running ? null : state.ExitCode;
      } catch (error) {
        if (!this.released) throw error;
      }
      phase = "ended";
      const verified = stopping ? await stopping : undefined;
      return result(
        exitCode,
        verified === undefined ? "no" : verified ? "yes" : "unknown",
      );
    } finally {
      phase = "ended";
      clearTimeout(deadline);
      options.signal?.removeEventListener("abort", onAbort);
      this.running.delete(running);
      finish();
    }
  }

  release(options: { persist?: boolean } = {}): Promise<void> {
    this.releasing ??= this.shutdown(options.persist ?? false).catch(
      (error) => {
        // Let a later release() retry; the sandbox stays unusable either way.
        this.releasing = undefined;
        throw error;
      },
    );
    return this.releasing;
  }

  private async shutdown(persist: boolean): Promise<void> {
    this.released = true;
    // Removing the container kills its whole PID namespace, background processes included.
    const removal = this.engine
      .json("DELETE", `/containers/${this.containerId}`, {
        query: { force: true, v: true },
        timeoutMs: 120_000,
      })
      .then(
        () => true,
        (error: unknown) => isNotFound(error),
      );
    this.removal = removal;
    const running = [...this.running];
    for (const command of running) command.stop("release");
    const removed = await removal;
    await Promise.all(running.map((command) => command.done));
    if (!removed)
      throw new Error(
        `Could not remove sandbox container ${this.containerName}; its processes may still be running`,
      );
    if (this.egress) await removeEgress(this.engine, this.egress);
    if (this.ephemeral && !persist)
      await this.engine
        .json("DELETE", `/volumes/${this.volumeName}`)
        .catch((error: unknown) => {
          if (!isNotFound(error)) throw error;
        });
  }
}

// --- Driver ----------------------------------------------------------------

interface VolumeInfo {
  Name: string;
  Driver?: string;
  Options?: Record<string, string> | null;
  Labels?: Record<string, string> | null;
}

/** Waits for `promise`, rejecting early if `signal` aborts. */
function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}

const imagePath = (image: string) =>
  image.split("/").map(encodeURIComponent).join("/");

export class DockerSandboxDriver implements SandboxDriver {
  readonly id = "docker";
  readonly capabilities: DriverCapabilities = {
    networkModes: ["none", "allowlist", "open"],
    resourceLimits: true,
    filesystemIsolation: true,
    exposePort: false,
    snapshot: false,
    metrics: false,
  };
  private readonly engine?: DockerEngine;
  private readonly endpointError?: Error;
  private readonly namespace: string;
  private readonly defaultImage: string;
  private readonly egressProxyImage: string;
  private readonly extraLabels: Record<string, string>;
  private readonly images = new Map<string, Promise<void>>();
  private readonly maxFileBytes: number;
  private readonly maxListEntries: number;
  /** The `jj.instance` label on every container this driver creates. */
  readonly instanceId: string;

  constructor(private readonly options: DockerDriverOptions = {}) {
    this.namespace = options.namespace ?? DEFAULT_NAMESPACE;
    if (!NAMESPACE_PATTERN.test(this.namespace))
      throw new Error(
        `Invalid docker driver namespace ${JSON.stringify(this.namespace)}`,
      );
    this.defaultImage = options.defaultImage ?? DOCKER_BASE_IMAGE;
    if (!IMAGE_REFERENCE.test(this.defaultImage))
      throw new Error(
        `Invalid default image ${JSON.stringify(this.defaultImage)}`,
      );
    this.egressProxyImage = options.egressProxyImage ?? DOCKER_BASE_IMAGE;
    if (!IMAGE_REFERENCE.test(this.egressProxyImage))
      throw new Error(
        `Invalid egress proxy image ${JSON.stringify(this.egressProxyImage)}`,
      );
    this.extraLabels = { ...options.labels };
    const reserved = new Set<string>(Object.values(LABELS));
    for (const name of Object.keys(this.extraLabels))
      if (reserved.has(name))
        throw new Error(`Label ${name} is reserved by the docker driver`);
    const positive = (
      name: string,
      value: number | undefined,
      fallback: number,
    ) => {
      if (value === undefined) return fallback;
      if (!Number.isSafeInteger(value) || value <= 0)
        throw new Error(`Invalid docker driver ${name} ${value}`);
      return value;
    };
    this.maxFileBytes = positive(
      "maxFileBytes",
      options.maxFileBytes,
      DEFAULT_MAX_FILE_BYTES,
    );
    this.maxListEntries = positive(
      "maxListEntries",
      options.maxListEntries,
      DEFAULT_MAX_LIST_ENTRIES,
    );
    this.instanceId = options.instanceId ?? PROCESS_INSTANCE;
    if (!this.instanceId) throw new Error("Invalid docker driver instanceId");
    try {
      this.engine = new DockerEngine(
        parseDockerHost(options.host ?? process.env.DOCKER_HOST, {
          tlsVerify:
            options.host === undefined
              ? process.env.DOCKER_TLS_VERIFY
              : undefined,
          allowInsecureTcp: options.allowInsecureTcp ?? false,
        }),
      );
    } catch (error) {
      this.endpointError =
        error instanceof Error ? error : new Error(String(error));
    }
  }

  private requireEngine(): DockerEngine {
    if (!this.engine)
      throw this.endpointError ?? new Error("Docker endpoint unavailable");
    return this.engine;
  }

  validateSpec(spec: unknown): SandboxSpec {
    const parsed = sandboxSpecSchema.parse(spec);
    assertSpecSupported(this, parsed);
    if (parsed.resources.diskMb !== undefined)
      throw new SandboxCapabilityError(
        this.id,
        "resources.diskMb: named volumes have no size limit",
      );
    if (parsed.image !== undefined && !IMAGE_REFERENCE.test(parsed.image))
      throw new SandboxRequestError(
        `Invalid image reference ${JSON.stringify(parsed.image)}`,
      );
    const configKeys = Object.keys(parsed.driverConfig);
    if (configKeys.length > 0)
      throw new SandboxRequestError(
        `Driver docker takes no driverConfig; got ${configKeys.join(", ")}`,
      );
    assertEnv(parsed.env);
    return parsed;
  }

  async probe(): Promise<DriverHealth> {
    try {
      const engine = this.requireEngine();
      await engine.ping();
      const version = await engine.apiVersion();
      return {
        ok: true,
        detail: `Docker Engine API ${version} at ${describeEndpoint(engine.endpoint)}`,
      };
    } catch (error) {
      return { ok: false, detail: errorMessage(error) };
    }
  }

  /**
   * Makes sure an image is present, pulling it when missing. `jj-sandbox:*`
   * tags are built locally, so a missing one fails with build instructions
   * instead of a pull. Registry credentials are not supported: pull private
   * images on the host beforehand.
   */
  ensureImage(
    image: string = this.defaultImage,
    signal?: AbortSignal,
  ): Promise<void> {
    let pending = this.images.get(image);
    if (!pending) {
      pending = this.findOrPull(image);
      this.images.set(image, pending);
      pending.catch(() => this.images.delete(image));
    }
    return withSignal(pending, signal);
  }

  private async findOrPull(image: string): Promise<void> {
    const engine = this.requireEngine();
    try {
      await engine.json("GET", `/images/${imagePath(image)}/json`);
      return;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
    if (image.startsWith("jj-sandbox:"))
      throw new Error(
        `Sandbox image ${image} is not built. Build it with \`npm run sandbox:image\` ` +
          `(docker build -t ${DOCKER_BASE_IMAGE} packages/sandbox/images/base).`,
      );
    try {
      await engine.pull(image);
    } catch (error) {
      throw new Error(
        `Sandbox image ${image} is not available locally and could not be pulled: ${errorMessage(error)}`,
      );
    }
  }

  /**
   * The named volume behind a workspace, created on first use. An existing
   * volume is used only if it carries this driver's labels for the same mode
   * and key and is a plain local volume: a pre-created volume with driver
   * options could be a bind mount of a host path in disguise.
   */
  private async workspaceVolume(
    mode: WorkspaceMode,
    key: string,
    sandboxId: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const name =
      mode === "ephemeral"
        ? `${this.namespace}-ephemeral-${key}-${sandboxId.slice(0, 8)}`
        : `${this.namespace}-${mode}-${key}`;
    const volume = await this.requireEngine().json<VolumeInfo>(
      "POST",
      "/volumes/create",
      {
        body: {
          Name: name,
          Driver: "local",
          Labels: {
            ...this.extraLabels,
            [LABELS.sandbox]: "1",
            [LABELS.namespace]: this.namespace,
            [LABELS.mode]: mode,
            [LABELS.key]: key,
          },
        },
        signal,
      },
    );
    const labels = volume.Labels ?? {};
    const plain =
      volume.Driver === "local" &&
      Object.keys(volume.Options ?? {}).length === 0;
    if (
      !plain ||
      labels[LABELS.namespace] !== this.namespace ||
      labels[LABELS.mode] !== mode ||
      labels[LABELS.key] !== key
    )
      throw new SandboxRequestError(
        `Volume ${name} exists but is not a plain local workspace volume created by the docker driver; refusing to mount it`,
      );
    return name;
  }

  /**
   * The sandbox container. `egress` (allowlist only) puts it on the internal
   * network alone, with the proxy variables in its environment.
   */
  private containerConfig(
    image: string,
    spec: SandboxSpec,
    volume: string,
    labels: Record<string, string>,
    egress?: { networkName: string; proxyAddress: string },
  ) {
    const { cpus, memoryMb, processes } = spec.resources;
    const memory = memoryMb === undefined ? undefined : memoryMb * MiB;
    return {
      Image: image,
      Entrypoint: ["/bin/sh", "-c", IDLE_SCRIPT],
      Cmd: [],
      User: SANDBOX_USER,
      WorkingDir: WORKSPACE_DIR,
      Env: egress ? sandboxProxyEnv(egress.proxyAddress) : [],
      Labels: labels,
      Tty: false,
      OpenStdin: false,
      AttachStdin: false,
      AttachStdout: false,
      AttachStderr: false,
      NetworkDisabled: spec.network.mode === "none",
      HostConfig: {
        Init: true,
        Privileged: false,
        CapDrop: ["ALL"],
        CapAdd: [],
        SecurityOpt: ["no-new-privileges:true"],
        NetworkMode: egress
          ? egress.networkName
          : spec.network.mode === "none"
            ? "none"
            : "bridge",
        PidsLimit:
          processes ?? this.options.defaultPidsLimit ?? DEFAULT_PIDS_LIMIT,
        ...(memory === undefined ? {} : { Memory: memory, MemorySwap: memory }),
        ...(cpus === undefined ? {} : { NanoCpus: Math.round(cpus * 1e9) }),
        Binds: [],
        Mounts: [
          {
            Type: "volume",
            Source: volume,
            Target: WORKSPACE_DIR,
            ReadOnly: false,
          },
        ],
        IpcMode: "private",
        RestartPolicy: { Name: "no" },
        LogConfig: { Type: "none", Config: {} },
      },
    };
  }

  /**
   * The egress proxy of an allowlist sandbox, hardened like a sandbox and
   * more: read-only root filesystem, small limits, no mounts, no logs, and
   * nothing in its environment but its own configuration. It starts on the
   * default bridge, its way out; the caller connects it to the internal
   * network, the only one it listens on.
   */
  private proxyConfig(
    hosts: readonly string[],
    subnet: string,
    labels: Record<string, string>,
  ) {
    return {
      Image: this.egressProxyImage,
      Entrypoint: egressProxyCommand(),
      Cmd: [],
      User: SANDBOX_USER,
      WorkingDir: "/",
      Env: egressProxyEnv(hosts, subnet),
      Labels: labels,
      Tty: false,
      OpenStdin: false,
      AttachStdin: false,
      AttachStdout: false,
      AttachStderr: false,
      HostConfig: {
        Init: true,
        Privileged: false,
        CapDrop: ["ALL"],
        CapAdd: [],
        SecurityOpt: ["no-new-privileges:true"],
        NetworkMode: "bridge",
        ReadonlyRootfs: true,
        PidsLimit: PROXY_PIDS_LIMIT,
        Memory: PROXY_MEMORY_BYTES,
        MemorySwap: PROXY_MEMORY_BYTES,
        NanoCpus: PROXY_NANO_CPUS,
        Binds: [],
        Mounts: [],
        IpcMode: "private",
        RestartPolicy: { Name: "no" },
        LogConfig: { Type: "none", Config: {} },
      },
    };
  }

  /**
   * Creates the internal network and starts the egress proxy on it, and
   * returns the proxy's address there. Fails closed: a network Docker did
   * not create as asked, or a proxy that does not start listening, fails the
   * acquire. The caller removes `egress` on failure.
   */
  private async startEgress(
    engine: DockerEngine,
    egress: EgressResources,
    hosts: readonly string[],
    labels: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<string> {
    const network = encodeURIComponent(egress.networkName);
    const proxy = encodeURIComponent(egress.proxyName);
    await engine.json("POST", "/networks/create", {
      body: {
        Name: egress.networkName,
        Driver: "bridge",
        // No route out and no forwarded DNS; with inhibit_ipv4 the host's
        // bridge gets no address, so the host is unreachable through it too.
        Internal: true,
        EnableIPv6: false,
        Attachable: false,
        Options: { [INHIBIT_IPV4]: "true" },
        Labels: { ...labels, [LABELS.role]: "egress-network" },
      },
      signal,
    });
    const info = await engine.json<{
      Internal?: boolean;
      EnableIPv6?: boolean;
      Options?: Record<string, string> | null;
      IPAM?: { Config?: Array<{ Subnet?: string }> | null };
    }>("GET", `/networks/${network}`, { signal });
    const subnet = info.IPAM?.Config?.map((config) => config.Subnet).find(
      (value): value is string =>
        typeof value === "string" && IPV4_SUBNET.test(value),
    );
    if (
      info.Internal !== true ||
      info.EnableIPv6 === true ||
      info.Options?.[INHIBIT_IPV4] !== "true" ||
      !subnet
    )
      throw new SandboxCapabilityError(
        this.id,
        `network.mode="allowlist": Docker did not create ${egress.networkName} as an internal IPv4 network without a host address`,
      );
    await engine.json("POST", "/containers/create", {
      query: { name: egress.proxyName },
      body: this.proxyConfig(hosts, subnet, {
        ...labels,
        [LABELS.role]: "egress-proxy",
      }),
      signal,
    });
    await engine.json("POST", `/networks/${network}/connect`, {
      body: { Container: egress.proxyName },
      signal,
    });
    await engine.json("POST", `/containers/${proxy}/start`, { signal });
    const state = await engine.json<{
      NetworkSettings?: {
        Networks?: Record<string, { IPAddress?: string }> | null;
      };
    }>("GET", `/containers/${proxy}/json`, { signal });
    const address =
      state.NetworkSettings?.Networks?.[egress.networkName]?.IPAddress;
    if (!address)
      throw new Error(
        `Egress proxy ${egress.proxyName} has no address on ${egress.networkName}`,
      );
    const ready = await withSignal(
      engine
        .run(egress.proxyName, {
          Cmd: egressListeningCheck(PROXY_START_MS),
          Env: [],
          User: SANDBOX_USER,
          WorkingDir: "/",
        })
        .catch(
          (error: unknown): ExecOutput => ({
            exitCode: null,
            stdout: Buffer.alloc(0),
            stderr: Buffer.from(errorMessage(error)),
          }),
        ),
      signal,
    );
    if (ready.exitCode !== 0)
      throw new Error(
        `Egress proxy ${egress.proxyName} did not start listening (its image ${this.egressProxyImage} needs node 22 or later)` +
          (ready.stderr.length > 0
            ? `: ${ready.stderr.toString("utf8").trim().slice(0, 500)}`
            : ""),
      );
    return address;
  }

  /**
   * Removes this namespace's containers that another driver instance
   * created, such as ones a crashed worker left running, sandboxes and egress
   * proxies alike, then that instance's allowlist networks. Meant to run once
   * at worker start, before the first acquire. Named workspace volumes are
   * never touched (containers go with their anonymous volumes only), so
   * `task` and `bot` files survive and a crashed worker's `ephemeral`
   * volumes stay for the operator. Two live workers must therefore not share
   * a namespace on one daemon.
   */
  async reapOrphans(): Promise<{ removed: string[] }> {
    const engine = this.requireEngine();
    const containers = await engine.json<
      Array<{ Id: string; Names?: string[]; Labels?: Record<string, string> }>
    >("GET", "/containers/json", {
      query: {
        all: true,
        filters: JSON.stringify({
          label: [
            `${LABELS.sandbox}=1`,
            `${LABELS.namespace}=${this.namespace}`,
          ],
        }),
      },
    });
    const removed: string[] = [];
    const failed: string[] = [];
    for (const container of containers) {
      if (container.Labels?.[LABELS.namespace] !== this.namespace) continue;
      if (container.Labels?.[LABELS.instance] === this.instanceId) continue;
      const name = container.Names?.[0]?.replace(/^\//, "") ?? container.Id;
      try {
        await engine.json("DELETE", `/containers/${container.Id}`, {
          query: { force: true, v: true },
          timeoutMs: 120_000,
        });
        removed.push(name);
      } catch (error) {
        if (isNotFound(error)) continue;
        failed.push(`${name} (${errorMessage(error)})`);
      }
    }
    // Networks last: a network cannot go while a container is attached.
    const networks = await engine.json<
      Array<{ Id: string; Name?: string; Labels?: Record<string, string> }>
    >("GET", "/networks", {
      query: {
        filters: JSON.stringify({
          label: [
            `${LABELS.sandbox}=1`,
            `${LABELS.namespace}=${this.namespace}`,
          ],
        }),
      },
    });
    for (const network of networks) {
      if (network.Labels?.[LABELS.namespace] !== this.namespace) continue;
      if (network.Labels?.[LABELS.instance] === this.instanceId) continue;
      const name = network.Name ?? network.Id;
      try {
        await removeNetwork(engine, network.Id);
        removed.push(name);
      } catch (error) {
        failed.push(`network ${name} (${errorMessage(error)})`);
      }
    }
    if (failed.length > 0)
      throw new Error(
        `Could not remove orphaned sandbox resources: ${failed.join(", ")}` +
          (removed.length > 0 ? `; removed ${removed.join(", ")}` : ""),
      );
    return { removed };
  }

  async acquire(request: AcquireRequest): Promise<Sandbox> {
    const spec = this.validateSpec(request.spec);
    const key = assertWorkspaceKey(request.workspaceKey);
    if (request.secrets) assertEnv(request.secrets);
    const engine = this.requireEngine();
    const { signal } = request;
    signal?.throwIfAborted();
    const image = spec.image ?? this.defaultImage;
    await this.ensureImage(image, signal);
    const allowlist =
      spec.network.mode === "allowlist" ? spec.network.hosts : undefined;
    if (allowlist) await this.ensureImage(this.egressProxyImage, signal);

    const id = randomUUID();
    const ephemeral = spec.workspace === "ephemeral";
    const volumeName = await this.workspaceVolume(
      spec.workspace,
      key,
      id,
      signal,
    );
    const containerName = `${this.namespace}-${id}`;
    const labels = {
      ...this.extraLabels,
      [LABELS.sandbox]: "1",
      [LABELS.id]: id,
      [LABELS.namespace]: this.namespace,
      [LABELS.task]: request.taskId,
      [LABELS.session]: request.sessionId,
      [LABELS.mode]: spec.workspace,
      [LABELS.key]: key,
      [LABELS.volume]: volumeName,
      [LABELS.instance]: this.instanceId,
    };
    const egress: EgressResources | undefined = allowlist
      ? {
          proxyName: `${this.namespace}-egress-${id}`,
          networkName: `${this.namespace}-net-${id}`,
        }
      : undefined;
    let containerId: string | undefined;
    try {
      const network =
        egress && allowlist
          ? {
              networkName: egress.networkName,
              proxyAddress: await this.startEgress(
                engine,
                egress,
                allowlist,
                {
                  ...this.extraLabels,
                  [LABELS.sandbox]: "1",
                  [LABELS.id]: id,
                  [LABELS.namespace]: this.namespace,
                  [LABELS.task]: request.taskId,
                  [LABELS.session]: request.sessionId,
                  [LABELS.instance]: this.instanceId,
                },
                signal,
              ),
            }
          : undefined;
      const config = this.containerConfig(
        image,
        spec,
        volumeName,
        labels,
        network,
      );
      const create = () =>
        engine.json<{ Id: string }>("POST", "/containers/create", {
          query: { name: containerName },
          body: config,
          signal,
        });
      const created = await create().catch(async (error: unknown) => {
        // The image went away since it was checked: fetch it again once.
        if (!isNotFound(error)) throw error;
        this.images.delete(image);
        await this.ensureImage(image, signal);
        return create();
      });
      containerId = created.Id;
      // Give the workspace mount point to the sandbox user. With copyUIDGID the
      // daemon chowns the extracted entry to the container's user; the entry is
      // the volume root itself, so images without a /workspace work too.
      await engine.json("PUT", `/containers/${containerId}/archive`, {
        query: { path: "/", copyUIDGID: 1 },
        body: directoryTar(WORKSPACE_DIR.slice(1)),
        contentType: "application/x-tar",
        signal,
      });
      await engine.json("POST", `/containers/${containerId}/start`, { signal });
      const sandbox = new DockerSandbox({
        id,
        containerId,
        containerName,
        volumeName,
        egress,
        engine,
        spec,
        secrets: { ...request.secrets },
        ephemeral,
        killGraceMs: this.options.killGraceMs ?? KILL_GRACE_MS,
        maxFileBytes: this.maxFileBytes,
        maxListEntries: this.maxListEntries,
      });
      await sandbox.checkReady(image);
      signal?.throwIfAborted();
      return sandbox;
    } catch (error) {
      // By name, so a container the daemon created while the call failed (an
      // abort mid-request) goes too, before the network it is attached to.
      await removeContainer(engine, containerName).catch(() => {});
      if (egress) await removeEgress(engine, egress).catch(() => {});
      if (ephemeral)
        await engine.json("DELETE", `/volumes/${volumeName}`).catch(() => {});
      throw error;
    }
  }
}
