import { lookup } from "node:dns/promises";
import { existsSync } from "node:fs";
import { type AddressInfo, createServer, isIPv4, isIPv6 } from "node:net";
import { networkInterfaces } from "node:os";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  type TestContext,
} from "vitest";
import type {
  AcquireRequest,
  NetworkMode,
  Sandbox,
  SandboxDriver,
  SandboxSpecInput,
  WorkspaceMode,
} from "./contract";
import {
  networkModeSchema,
  SandboxCapabilityError,
  SandboxPathError,
  SandboxReleasedError,
  SandboxRequestError,
} from "./contract";

/**
 * The contract every sandbox driver must satisfy, in-tree or community.
 * A driver that passes this is safe for the agent runtime to target; a driver
 * that cannot pass it must narrow its declared `capabilities` until it does.
 *
 * Commands assume a POSIX shell with coreutils-style `sleep`, `ln` and `cat`
 * in the image. Checks that need an optional tool (`setsid`, an HTTP client)
 * skip that part, or the whole test with a note, when the tool is missing.
 *
 * @example
 * describeSandboxConformance("local", () => new LocalSandboxDriver());
 */

const HOST_SECRET_VAR = "JJ_CONFORMANCE_HOST_SECRET";
const HOST_SECRET = "host-only-value";
/**
 * Set by Vitest in each worker before any module loads, so they also catch a
 * driver that copies `process.env` at import time, before the canary exists.
 */
const RUNNER_VARS = ["VITEST", "VITEST_POOL_ID", "VITEST_WORKER_ID"];

export interface ConformanceOptions {
  /** Driver-specific spec additions, such as an image or template reference. */
  spec?: Partial<SandboxSpecInput>;
  /** Raised for drivers whose sandboxes take time to start. */
  timeoutMs?: number;
  /**
   * For drivers whose workspace is a directory on the test host (like
   * `local`): returns it, so the suite can check that releasing an ephemeral
   * workspace really deletes it. Omit for drivers without a host path.
   */
  hostWorkspacePath?: (sandbox: Sandbox) => string | undefined;
}

const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** A background loop that appends to `file` every 100 ms; `ignoreTerm` makes it survive SIGTERM. */
function heartbeat(file: string, ignoreTerm: boolean): string {
  const trap = ignoreTerm ? `trap "" TERM; ` : "";
  return `sh -c '${trap}while :; do echo x >> ${file}; sleep 0.1; done' >/dev/null 2>&1`;
}

/** Starts heartbeats in the background: one in the command's process group, one under `setsid` when available. */
function backgroundHeartbeats(ignoreTerm: boolean, suffix = ""): string {
  const [group, detached] = heartbeatFiles(suffix);
  return [
    `NOHUP=$(command -v nohup || true)`,
    `$NOHUP ${heartbeat(group, ignoreTerm)} &`,
    `if command -v setsid >/dev/null 2>&1; then setsid ${heartbeat(detached, ignoreTerm)} & fi`,
  ].join("\n");
}

const heartbeatFiles = (suffix = ""): [string, string] => [
  `hb-group${suffix}`,
  `hb-setsid${suffix}`,
];

/** Fails if any heartbeat file that exists is still growing. */
async function expectHeartbeatsStopped(
  sandbox: Sandbox,
  files: string[],
): Promise<void> {
  const sizes = async () =>
    Promise.all(files.map(async (file) => (await sandbox.fs.stat(file))?.size));
  const before = await sizes();
  await delay(700);
  expect(await sizes()).toEqual(before);
}

async function waitForHeartbeat(sandbox: Sandbox, file: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (((await sandbox.fs.stat(file))?.size ?? 0) > 0) return;
    await delay(100);
  }
  throw new Error(`background heartbeat ${file} never started`);
}

export function describeSandboxConformance(
  name: string,
  createDriver: () => SandboxDriver | Promise<SandboxDriver>,
  options: ConformanceOptions = {},
): void {
  // Set before the driver exists, so a driver that snapshots process.env when
  // it is constructed is caught too.
  const previousSecret = process.env[HOST_SECRET_VAR];
  process.env[HOST_SECRET_VAR] = HOST_SECRET;

  describe(`sandbox driver conformance: ${name}`, () => {
    const testTimeout = options.timeoutMs ?? 30_000;
    let driver: SandboxDriver;
    const live: Sandbox[] = [];

    beforeAll(async () => {
      process.env[HOST_SECRET_VAR] = HOST_SECRET;
      driver = await createDriver();
    });

    afterEach(async () => {
      await Promise.all(
        live.splice(0).map((sandbox) => sandbox.release().catch(() => {})),
      );
    });

    afterAll(() => {
      if (previousSecret === undefined) delete process.env[HOST_SECRET_VAR];
      else process.env[HOST_SECRET_VAR] = previousSecret;
    });

    /** The strictest network mode the driver declares it can enforce. */
    function defaultNetwork(): SandboxSpecInput["network"] {
      const modes = driver.capabilities.networkModes;
      if (modes.includes("none")) return { mode: "none" };
      if (modes.includes("open")) return { mode: "open" };
      return { mode: "allowlist", hosts: ["example.com"] };
    }

    /** A spec this driver can actually honor: never ask for isolation it does not declare. */
    function spec(overrides: Partial<SandboxSpecInput> = {}): SandboxSpecInput {
      return {
        driver: driver.id,
        network: defaultNetwork(),
        workspace: "ephemeral",
        ...options.spec,
        ...overrides,
      };
    }

    const uniqueKey = (label = "conformance") =>
      `${label}-${Math.random().toString(36).slice(2)}`;

    async function acquire(
      overrides: Partial<SandboxSpecInput> = {},
      workspaceKey = uniqueKey(),
      extra: Partial<AcquireRequest> = {},
    ): Promise<Sandbox> {
      const sandbox = await driver.acquire({
        sessionId: "session-1",
        taskId: "task-1",
        spec: driver.validateSpec(spec(overrides)),
        workspaceKey,
        ...extra,
      });
      live.push(sandbox);
      return sandbox;
    }

    async function release(sandbox: Sandbox): Promise<void> {
      await sandbox.release();
      live.splice(live.indexOf(sandbox), 1);
    }

    it("reports a healthy probe", async () => {
      expect((await driver.probe()).ok).toBe(true);
    });

    it("declares a coherent set of network modes", () => {
      const modes = driver.capabilities.networkModes;
      expect(modes.length).toBeGreaterThan(0);
      expect(new Set(modes).size).toBe(modes.length);
      for (const mode of modes)
        expect(networkModeSchema.options).toContain(mode);
    });

    it("refuses isolation it cannot enforce", () => {
      const policies: Record<NetworkMode, SandboxSpecInput["network"]> = {
        none: { mode: "none" },
        allowlist: { mode: "allowlist", hosts: ["example.com"] },
        open: { mode: "open" },
      };
      for (const mode of networkModeSchema.options) {
        const attempt = () =>
          driver.validateSpec(spec({ network: policies[mode] }));
        if (driver.capabilities.networkModes.includes(mode))
          expect(attempt().network.mode).toBe(mode);
        else expect(attempt).toThrow(SandboxCapabilityError);
      }
      if (!driver.capabilities.resourceLimits)
        expect(() =>
          driver.validateSpec(spec({ resources: { memoryMb: 256 } })),
        ).toThrow(SandboxCapabilityError);
      expect(driver.validateSpec(spec()).driver).toBe(driver.id);
    });

    it("refuses a spec addressed to another driver", () => {
      expect(() =>
        driver.validateSpec(spec({ driver: `${driver.id}-other` })),
      ).toThrow(SandboxRequestError);
    });

    it(
      "rejects unsafe workspace keys",
      async () => {
        const unsafe = [
          "",
          ".",
          "..",
          "a/b",
          "../escape",
          "a\\b",
          "with space",
          "%2e%2e",
          "dot.ted",
          "k".repeat(129),
        ];
        for (const workspaceKey of unsafe)
          await expect(
            driver.acquire({
              sessionId: "session-1",
              taskId: "task-1",
              spec: driver.validateSpec(spec({ workspace: "task" })),
              workspaceKey,
            }),
          ).rejects.toThrow(SandboxRequestError);
        await acquire({ workspace: "task" }, `Key_${"k".repeat(120)}-1`);
      },
      testTimeout,
    );

    it(
      "captures stdout and a zero exit code",
      async () => {
        const sandbox = await acquire();
        const result = await sandbox.exec("echo hello-sandbox");
        expect(result.exitCode).toBe(0);
        expect(result.stdout.trim()).toBe("hello-sandbox");
        expect(result.interrupted).toBe("no");
        expect(result.truncated).toBe(false);
      },
      testTimeout,
    );

    it(
      "reports a non-zero exit code without throwing",
      async () => {
        const sandbox = await acquire();
        const result = await sandbox.exec("echo to-stderr >&2; exit 3");
        expect(result.exitCode).toBe(3);
        expect(result.stderr.trim()).toBe("to-stderr");
      },
      testTimeout,
    );

    it(
      "streams output incrementally rather than only at exit",
      async () => {
        const sandbox = await acquire();
        const chunks: string[] = [];
        const result = await sandbox.exec("printf a; sleep 0.2; printf b", {
          onData: (chunk, stream) => {
            if (stream === "stdout") chunks.push(chunk.toString("utf8"));
          },
        });
        expect(result.stdout).toBe("ab");
        expect(chunks.length).toBeGreaterThan(1);
      },
      testTimeout,
    );

    it(
      "runs in the workspace and honors a relative or absolute inner cwd",
      async () => {
        const sandbox = await acquire();
        await sandbox.fs.mkdir("nested/dir");
        const root = await sandbox.exec("pwd");
        expect(root.stdout.trim()).toBe(sandbox.workspaceDir);
        const nested = await sandbox.exec("pwd", { cwd: "nested/dir" });
        expect(nested.stdout.trim().endsWith("nested/dir")).toBe(true);
        const absolute = await sandbox.exec("pwd", {
          cwd: `${sandbox.workspaceDir}/nested`,
        });
        expect(absolute.stdout.trim()).toBe(`${sandbox.workspaceDir}/nested`);
      },
      testTimeout,
    );

    it(
      "never exposes the host environment",
      async () => {
        const sandbox = await acquire();
        const direct = await sandbox.exec(`echo "[$${HOST_SECRET_VAR}]"`);
        expect(direct.stdout).toContain("[]");
        const listed = await sandbox.exec("env");
        expect(listed.exitCode).toBe(0);
        expect(listed.stdout).not.toContain(HOST_SECRET);
        // Present in this process since before the driver was imported.
        expect(RUNNER_VARS.some((key) => process.env[key] !== undefined)).toBe(
          true,
        );
        const names = listed.stdout
          .split("\n")
          .map((line) => line.split("=", 1)[0]);
        for (const key of RUNNER_VARS) expect(names, key).not.toContain(key);
        if (driver.capabilities.filesystemIsolation) {
          // An isolated driver must not leak it through process metadata either.
          const proc = await sandbox.exec(
            "cat /proc/$PPID/environ /proc/1/environ 2>/dev/null | tr '\\0' '\\n'; true",
          );
          expect(proc.stdout).not.toContain(HOST_SECRET);
        }
      },
      testTimeout,
    );

    it(
      "injects declared environment entries and secrets",
      async () => {
        const sandbox = await acquire(
          { env: { JJ_DECLARED: "declared" } },
          uniqueKey("conformance-env"),
          { secrets: { JJ_SECRET: "injected" } },
        );
        const result = await sandbox.exec('echo "$JJ_DECLARED/$JJ_SECRET"');
        expect(result.stdout.trim()).toBe("declared/injected");
      },
      testTimeout,
    );

    it(
      "never starts a command whose signal is already aborted",
      async () => {
        const sandbox = await acquire();
        const result = await sandbox.exec("echo ran > aborted-marker", {
          signal: AbortSignal.abort(),
        });
        expect(result.interrupted).toBe("yes");
        expect(result.interruptReason).toBe("abort");
        expect(result.exitCode).toBeNull();
        await delay(300);
        expect(await sandbox.fs.stat("aborted-marker")).toBeUndefined();
      },
      testTimeout,
    );

    it(
      "interrupts a command that exceeds its timeout",
      async () => {
        const sandbox = await acquire();
        const result = await sandbox.exec("sleep 30", { timeoutMs: 400 });
        expect(["yes", "unknown"]).toContain(result.interrupted);
        expect(result.interruptReason).toBe("timeout");
        expect(result.durationMs).toBeLessThan(10_000);
      },
      testTimeout,
    );

    it(
      "interrupts a command when the caller aborts",
      async () => {
        const sandbox = await acquire();
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 200).unref();
        const result = await sandbox.exec("sleep 30", {
          signal: controller.signal,
        });
        expect(["yes", "unknown"]).toContain(result.interrupted);
        expect(result.interruptReason).toBe("abort");
      },
      testTimeout,
    );

    it(
      "caps a per-call timeout at the spec's execTimeoutMs",
      async () => {
        const sandbox = await acquire({ limits: { execTimeoutMs: 500 } });
        const result = await sandbox.exec("sleep 30", { timeoutMs: 600_000 });
        expect(["yes", "unknown"]).toContain(result.interrupted);
        expect(result.interruptReason).toBe("timeout");
        expect(result.durationMs).toBeLessThan(10_000);
      },
      testTimeout,
    );

    it(
      "treats an oversized timeout as the limit rather than overflowing",
      async () => {
        const sandbox = await acquire();
        const result = await sandbox.exec("sleep 0.3; echo done", {
          timeoutMs: 2 ** 40,
        });
        expect(result.interrupted).toBe("no");
        expect(result.stdout.trim()).toBe("done");
      },
      testTimeout,
    );

    for (const reason of ["timeout", "abort"] as const)
      it(
        `reports "yes" after a ${reason} only once no TERM-ignoring descendant survives`,
        async () => {
          const sandbox = await acquire();
          const controller = new AbortController();
          if (reason === "abort")
            setTimeout(() => controller.abort(), 1_000).unref();
          const result = await sandbox.exec(
            `${backgroundHeartbeats(true)}\nsleep 30`,
            reason === "timeout"
              ? { timeoutMs: 1_000 }
              : { signal: controller.signal },
          );
          expect(result.interruptReason).toBe(reason);
          expect(["yes", "unknown"]).toContain(result.interrupted);
          expect((await sandbox.fs.stat("hb-group"))?.size).toBeGreaterThan(0);
          // "unknown" is honest; "yes" must be true when exec resolves.
          if (result.interrupted === "yes")
            await expectHeartbeatsStopped(sandbox, heartbeatFiles());
        },
        testTimeout,
      );

    it(
      "stops background processes the sandbox started when it is released",
      async () => {
        const key = uniqueKey("conformance-release");
        const first = await acquire({ workspace: "task" }, key);
        const started = await first.exec(
          `${backgroundHeartbeats(false)}\n${backgroundHeartbeats(true, "-term")}`,
        );
        expect(started.exitCode).toBe(0);
        expect(started.interrupted).toBe("no");
        await waitForHeartbeat(first, "hb-group");
        await waitForHeartbeat(first, "hb-group-term");
        await release(first);
        const second = await acquire({ workspace: "task" }, key);
        await expectHeartbeatsStopped(second, [
          ...heartbeatFiles(),
          ...heartbeatFiles("-term"),
        ]);
      },
      testTimeout,
    );

    it(
      "round-trips files and lists directory entries",
      async () => {
        const sandbox = await acquire();
        await sandbox.fs.write("docs/note.txt", "written by conformance");
        expect((await sandbox.fs.read("docs/note.txt")).toString("utf8")).toBe(
          "written by conformance",
        );
        expect(
          (
            await sandbox.fs.read(`${sandbox.workspaceDir}/docs/note.txt`)
          ).toString("utf8"),
        ).toBe("written by conformance");
        expect((await sandbox.fs.stat("docs/note.txt"))?.kind).toBe("file");
        const entries = await sandbox.fs.list("docs");
        expect(entries.some((entry) => entry.path.endsWith("note.txt"))).toBe(
          true,
        );
        await sandbox.fs.move("docs/note.txt", "docs/moved.txt");
        expect(await sandbox.fs.stat("docs/note.txt")).toBeUndefined();
        await sandbox.fs.remove("docs", { recursive: true });
        expect(await sandbox.fs.stat("docs")).toBeUndefined();
      },
      testTimeout,
    );

    it(
      "rejects paths that escape the workspace",
      async () => {
        const sandbox = await acquire();
        const sibling = `${sandbox.workspaceDir}-evil`;
        await expect(sandbox.fs.read("../../etc/passwd")).rejects.toThrow(
          SandboxPathError,
        );
        await expect(sandbox.fs.write("../escaped.txt", "no")).rejects.toThrow(
          SandboxPathError,
        );
        await expect(sandbox.fs.read("/etc/passwd")).rejects.toThrow(
          SandboxPathError,
        );
        // A shared prefix is not containment.
        await expect(sandbox.fs.read(`${sibling}/file`)).rejects.toThrow(
          SandboxPathError,
        );
        await expect(sandbox.fs.write(`${sibling}/file`, "no")).rejects.toThrow(
          SandboxPathError,
        );
        await expect(sandbox.exec("pwd", { cwd: "../.." })).rejects.toThrow(
          SandboxPathError,
        );
        await expect(sandbox.exec("pwd", { cwd: sibling })).rejects.toThrow(
          SandboxPathError,
        );
      },
      testTimeout,
    );

    it(
      "does not follow symlinks out of the workspace",
      async () => {
        const sandbox = await acquire();
        const linked = await sandbox.exec(
          "ln -s / out && ln -s /jj-conformance-missing/created dangling && ln -s nested inner && mkdir nested",
        );
        expect(linked.exitCode).toBe(0);
        await expect(sandbox.fs.read("out/etc/hostname")).rejects.toThrow(
          SandboxPathError,
        );
        await expect(sandbox.fs.stat("out/etc")).rejects.toThrow(
          SandboxPathError,
        );
        await expect(sandbox.fs.list("out")).rejects.toThrow(SandboxPathError);
        await expect(sandbox.fs.write("out/tmp/escaped", "no")).rejects.toThrow(
          SandboxPathError,
        );
        await expect(sandbox.fs.mkdir("out/tmp/escaped")).rejects.toThrow(
          SandboxPathError,
        );
        await expect(sandbox.fs.write("dangling", "no")).rejects.toThrow(
          SandboxPathError,
        );
        await expect(sandbox.exec("pwd", { cwd: "out" })).rejects.toThrow(
          SandboxPathError,
        );
        // Links that stay inside keep working, and an outward link can be removed.
        await sandbox.fs.write("inner/through-link.txt", "ok");
        expect(
          (await sandbox.fs.read("nested/through-link.txt")).toString("utf8"),
        ).toBe("ok");
        await sandbox.fs.remove("out");
        expect(await sandbox.fs.stat("out")).toBeUndefined();
      },
      testTimeout,
    );

    it(
      "truncates output past the budget instead of growing unbounded",
      async () => {
        const sandbox = await acquire({ limits: { maxOutputBytes: 64 } });
        const result = await sandbox.exec("yes conformance | head -c 4000");
        expect(result.truncated).toBe(true);
        expect(
          Buffer.byteLength(result.stdout + result.stderr),
        ).toBeLessThanOrEqual(64);
      },
      testTimeout,
    );

    for (const mode of ["task", "bot"] as WorkspaceMode[]) {
      it(
        `reuses a ${mode} workspace across sessions with the same key`,
        async () => {
          const key = uniqueKey(`conformance-${mode}-reuse`);
          const first = await acquire({ workspace: mode }, key);
          await first.fs.write("state.txt", mode);
          await release(first);
          const second = await acquire({ workspace: mode }, key);
          expect((await second.fs.read("state.txt")).toString("utf8")).toBe(
            mode,
          );
        },
        testTimeout,
      );
    }

    it(
      "shares a task workspace between live sandboxes with the same key",
      async () => {
        const key = uniqueKey("conformance-shared");
        const first = await acquire({ workspace: "task" }, key);
        const second = await acquire({ workspace: "task" }, key);
        await first.fs.write("shared.txt", "from-first");
        expect((await second.fs.read("shared.txt")).toString("utf8")).toBe(
          "from-first",
        );
        expect((await second.exec("cat shared.txt")).stdout).toBe("from-first");
      },
      testTimeout,
    );

    it(
      "isolates workspaces with different keys or modes",
      async () => {
        const key = uniqueKey("conformance-isolated");
        const owner = await acquire({ workspace: "task" }, key);
        await owner.fs.write("private.txt", "owner");
        const others = [
          await acquire({ workspace: "task" }, uniqueKey("conformance-other")),
          await acquire({ workspace: "bot" }, key),
          await acquire({ workspace: "ephemeral" }, key),
        ];
        for (const other of others) {
          expect(await other.fs.stat("private.txt")).toBeUndefined();
          expect((await other.exec("test -e private.txt")).exitCode).not.toBe(
            0,
          );
        }
      },
      testTimeout,
    );

    it(
      "discards an ephemeral workspace on release",
      async () => {
        const key = uniqueKey("conformance-ephemeral");
        const first = await acquire({ workspace: "ephemeral" }, key);
        await first.fs.write("state.txt", "gone");
        const hostPath = options.hostWorkspacePath?.(first);
        if (hostPath !== undefined) expect(existsSync(hostPath)).toBe(true);
        await release(first);
        if (hostPath !== undefined) expect(existsSync(hostPath)).toBe(false);
        const second = await acquire({ workspace: "ephemeral" }, key);
        expect(await second.fs.stat("state.txt")).toBeUndefined();
      },
      testTimeout,
    );

    it(
      "refuses exec and fs calls after release, and releases idempotently",
      async () => {
        const sandbox = await acquire({ workspace: "task" });
        await sandbox.fs.write("kept.txt", "x");
        await release(sandbox);
        await expect(sandbox.exec("echo late")).rejects.toThrow(
          SandboxReleasedError,
        );
        await expect(sandbox.fs.read("kept.txt")).rejects.toThrow(
          SandboxReleasedError,
        );
        await expect(sandbox.fs.write("late.txt", "x")).rejects.toThrow(
          SandboxReleasedError,
        );
        await expect(sandbox.fs.stat("kept.txt")).rejects.toThrow(
          SandboxReleasedError,
        );
        await expect(sandbox.fs.list(".")).rejects.toThrow(
          SandboxReleasedError,
        );
        await expect(sandbox.release()).resolves.toBeUndefined();
      },
      testTimeout,
    );

    it(
      "blocks egress when it declares network mode none",
      async (context) => {
        if (!driver.capabilities.networkModes.includes("none"))
          context.skip(`${name} does not declare network mode "none"`);
        const sandbox = await acquire({ network: { mode: "none" } });
        const result = await sandbox.exec(EGRESS_PROBE, { timeoutMs: 15_000 });
        if (result.stdout.includes("EGRESS_UNTESTED"))
          context.skip("no node, curl, wget or nc in the sandbox image");
        expect(result.stdout).toContain("EGRESS_BLOCKED");
        expect(result.stdout).not.toContain("EGRESS_OPEN");
      },
      testTimeout,
    );

    /**
     * Network mode `allowlist`. Probes run with Node inside the sandbox and
     * reach hosts the way proxy-aware clients do: through `HTTPS_PROXY` or
     * `HTTP_PROXY` when the sandbox has them, directly otherwise. Refusals
     * need no internet; the listed-host check does (see `ONLINE`).
     */
    const allowlistOnly = (context: TestContext) => {
      if (!driver.capabilities.networkModes.includes("allowlist"))
        context.skip(`${name} does not declare network mode "allowlist"`);
    };

    it(
      "refuses unlisted hosts, its own DNS and connections that bypass its proxy in network mode allowlist",
      async (context) => {
        allowlistOnly(context);
        const sandbox = await acquire({
          network: { mode: "allowlist", hosts: ["example.com"] },
        });
        const results = await probeNetwork(sandbox, [
          { kind: "http", url: "https://example.org/" },
          { kind: "http", url: "http://example.org/" },
          { kind: "http", url: "https://example.com:8443/" },
          { kind: "tcp", host: "1.1.1.1", port: 443 },
          { kind: "tcp", host: "8.8.8.8", port: 53 },
          { kind: "dns", host: "example.org" },
        ]);
        if (!results) return context.skip("no node in the sandbox image");
        for (const result of results)
          expect(reached(result), show(result)).toBe(false);
      },
      testTimeout,
    );

    it(
      "keeps the machine running the suite unreachable in network mode allowlist, even when it is listed",
      async (context) => {
        allowlistOnly(context);
        const banner = `jj-conformance-host-${Math.random().toString(36).slice(2)}`;
        let hits = 0;
        const server = createServer((socket) => {
          hits++;
          socket.on("error", () => {});
          socket.end(`${banner}\n`);
        });
        await new Promise<void>((done, fail) => {
          server.once("error", () => {
            // No IPv6 on this machine: IPv4 only.
            server.once("error", fail);
            server.listen(0, "0.0.0.0", done);
          });
          server.listen(0, "::", done);
        });
        try {
          const port = (server.address() as AddressInfo).port;
          // This machine's addresses, except link-local IPv6 (which needs a
          // scope). Read again once the probing sandbox exists, because a
          // driver may add an interface for it (a container bridge).
          const hostAddresses = () =>
            Object.values(networkInterfaces())
              .flat()
              .filter((entry) => entry !== undefined)
              .map((entry) => entry.address)
              .filter((address) => !address.toLowerCase().startsWith("fe80:"));
          // A first sandbox brings up the interfaces the driver adds for
          // sandboxes in general, so the second can list them.
          await acquire({
            network: { mode: "allowlist", hosts: ["example.com"] },
          });
          const v4 = hostAddresses().filter((address) => isIPv4(address));
          const names = ["localhost", "host.docker.internal"];
          const sandbox = await acquire({
            network: {
              mode: "allowlist",
              hosts: [
                "example.com",
                ...[...names, ...v4].map((host) => `${host}:${port}`),
              ],
            },
          });
          const route = await sandbox.exec(
            "cat /proc/net/route 2>/dev/null; true",
          );
          const gateways = defaultGateways(route.stdout);
          const addresses = [...new Set([...v4, ...hostAddresses()])];
          const bracket = (host: string) => (isIPv6(host) ? `[${host}]` : host);
          const probes: NetworkProbe[] = [
            ...[...addresses, ...gateways].map(
              (host): NetworkProbe => ({ kind: "tcp", host, port }),
            ),
            ...[...names, ...addresses, ...gateways].flatMap(
              (host): NetworkProbe[] => [
                { kind: "http", url: `http://${bracket(host)}:${port}/` },
                { kind: "http", url: `https://${bracket(host)}:${port}/` },
              ],
            ),
          ];
          const results = await probeNetwork(sandbox, probes);
          if (!results) return context.skip("no node in the sandbox image");
          expect(v4.length).toBeGreaterThan(0);
          for (const [index, result] of results.entries()) {
            expect(
              reached(result),
              `${JSON.stringify(probes[index])} ${show(result)}`,
            ).toBe(false);
            expect(JSON.stringify(result)).not.toContain(banner);
          }
          expect(hits).toBe(0);
        } finally {
          server.close();
        }
      },
      testTimeout,
    );

    it(
      "reaches a listed public host in network mode allowlist (needs internet; JJ_SANDBOX_TEST_OFFLINE=1 skips it)",
      async (context) => {
        allowlistOnly(context);
        if (!ONLINE)
          return context.skip(
            "JJ_SANDBOX_TEST_OFFLINE=1: the listed-host check needs internet access",
          );
        const sandbox = await acquire({
          network: { mode: "allowlist", hosts: ["example.com"] },
        });
        const proxied = await sandbox.exec(
          'printf "%s%s" "$HTTPS_PROXY" "$https_proxy"',
        );
        // A proxy-based driver must also stop a direct connection to the
        // listed host's own address, which the suite resolves here.
        const direct = proxied.stdout.trim()
          ? (await lookup("example.com", { all: true }))
              .filter((entry) => entry.family === 4)
              .map(
                (entry): NetworkProbe => ({
                  kind: "tcp",
                  host: entry.address,
                  port: 443,
                }),
              )
          : [];
        const results = await probeNetwork(sandbox, [
          { kind: "http", url: "https://example.com/" },
          { kind: "http", url: "http://example.com/" },
          ...direct,
        ]);
        if (!results) return context.skip("no node in the sandbox image");
        const [https, http, ...bypass] = results;
        expect(https && reached(https), show(https)).toBe(true);
        expect(http && reached(http), show(http)).toBe(true);
        for (const result of bypass)
          expect(reached(result), show(result)).toBe(false);
      },
      testTimeout,
    );

    it(
      "declares optional capabilities consistently with its implementation",
      async () => {
        const sandbox = await acquire();
        expect(typeof sandbox.exposePort === "function").toBe(
          driver.capabilities.exposePort,
        );
        expect(typeof sandbox.snapshot === "function").toBe(
          driver.capabilities.snapshot,
        );
        expect(typeof sandbox.metrics === "function").toBe(
          driver.capabilities.metrics,
        );
      },
      testTimeout,
    );
  });
}

/**
 * Whether the allowlist check that needs internet access runs. Only an
 * explicit `JJ_SANDBOX_TEST_OFFLINE=1` turns it off, for machines whose
 * containers cannot reach the internet; CI never sets it.
 */
export const ONLINE = process.env.JJ_SANDBOX_TEST_OFFLINE !== "1";

export type NetworkProbe =
  | { kind: "tcp"; host: string; port: number }
  | { kind: "http"; url: string }
  | { kind: "dns"; host: string };

export interface ProbeResult {
  /** `connected` (tcp), `response`, `refused` (a CONNECT the proxy answered with an error), `resolved` (dns) or `error`. */
  outcome: "connected" | "response" | "refused" | "resolved" | "error";
  status?: number;
  reason?: string;
  body?: string;
  banner?: string;
  addresses?: string[];
  code?: string;
}

/** Whether a probe got through: a connection, a resolved name, or an HTTP answer that is not an error. */
export const reached = (result: ProbeResult): boolean =>
  result.outcome === "connected" ||
  result.outcome === "resolved" ||
  (result.outcome === "response" && (result.status ?? 600) < 400);

const show = (result: ProbeResult | undefined) =>
  JSON.stringify(result)?.slice(0, 400) ?? "no result";

/** IPv4 default gateways from `/proc/net/route` (little-endian hex). */
function defaultGateways(routes: string): string[] {
  const found = new Set<string>();
  for (const line of routes.split("\n").slice(1)) {
    const [, destination, gateway] = line.trim().split(/\s+/);
    if (
      destination !== "00000000" ||
      !gateway ||
      !/^[0-9A-F]{8}$/i.test(gateway)
    )
      continue;
    const value = Number.parseInt(gateway, 16);
    found.add(
      [value & 255, (value >> 8) & 255, (value >> 16) & 255, value >>> 24].join(
        ".",
      ),
    );
  }
  found.delete("0.0.0.0");
  return [...found];
}

/**
 * Runs `probes` inside the sandbox with Node and returns one result each, or
 * undefined when the image has no `node`.
 */
export async function probeNetwork(
  sandbox: Sandbox,
  probes: NetworkProbe[],
): Promise<ProbeResult[] | undefined> {
  const node = await sandbox.exec(
    "command -v node >/dev/null 2>&1 && echo yes",
  );
  if (node.stdout.trim() !== "yes") return undefined;
  await sandbox.fs.write("jj-net-probe.cjs", NET_PROBE);
  await sandbox.fs.write("jj-net-probes.json", JSON.stringify(probes));
  const result = await sandbox.exec(
    "node jj-net-probe.cjs jj-net-probes.json",
    { timeoutMs: 60_000 },
  );
  const line = result.stdout.trim().split("\n").pop() ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(
      `network probe failed (exit ${result.exitCode}): ${result.stdout}${result.stderr}`.slice(
        0,
        2000,
      ),
    );
  }
  if (!Array.isArray(parsed) || parsed.length !== probes.length)
    throw new Error(`network probe returned ${line.slice(0, 500)}`);
  return parsed as ProbeResult[];
}

/**
 * The in-sandbox side of `probeNetwork`, CommonJS on Node built-ins. HTTP
 * probes use `HTTPS_PROXY`/`HTTP_PROXY` (either case) when set, as curl and
 * pip do, with a CONNECT tunnel for https; tcp and dns probes never use a
 * proxy. Every probe ends within 8 s.
 */
const NET_PROBE = String.raw`"use strict";
const fs = require("fs"), net = require("net"), tls = require("tls"), dns = require("dns");
const LIMIT = 8000;
const probes = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const envProxy = (name) => process.env[name.toLowerCase()] || process.env[name] || "";
const failure = (error) => ({ outcome: "error", code: String((error && (error.code || error.message)) || error) });

function settle(work) {
  return new Promise((resolve) => {
    let done = false;
    const sockets = [];
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      for (const socket of sockets) socket.destroy();
      resolve(value);
    };
    const timer = setTimeout(() => finish({ outcome: "error", code: "TIMEOUT" }), LIMIT);
    const track = (socket) => {
      sockets.push(socket);
      socket.on("error", (error) => finish(failure(error)));
      return socket;
    };
    try { work(finish, track); } catch (error) { finish(failure(error)); }
  });
}

function parseResponse(raw, outcome) {
  const match = /^HTTP\/1\.[01] (\d{3}) ?([^\r\n]*)/.exec(raw);
  if (!match) return { outcome: "error", code: "NO_HTTP_RESPONSE", body: raw.slice(0, 200) };
  const end = raw.indexOf("\r\n\r\n");
  return { outcome, status: Number(match[1]), reason: match[2], body: end < 0 ? "" : raw.slice(end + 4, end + 304) };
}

function readResponse(socket, finish, outcome) {
  let raw = "";
  socket.on("data", (chunk) => {
    raw += chunk.toString("latin1");
    if (raw.length > 65536) finish(parseResponse(raw, outcome));
  });
  socket.on("close", () => finish(parseResponse(raw, outcome)));
}

function tcp(probe) {
  return settle((finish, track) => {
    let banner = "";
    const socket = track(net.connect({ host: probe.host, port: probe.port }));
    socket.on("data", (chunk) => { banner += chunk.toString("latin1"); });
    socket.on("connect", () => setTimeout(() => finish({ outcome: "connected", banner }), 500));
  });
}

function http(probe) {
  const url = new URL(probe.url);
  const secure = url.protocol === "https:";
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const port = Number(url.port) || (secure ? 443 : 80);
  const proxy = envProxy(secure ? "HTTPS_PROXY" : "HTTP_PROXY");
  const request = (target) =>
    "GET " + target + " HTTP/1.1\r\nHost: " + url.host + "\r\nUser-Agent: jj-conformance\r\nAccept: */*\r\nConnection: close\r\n\r\n";
  return settle((finish, track) => {
    const via = proxy ? new URL(proxy) : null;
    const proxyAddress = via && { host: via.hostname.replace(/^\[|\]$/g, ""), port: Number(via.port) || 80 };
    if (!secure) {
      const socket = track(net.connect(proxyAddress || { host, port }));
      socket.on("connect", () => socket.write(request(via ? url.href : url.pathname + url.search)));
      return readResponse(socket, finish, "response");
    }
    const startTls = (socket) => {
      const options = { servername: net.isIP(host) ? undefined : host };
      const secured = track(socket ? tls.connect({ ...options, socket }) : tls.connect({ ...options, host, port }));
      secured.on("secureConnect", () => secured.write(request(url.pathname + url.search)));
      readResponse(secured, finish, "response");
    };
    if (!proxyAddress) return startTls(null);
    const socket = track(net.connect(proxyAddress));
    const authority = (net.isIPv6(host) ? "[" + host + "]" : host) + ":" + port;
    socket.on("connect", () => socket.write("CONNECT " + authority + " HTTP/1.1\r\nHost: " + authority + "\r\n\r\n"));
    let head = "";
    const onData = (chunk) => {
      head += chunk.toString("latin1");
      if (head.indexOf("\r\n\r\n") < 0) return;
      socket.off("data", onData);
      if (/^HTTP\/1\.[01] 200/.test(head)) return startTls(socket);
      readResponse(socket, (result) => finish(result), "refused");
      socket.emit("data", Buffer.from(head, "latin1"));
    };
    socket.on("data", onData);
  });
}

function lookup(probe) {
  return settle((finish) =>
    dns.lookup(probe.host, { all: true }, (error, addresses) =>
      finish(error ? failure(error) : { outcome: "resolved", addresses: addresses.map((entry) => entry.address) })));
}

Promise.all(probes.map((probe) => (probe.kind === "tcp" ? tcp : probe.kind === "dns" ? lookup : http)(probe)))
  .then((results) => console.log(JSON.stringify(results)));
`;

/**
 * Tries a TCP connection to a public address with the first client available.
 * Any failure counts as blocked: on a host without internet access this check
 * passes vacuously, so it proves enforcement only where egress is otherwise open.
 */
const EGRESS_PROBE = `
if command -v node >/dev/null 2>&1; then
  node -e 'const s=require("net").connect({host:"1.1.1.1",port:80});const end=(r)=>{console.log(r);process.exit(0)};s.setTimeout(3000,()=>end("EGRESS_BLOCKED"));s.on("connect",()=>end("EGRESS_OPEN"));s.on("error",()=>end("EGRESS_BLOCKED"))'
elif command -v curl >/dev/null 2>&1; then
  if curl -s -m 3 -o /dev/null http://1.1.1.1/; then echo EGRESS_OPEN; else echo EGRESS_BLOCKED; fi
elif command -v nc >/dev/null 2>&1; then
  if nc -z -w 3 1.1.1.1 80 >/dev/null 2>&1; then echo EGRESS_OPEN; else echo EGRESS_BLOCKED; fi
elif command -v wget >/dev/null 2>&1; then
  if wget -q -T 3 -O /dev/null http://1.1.1.1/; then echo EGRESS_OPEN; else echo EGRESS_BLOCKED; fi
else
  echo EGRESS_UNTESTED
fi
`;
