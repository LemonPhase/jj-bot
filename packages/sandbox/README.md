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

| Driver   | Isolation                                                                                           | Use                                          |
| -------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `local`  | None. Commands run on the host as the server's user; only the environment is built fresh.           | Development and trusted single-user machines |
| `docker` | Sibling containers; named-volume workspaces, no Docker socket, privileged mode or host bind mounts. | Self-hosted installs that run agent code     |

Remote drivers, such as one for Daytona, implement the same contract out of tree.

`local` declares no isolation capabilities. Its only network mode is `open`, so it refuses `none` and `allowlist`; the schema defaults `network.mode` to `none`, so using `local` requires declaring `open` explicitly. It also refuses resource limits, an `image` and any `driverConfig`, and does not run on Windows. It does not pass the server's environment into commands, but hides nothing from them: they can read every file the server's user can (a `.env`, key files, other workspaces) and the server's startup environment through `/proc/$PPID/environ`. Its fs API is contained; its commands are not.

Process cleanup on `local` is best effort without cgroups. Each command runs in its own process group and carries a `JJ_SANDBOX_EXEC` marker variable. On interruption the driver sends SIGTERM, waits a grace period, then SIGKILLs whatever is left, whether or not the command's shell has exited. On Linux it also scans `/proc` for marked processes, which catches descendants that left the group with `setsid`, and reports `yes` only when the scan finds none. A descendant that both leaves the group and clears its environment escapes detection. Without `/proc` (macOS) only process groups are stopped, and interrupted commands report `unknown`.

## Writing a driver

Implement `SandboxDriver`, call `assertSpecSupported` and `assertWorkspaceKey`, then run the shared suite from a test file:

```ts
import { describeSandboxConformance } from "@jj/sandbox/conformance";

describeSandboxConformance("my-driver", () => new MyDriver(), {
  spec: { image: "my-image:latest" },
});
```

Construct the driver inside the factory: the suite plants a host environment canary before calling it. The suite asks only for isolation the driver declares, and checks what it declares: a driver listing `none` among `networkModes` must actually block egress, and one declaring `filesystemIsolation` must not leak the host environment through `/proc`. Drivers whose workspace is a host directory can pass `hostWorkspacePath` so the suite checks that ephemeral release deletes it. A driver that cannot pass must narrow its declared capabilities until it does.
