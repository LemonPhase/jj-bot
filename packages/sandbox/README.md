# Sandbox drivers

`@jj/sandbox` is the execution isolation boundary. The agent runtime talks only to the `Sandbox` interface; a `SandboxDriver` turns a `SandboxSpec` into a running sandbox. Swapping drivers never reaches orchestration code.

## Contract

- `validateSpec(spec)` parses a spec and **refuses anything the driver cannot enforce**. Each driver declares `capabilities` — network policy, resource limits, filesystem isolation, ports, snapshots, metrics — and `assertSpecSupported` rejects a spec that asks for more. A driver never silently weakens isolation.
- `acquire(request)` returns a sandbox for one session. The spec's `workspace` decides reuse: `ephemeral` is discarded on release, `task` is shared by a task's sessions (the default), and `bot` persists for one bot across tasks.
- `exec(command, options)` streams output through `onData`, caps captured output at `limits.maxOutputBytes` (`truncated` flags overflow so callers can spill to an artifact), and reports `interrupted` as `no`, `yes` or `unknown`. `unknown` means the command's effect may already have happened.
- `fs` accepts workspace-relative paths, or absolute paths inside the workspace. Anything that escapes throws `SandboxPathError`.
- The sandbox environment is built from scratch. The host or worker environment is never inherited; declared `env` and injected `secrets` are the only additions.

Search (grep and find) runs through `exec` with tools in the sandbox image. It is deliberately not part of `SandboxFs`, so drivers do not each reimplement it.

## Drivers

| Driver  | Isolation                                                         | Use                                          |
| ------- | ----------------------------------------------------------------- | -------------------------------------------- |
| `local` | Environment only. Shares the host kernel, filesystem and network. | Development and trusted single-user machines |

`local` refuses any `network.mode` other than `open`, and any resource limits, because it cannot enforce them. The schema defaults `network.mode` to `none`, so using `local` requires declaring `open` explicitly. Symlinks inside a workspace can still point outside it.

## Writing a driver

Implement `SandboxDriver`, then run the shared suite from a test file:

```ts
import { describeSandboxConformance } from "@jj/sandbox/conformance";

describeSandboxConformance("my-driver", () => new MyDriver(), {
  spec: { image: "my-image:latest" },
});
```

The suite asks only for isolation the driver declares. A driver that cannot pass must narrow its declared capabilities until it does.
