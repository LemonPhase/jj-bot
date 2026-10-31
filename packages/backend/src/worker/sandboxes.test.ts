import { LocalSandboxDriver } from "@jj/sandbox";
import { sandboxSpecSchema } from "@jj/sandbox/contract";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../config";
import type { EngineContext } from "../context";
import { createDriverRegistry } from "../drivers";
import { countingDriver, quietLogger, until } from "../testing/harness";
import { TaskSandboxes } from "./sandboxes";

function manager(idleMs: number) {
  const counting = countingDriver(new LocalSandboxDriver());
  const ctx = {
    config: resolveConfig({ sandboxIdleMs: idleMs }),
    drivers: createDriverRegistry([
      { driver: counting.driver, label: "Local" },
    ]),
    logger: quietLogger,
  } as unknown as EngineContext;
  return { sandboxes: new TaskSandboxes(ctx), counts: counting.counts };
}

const spec = (workspace: "task" | "ephemeral") =>
  sandboxSpecSchema.parse({
    driver: "local",
    network: { mode: "open" },
    workspace,
  });

describe("task sandboxes", () => {
  it("shares one sandbox per task and releases it once the task finishes and runs let go", async () => {
    const { sandboxes, counts } = manager(60_000);
    const [a, b] = await Promise.all([
      sandboxes.acquire("task_1", "sess_a", spec("task")),
      sandboxes.acquire("task_1", "sess_b", spec("task")),
    ]);
    expect(a.sandbox).toBe(b.sandbox);
    expect(counts.acquired).toBe(1);
    sandboxes.finish("task_1");
    a.done();
    expect(counts.released).toBe(0);
    b.done();
    await until(() => counts.released === 1, { what: "the release" });
    expect(sandboxes.holds("task_1")).toBe(false);
  });

  it("releases idle task workspaces but keeps ephemeral ones", async () => {
    const { sandboxes, counts } = manager(10);
    (await sandboxes.acquire("task_t", "s", spec("task"))).done();
    (await sandboxes.acquire("task_e", "s", spec("ephemeral"))).done();
    sandboxes.sweep(Date.now() + 1_000);
    await until(() => counts.released === 1, { what: "the idle release" });
    expect(sandboxes.holds("task_t")).toBe(false);
    expect(sandboxes.holds("task_e")).toBe(true);
    // Re-acquired on demand; the task workspace keeps its files.
    const again = await sandboxes.acquire("task_t", "s", spec("task"));
    expect(counts.acquired).toBe(3);
    again.done();
    await sandboxes.releaseAll();
    expect(counts.released).toBe(3);
  });

  it("refuses a driver that is not installed", async () => {
    const { sandboxes } = manager(10);
    await expect(
      sandboxes.acquire("task_x", "s", { ...spec("task"), driver: "docker" }),
    ).rejects.toThrow('Sandbox driver "docker" is not installed');
  });
});
