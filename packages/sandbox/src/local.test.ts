import { existsSync } from "node:fs";
import {
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { describeSandboxConformance } from "./conformance";
import {
  type AcquireRequest,
  SandboxCapabilityError,
  SandboxRequestError,
  type SandboxSpecInput,
} from "./contract";
import { LocalSandboxDriver } from "./drivers/local";

describeSandboxConformance(
  "local",
  () => new LocalSandboxDriver({ killGraceMs: 500 }),
  { hostWorkspacePath: (sandbox) => sandbox.workspaceDir },
);

const delay = (ms: number) => new Promise((done) => setTimeout(done, ms));

describe("local driver", () => {
  let root: string;
  let outside: string;
  let driver: LocalSandboxDriver;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "jj-local-test-"));
    outside = await mkdtemp(join(tmpdir(), "jj-local-outside-"));
    driver = new LocalSandboxDriver({ root, killGraceMs: 300 });
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
