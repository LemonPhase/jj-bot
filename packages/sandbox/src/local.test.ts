import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { describeSandboxConformance } from "./conformance";
import {
  type AcquireRequest,
  SandboxCapabilityError,
  SandboxRequestError,
  type SandboxSpecInput,
} from "./contract";
import { LocalSandboxDriver } from "./drivers/local";

// A fresh root per run, removed afterwards, so runs neither share nor leave workspaces.
let conformanceRoot: string | undefined;
describeSandboxConformance(
  "local",
  async () => {
    conformanceRoot = await mkdtemp(join(tmpdir(), "jj-local-conformance-"));
    return new LocalSandboxDriver({
      root: conformanceRoot,
      env: {},
      killGraceMs: 500,
    });
  },
  { hostWorkspacePath: (sandbox) => sandbox.workspaceDir },
);
afterAll(async () => {
  if (conformanceRoot)
    await rm(conformanceRoot, { recursive: true, force: true });
});

const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe("local driver", () => {
  let root: string;
  let outside: string;
  let driver: LocalSandboxDriver;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "jj-local-test-"));
    outside = await mkdtemp(join(tmpdir(), "jj-local-outside-"));
    driver = new LocalSandboxDriver({ root, env: {}, killGraceMs: 300 });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const spec = (overrides: Partial<SandboxSpecInput> = {}) =>
    driver.validateSpec({
      driver: "local",
      network: { mode: "open" },
      ...overrides,
    });

  const request = (
    overrides: Partial<SandboxSpecInput>,
    workspaceKey: string,
  ): AcquireRequest => ({
    sessionId: "session-1",
    taskId: "task-1",
    spec: spec(overrides),
    workspaceKey,
  });

  /** A heartbeat outside the workspace, so it stays observable after an ephemeral workspace is deleted. */
  const hostHeartbeat = (file: string, launcher = "") =>
    `${launcher} sh -c 'trap "" TERM; while :; do echo x >> ${file}; sleep 0.1; done' >/dev/null 2>&1 &`;

  async function expectStopped(files: string[]): Promise<void> {
    const sizes = () =>
      Promise.all(
        files.map(async (file) => (await stat(file).catch(() => null))?.size),
      );
    const before = await sizes();
    expect(before.every((size) => (size ?? 0) > 0)).toBe(true);
    await delay(600);
    expect(await sizes()).toEqual(before);
  }

  it("refuses an image or driverConfig it would ignore", () => {
    expect(() => spec({ image: "node:24" })).toThrow(SandboxCapabilityError);
    expect(() => spec({ driverConfig: { privileged: true } })).toThrow(
      SandboxRequestError,
    );
  });

  it("namespaces workspace directories by mode", async () => {
    const task = await driver.acquire(request({ workspace: "task" }, "k1"));
    const bot = await driver.acquire(request({ workspace: "bot" }, "k1"));
    const ephemeral = await driver.acquire(
      request({ workspace: "ephemeral" }, "k1"),
    );
    const real = await realpath(root);
    expect(task.workspaceDir).toBe(join(real, "task", "k1"));
    expect(bot.workspaceDir).toBe(join(real, "bot", "k1"));
    expect(
      ephemeral.workspaceDir.startsWith(join(real, "ephemeral", "k1-")),
    ).toBe(true);
    await Promise.all([task, bot, ephemeral].map((s) => s.release()));
  });

  it.runIf(process.platform === "linux")(
    'on Linux, kills TERM-ignoring and setsid descendants and reports "yes"',
    async () => {
      const sandbox = await driver.acquire(
        request({ workspace: "ephemeral" }, "linux-stop"),
      );
      const group = join(outside, "stop-group");
      const detached = join(outside, "stop-setsid");
      const result = await sandbox.exec(
        `${hostHeartbeat(group)}\n${hostHeartbeat(detached, "setsid")}\nsleep 30`,
        { timeoutMs: 800 },
      );
      expect(result.interrupted).toBe("yes");
      expect(result.interruptReason).toBe("timeout");
      await expectStopped([group, detached]);
      await sandbox.release();
    },
    20_000,
  );

  it.runIf(process.platform === "linux")(
    "stops background processes when an ephemeral workspace is released",
    async () => {
      const sandbox = await driver.acquire(
        request({ workspace: "ephemeral" }, "release-ephemeral"),
      );
      const plain = join(outside, "release-nohup");
      const detached = join(outside, "release-setsid");
      const started = await sandbox.exec(
        `${hostHeartbeat(plain, "nohup")}\n${hostHeartbeat(detached, "setsid")}`,
      );
      expect(started.interrupted).toBe("no");
      await delay(400);
      await sandbox.release();
      expect(existsSync(sandbox.workspaceDir)).toBe(false);
      await expectStopped([plain, detached]);
    },
    20_000,
  );

  it.runIf(process.platform === "linux" && existsSync("/bin/bash"))(
    "on Linux, also stops descendants that left the group but not the session",
    async () => {
      const sandbox = await driver.acquire(
        request({ workspace: "ephemeral" }, "linux-session"),
      );
      const file = join(outside, "stop-session");
      // Job control gives the background job its own group; env -i drops the marker.
      await sandbox.fs.write(
        "job.sh",
        `set -m\nenv -i /bin/sh -c 'trap "" TERM; while :; do echo x >> ${file}; sleep 0.1; done' >/dev/null 2>&1 &\nsleep 30\n`,
      );
      const result = await sandbox.exec("bash job.sh", { timeoutMs: 800 });
      expect(result.interrupted).toBe("yes");
      await expectStopped([file]);
      await sandbox.release();
    },
    20_000,
  );

  it("marks a command running at release as interrupted by release", async () => {
    const sandbox = await driver.acquire(
      request({ workspace: "ephemeral" }, "release-running"),
    );
    const running = sandbox.exec("sleep 30");
    await delay(200);
    await sandbox.release();
    const result = await running;
    expect(result.interruptReason).toBe("release");
    expect(result.interrupted).toBe(
      process.platform === "linux" ? "yes" : "unknown",
    );
  });

  it("does not let a command override its process marker", async () => {
    const sandbox = await driver.acquire(
      request({ workspace: "ephemeral" }, "marker"),
    );
    const result = await sandbox.exec('echo "$JJ_SANDBOX_EXEC"', {
      env: { JJ_SANDBOX_EXEC: "spoofed" },
    });
    expect(result.stdout.trim().startsWith(`${sandbox.id}:`)).toBe(true);
    await sandbox.release();
  });

  it("creates more than 64 new nested directories", async () => {
    const sandbox = await driver.acquire(
      request({ workspace: "ephemeral" }, "deep"),
    );
    const deep = Array.from({ length: 80 }, (_, i) => `d${i}`).join("/");
    await sandbox.fs.mkdir(`made/${deep}`);
    expect((await sandbox.fs.stat(`made/${deep}`))?.kind).toBe("directory");
    await sandbox.fs.write(`written/${deep}/file.txt`, "deep");
    expect(
      (await sandbox.fs.read(`written/${deep}/file.txt`)).toString("utf8"),
    ).toBe("deep");
    await sandbox.exec("ln -s loop-a loop-b && ln -s loop-b loop-a");
    await expect(sandbox.fs.write("loop-a/file.txt", "x")).rejects.toThrow();
    await sandbox.release();
  });

  it("waits for fs calls in flight before discarding an ephemeral workspace", async () => {
    const deep = Array.from({ length: 40 }, (_, i) => `r${i}`).join("/");
    for (let attempt = 0; attempt < 10; attempt++) {
      const sandbox = await driver.acquire(
        request({ workspace: "ephemeral" }, "racing"),
      );
      const write = sandbox.fs.write(`${deep}/late.txt`, "late");
      const setup = sandbox.exec("true").catch((error: unknown) => error);
      await sandbox.release();
      await write;
      await setup;
      expect(existsSync(sandbox.workspaceDir)).toBe(false);
    }
  });

  it("takes its root from the option, then JJ_SANDBOX_ROOT", async () => {
    const real = await realpath(root);
    const fromEnv = new LocalSandboxDriver({
      env: { JJ_SANDBOX_ROOT: join(root, "from-env") },
    });
    const explicit = new LocalSandboxDriver({
      root: join(root, "explicit"),
      env: { JJ_SANDBOX_ROOT: join(root, "from-env") },
    });
    for (const [instance, expected] of [
      [fromEnv, "from-env"],
      [explicit, "explicit"],
    ] as const) {
      const sandbox = await instance.acquire(
        request({ workspace: "task" }, "k"),
      );
      expect(sandbox.workspaceDir).toBe(join(real, expected, "task", "k"));
      await sandbox.release();
    }
  });

  it("defaults to a fixed root, so task workspaces survive a restart", async () => {
    const temp = await mkdtemp(join(tmpdir(), "jj-local-default-"));
    vi.stubEnv("TMPDIR", temp);
    try {
      const first = new LocalSandboxDriver({ env: {} });
      const before = await first.acquire(
        request({ workspace: "task" }, "kept"),
      );
      expect(before.workspaceDir).toBe(
        join(await realpath(temp), "jj-sandbox", "task", "kept"),
      );
      await before.fs.write("state.txt", "kept");
      await before.release();
      // A new driver instance stands in for a restarted server.
      const after = await new LocalSandboxDriver({ env: {} }).acquire(
        request({ workspace: "task" }, "kept"),
      );
      expect((await after.fs.read("state.txt")).toString("utf8")).toBe("kept");
      await after.release();
      // The default path is shared: one replaced by a symlink is refused.
      await rm(join(temp, "jj-sandbox"), { recursive: true });
      await mkdir(join(temp, "elsewhere"));
      await symlink(join(temp, "elsewhere"), join(temp, "jj-sandbox"));
      const planted = await new LocalSandboxDriver({ env: {} }).probe();
      expect(planted.ok).toBe(false);
    } finally {
      vi.unstubAllEnvs();
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("writes through the fs API land inside the workspace only", async () => {
    const sandbox = await driver.acquire(
      request({ workspace: "ephemeral" }, "dangling"),
    );
    const target = join(outside, "created-through-link");
    await sandbox.exec(`ln -s ${target} link`);
    await expect(sandbox.fs.write("link", "no")).rejects.toThrow();
    expect(existsSync(target)).toBe(false);
    await sandbox.release();
  });

  it("is unhealthy and refuses to acquire on Windows", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform");
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      const health = await driver.probe();
      expect(health.ok).toBe(false);
      expect(health.detail).toMatch(/Windows/);
      await expect(
        driver.acquire(request({ workspace: "task" }, "windows")),
      ).rejects.toThrow(/Windows/);
    } finally {
      if (original) Object.defineProperty(process, "platform", original);
    }
  });

  it("documents the limit: commands can read the server user's files", async () => {
    const sandbox = await driver.acquire(
      request({ workspace: "ephemeral" }, "unisolated"),
    );
    const secretFile = join(outside, "server-only.txt");
    await writeFile(secretFile, "readable");
    const result = await sandbox.exec(`cat ${secretFile}`);
    expect(result.stdout).toBe(await readFile(secretFile, "utf8"));
    expect(driver.capabilities.filesystemIsolation).toBe(false);
    await sandbox.release();
  });
});
