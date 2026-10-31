# Sandbox drivers

`@jj/sandbox` is the execution isolation boundary. The agent runtime talks only to the `Sandbox` interface; a `SandboxDriver` turns a `SandboxSpec` into a running sandbox. Swapping drivers never reaches orchestration code.

## Contract

- `validateSpec(spec)` parses a spec and **refuses anything the driver cannot honor**: a spec addressed to another driver (`SandboxRequestError`), isolation the driver cannot enforce (`SandboxCapabilityError`), or settings it would ignore, such as an `image` or unknown `driverConfig` keys. Each driver declares `capabilities` — `networkModes` (the `network.mode` values it really enforces), resource limits, filesystem isolation, ports, snapshots, metrics — and `assertSpecSupported` rejects a spec that asks for more. A driver never silently weakens isolation.
- `acquire(request)` returns a sandbox. The worker acquires one per task, shared by all its sessions. A workspace is identified by `spec.workspace` plus `workspaceKey`, so different keys or modes never share files: `task` (the default) persists across releases and is shared by every sandbox with the same key; `ephemeral` is fresh per acquisition and discarded on release; `bot` persists for one bot across tasks and is not used for task execution. `workspaceKey` must be 1–128 characters of `[A-Za-z0-9_-]` (`assertWorkspaceKey`), in every mode.
- `exec(command, options)` streams output through `onData` and caps captured output at `limits.maxOutputBytes` (`truncated` flags overflow so callers can spill to an artifact). A per-call `timeoutMs` can only shorten `limits.execTimeoutMs` (`resolveExecTimeoutMs`). An already-aborted `signal` means the command never starts.
- `interrupted` is `no`, `yes` or `unknown`. `yes` means the driver verified that none of the command's processes, background descendants included, are still running when `exec` resolves. `unknown` means it could not verify that, so the command's effect may already have happened or still be happening.
- `fs` and `cwd` accept workspace-relative paths, or absolute paths inside the workspace. Containment is checked on the real path after following symlinks; anything that escapes throws `SandboxPathError`. `remove` and `move` act on a symlink itself, never its target.
- `release()` stops every process the sandbox started, background ones included (commands still running resolve with `interruptReason: "release"`), then discards an `ephemeral` workspace unless `persist` is set. It is idempotent; afterwards `exec` and `fs` reject with `SandboxReleasedError`.
- The sandbox environment is built from scratch. The host or worker environment is never passed in; declared `env` and injected `secrets` are the only additions. Not passing is not hiding: only a driver that declares `filesystemIsolation` keeps the host's files and environment out of reach of agent-run code.

Search (grep and find) runs through `exec` with tools in the sandbox image. It is deliberately not part of `SandboxFs`, so drivers do not each reimplement it.

## Drivers

| Driver   | Isolation                                                                                                                                                  | Use                                          |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `local`  | None. Commands run on the host as the server's user; only the environment is built fresh.                                                                  | Development and trusted single-user machines |
| `docker` | One sibling container per sandbox: non-root, no capabilities, `no-new-privileges`, cgroup limits; named-volume workspace; no Docker socket or host mounts. | Self-hosted installs that run agent code     |

Remote drivers, such as one for Daytona, implement the same contract out of tree.

`local` declares no isolation capabilities. Its only network mode is `open`, so it refuses `none` and `allowlist`; the schema defaults `network.mode` to `none`, so using `local` requires declaring `open` explicitly. It also refuses resource limits, an `image` and any `driverConfig`, and does not run on Windows. It does not pass the server's environment into commands, but hides nothing from them: they can read every file the server's user can (a `.env`, key files, other workspaces) and the server's startup environment through `/proc/$PPID/environ`. Its fs API is contained; its commands are not.

Process cleanup on `local` is best effort without cgroups. Each command runs in its own process group and carries a `JJ_SANDBOX_EXEC` marker variable. On interruption the driver sends SIGTERM, waits a grace period, then SIGKILLs whatever is left, whether or not the command's shell has exited. On Linux it also scans `/proc` for marked processes, which catches descendants that left the group with `setsid`, and reports `yes` only when the scan finds none. A descendant that both leaves the group and clears its environment escapes detection. Without `/proc` (macOS) only process groups are stopped, and interrupted commands report `unknown`.

### `docker`

`docker` declares `networkModes: ["none", "open"]`, resource limits and filesystem isolation. `none` leaves the container only a loopback interface; `open` attaches it to the daemon's default bridge. It refuses `allowlist`, `resources.diskMb` (named volumes have no size limit) and any `driverConfig`. `cpus`, `memoryMb` (no swap beyond it) and `processes` become the container's cgroup limits; a spec without `processes` still gets a process limit (1024 by default).

Each acquired sandbox is one container created from `spec.image` (default `jj-sandbox:base-1`) through the Docker Engine API. It is never privileged and never receives the Docker socket or a host bind mount. All capabilities are dropped, `no-new-privileges` is set, the container and every command run as uid:gid 1000:1000, and docker-init is PID 1. The workspace is a named volume mounted at `/workspace`, named by mode and key: `<namespace>-task-<key>`, `<namespace>-bot-<key>`, or `<namespace>-ephemeral-<key>-<random>`, where the namespace defaults to `jj-sandbox`. Release force-removes the container, which ends its whole PID namespace, and removes an ephemeral volume. An existing volume is mounted only if it carries the driver's labels for the same mode and key and has no driver options, because a local volume with options can be a host bind mount in disguise. Every container and volume is labelled `jj.sandbox=1`, plus the sandbox, task, session and workspace it belongs to.

File access goes through exec, never host paths, so the driver works when JJ Bot itself runs in a container with only the Docker socket mounted. A shell helper runs as the sandbox user and resolves every path inside the container with `realpath -m`, so containment is checked on the path the kernel will use, and the fs API can never do more than agent code itself. Agent files never pass through the archive endpoints, which run as root in the daemon. The only archive call is the driver's own: at creation, one empty directory entry gives the volume root to uid 1000, so images without a `/workspace` work too.

Commands see the image's environment plus spec `env`, secrets and per-call `env`. Secrets are passed to each exec and never stored in the container's configuration. Every command carries a random `JJ_SANDBOX_EXEC` marker. To stop one, the driver scans `/proc` inside the container through a second exec. It sends SIGTERM, waits the grace period, then sends SIGKILL to every process that carries the command's marker or descends from one, which covers `setsid`, `nohup` and double forks. Background processes of other commands are left alone. The driver reports `yes` only when a fresh scan finds none of those processes, and no process that cannot be attributed (no marker, not under a marked process, started after the command) appears in two scans in a row. A descendant that clears its environment and leaves the process tree therefore makes the result `unknown`. Residual limit: a process that copies another command's marker, or keeps forking and exiting faster than a scan can read it, escapes attribution. Commands interrupted by release report `yes`, because the container is gone.

The Engine API address is `DOCKER_HOST` (`unix://` or plain-HTTP `tcp://`), else `/var/run/docker.sock`. That API is root-equivalent on the host, so production installs should put a filtering socket proxy in front of it and point `DOCKER_HOST` at the proxy. The driver needs only: `/_ping` and `/version`; image inspect and `POST /images/create`; volume create, inspect and remove; container create, start, inspect, `PUT …/archive` and remove; and exec create, start and inspect. `DOCKER_TLS_VERIFY` is refused rather than ignored; terminate TLS in such a proxy. Registry credentials are not supported, so private images must be pulled beforehand.

Images need `/bin/sh` and GNU coreutils, findutils and grep (`realpath -m`, `find -printf`, `grep -z`), as in Debian- or Ubuntu-based images; `acquire` checks this and fails with a clear error otherwise. `npm run sandbox:image` builds `jj-sandbox:base-1` from `images/base`: Node 22, git, python3, ripgrep, curl and CA certificates, with user `sandbox` (1000:1000) owning `/workspace`. A missing `jj-sandbox:*` image fails with build instructions; any other missing image is pulled. Bump the tag when the image changes.

What `docker` does not isolate:

- The kernel is shared. A kernel or runtime escape reaches the host; there is no gVisor or user-namespace remapping.
- `open` reaches whatever the default bridge reaches, including host services on the bridge gateway. Never expose a TCP Docker API or socket proxy where a sandbox can reach it.
- Disk use is unbounded: a sandbox can fill the daemon's volume storage.
- Limits apply per sandbox, which a task's sessions share. Commands in one sandbox run as the same user, so they can see and signal each other's processes.

The driver's tests use `jj-sandbox:base-1` when it is built and otherwise `node:22-bookworm-slim`. They skip when no daemon is reachable, and remove every container and volume they create.

## Writing a driver

Implement `SandboxDriver`, call `assertSpecSupported` and `assertWorkspaceKey`, then run the shared suite from a test file:

```ts
import { describeSandboxConformance } from "@jj/sandbox/conformance";

describeSandboxConformance("my-driver", () => new MyDriver(), {
  spec: { image: "my-image:latest" },
});
```

Construct the driver inside the factory: the suite plants a host environment canary before calling it. The suite asks only for isolation the driver declares, and checks what it declares: a driver listing `none` among `networkModes` must actually block egress, and one declaring `filesystemIsolation` must not leak the host environment through `/proc`. Drivers whose workspace is a host directory can pass `hostWorkspacePath` so the suite checks that ephemeral release deletes it. A driver that cannot pass must narrow its declared capabilities until it does.
