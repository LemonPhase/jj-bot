import { afterEach, beforeAll, describe, expect, it } from "vitest";
import type {
  Sandbox,
  SandboxDriver,
  SandboxSpecInput,
  WorkspaceMode,
} from "./contract";
import { SandboxCapabilityError, SandboxPathError } from "./contract";

/**
 * The contract every sandbox driver must satisfy, in-tree or community.
 * A driver that passes this is safe for the agent runtime to target; a driver
 * that cannot pass it must narrow its declared `capabilities` until it does.
 *
 * @example
 * describeSandboxConformance("local", () => new LocalSandboxDriver());
 */

const HOST_SECRET_VAR = "JJ_CONFORMANCE_HOST_SECRET";

export interface ConformanceOptions {
  /** Driver-specific spec additions, such as an image or template reference. */
  spec?: Partial<SandboxSpecInput>;
  /** Raised for drivers whose sandboxes take time to start. */
  timeoutMs?: number;
}

export function describeSandboxConformance(
  name: string,
  createDriver: () => SandboxDriver | Promise<SandboxDriver>,
  options: ConformanceOptions = {},
): void {
  describe(`sandbox driver conformance: ${name}`, () => {
    const testTimeout = options.timeoutMs ?? 30_000;
    let driver: SandboxDriver;
    const live: Sandbox[] = [];

    beforeAll(async () => {
      driver = await createDriver();
      process.env[HOST_SECRET_VAR] = "host-only-value";
    });

    afterEach(async () => {
      await Promise.all(
        live.splice(0).map((sandbox) => sandbox.release().catch(() => {})),
      );
    });

    /** A spec this driver can actually honor: never ask for isolation it does not declare. */
    function spec(overrides: Partial<SandboxSpecInput> = {}): SandboxSpecInput {
      return {
        driver: driver.id,
        network: driver.capabilities.networkPolicy
          ? { mode: "none" }
          : { mode: "open" },
        workspace: "ephemeral",
        ...options.spec,
        ...overrides,
      };
    }

    async function acquire(
      overrides: Partial<SandboxSpecInput> = {},
      workspaceKey = `conformance-${Math.random().toString(36).slice(2)}`,
    ): Promise<Sandbox> {
      const sandbox = await driver.acquire({
        sessionId: "session-1",
        taskId: "task-1",
        spec: driver.validateSpec(spec(overrides)),
        workspaceKey,
      });
      live.push(sandbox);
      return sandbox;
    }

    it("reports a healthy probe", async () => {
      expect((await driver.probe()).ok).toBe(true);
    });

    it("refuses isolation it cannot enforce", () => {
      if (!driver.capabilities.networkPolicy)
        expect(() =>
          driver.validateSpec(spec({ network: { mode: "none" } })),
        ).toThrow(SandboxCapabilityError);
      if (!driver.capabilities.resourceLimits)
        expect(() =>
          driver.validateSpec(spec({ resources: { memoryMb: 256 } })),
        ).toThrow(SandboxCapabilityError);
      expect(driver.validateSpec(spec()).driver).toBe(driver.id);
    });

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
      "runs in the workspace and honors a relative cwd",
      async () => {
        const sandbox = await acquire();
        await sandbox.fs.mkdir("nested/dir");
        const root = await sandbox.exec("pwd");
        expect(root.stdout.trim()).toBe(sandbox.workspaceDir);
        const nested = await sandbox.exec("pwd", { cwd: "nested/dir" });
        expect(nested.stdout.trim().endsWith("nested/dir")).toBe(true);
      },
      testTimeout,
    );

    it(
      "never exposes the host environment",
      async () => {
        const sandbox = await acquire();
        const result = await sandbox.exec(`echo "[$${HOST_SECRET_VAR}]"`);
        expect(result.stdout).toContain("[]");
        expect(result.stdout).not.toContain("host-only-value");
      },
      testTimeout,
    );

    it(
      "injects declared environment entries and secrets",
      async () => {
        const sandbox = await driver.acquire({
          sessionId: "session-1",
          taskId: "task-1",
          spec: driver.validateSpec(spec({ env: { JJ_DECLARED: "declared" } })),
          workspaceKey: "conformance-env",
          secrets: { JJ_SECRET: "injected" },
        });
        live.push(sandbox);
        const result = await sandbox.exec('echo "$JJ_DECLARED/$JJ_SECRET"');
        expect(result.stdout.trim()).toBe("declared/injected");
      },
      testTimeout,
    );

    it(
      "interrupts a command that exceeds its timeout",
      async () => {
        const sandbox = await acquire();
        const result = await sandbox.exec("sleep 30", { timeoutMs: 400 });
        expect(result.interrupted).toBe("yes");
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
        expect(result.interrupted).toBe("yes");
        expect(result.interruptReason).toBe("abort");
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
        await expect(sandbox.fs.read("../../etc/passwd")).rejects.toThrow(
          SandboxPathError,
        );
        await expect(sandbox.fs.write("../escaped.txt", "no")).rejects.toThrow(
          SandboxPathError,
        );
        await expect(sandbox.fs.read("/etc/passwd")).rejects.toThrow(
          SandboxPathError,
        );
        await expect(sandbox.exec("pwd", { cwd: "../.." })).rejects.toThrow(
          SandboxPathError,
        );
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
          const key = `conformance-${mode}-reuse`;
          const first = await acquire({ workspace: mode }, key);
          await first.fs.write("state.txt", mode);
          await first.release();
          live.splice(live.indexOf(first), 1);
          const second = await acquire({ workspace: mode }, key);
          expect((await second.fs.read("state.txt")).toString("utf8")).toBe(
            mode,
          );
        },
        testTimeout,
      );
    }

    it(
      "discards an ephemeral workspace on release",
      async () => {
        const key = "conformance-ephemeral";
        const first = await acquire({ workspace: "ephemeral" }, key);
        await first.fs.write("state.txt", "gone");
        await first.release();
        live.splice(live.indexOf(first), 1);
        const second = await acquire({ workspace: "ephemeral" }, key);
        expect(await second.fs.stat("state.txt")).toBeUndefined();
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
