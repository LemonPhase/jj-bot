import type { TaskStatus } from "@jj/contracts";
import { LocalSandboxDriver } from "@jj/sandbox";
import { sandboxSpecSchema } from "@jj/sandbox/contract";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../config";
import type { EngineContext } from "../context";
import { createDriverRegistry } from "../drivers";
import type { EngineDriver } from "../ports";
import { countingDriver, quietLogger, until } from "../testing/harness";
import { TaskSandboxes } from "./sandboxes";

function manager(
  idleMs: number,
  statuses = new Map<string, TaskStatus>(),
  driver: EngineDriver = new LocalSandboxDriver(),
) {
  const counting = countingDriver(driver);
  const ctx = {
    config: resolveConfig({ sandboxIdleMs: idleMs }),
    drivers: createDriverRegistry([
      { driver: counting.driver, label: "Local" },
    ]),
    logger: quietLogger,
  } as unknown as EngineContext;
  return {
    sandboxes: new TaskSandboxes(ctx, { statuses: async () => statuses }),
    counts: counting.counts,
  };
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

  it("releases idle sandboxes, ephemeral ones included, and records the discarded workspace", async () => {
    const statuses = new Map<string, TaskStatus>([
      ["task_t", "waiting"],
      ["task_e", "waiting"],
    ]);
    const { sandboxes, counts } = manager(10, statuses);
    (await sandboxes.acquire("task_t", "s", spec("task"))).done();
    (await sandboxes.acquire("task_e", "s", spec("ephemeral"))).done();
    await sandboxes.sweep(Date.now() - 60_000);
    expect(counts.released).toBe(0);
    await sandboxes.sweep(Date.now() + 1_000);
    await until(() => counts.released === 2, { what: "the idle releases" });
    expect(sandboxes.wasDiscarded("task_e")).toBe(true);
    expect(sandboxes.wasDiscarded("task_t")).toBe(false);
    // Re-acquired on demand; the task workspace keeps its files.
    const again = await sandboxes.acquire("task_t", "s", spec("task"));
    expect(counts.acquired).toBe(3);
    again.done();
    await sandboxes.releaseAll();
    expect(counts.released).toBe(3);
  });

  it("releases a sandbox whose task finished on another worker without waiting for the idle time", async () => {
    const statuses = new Map<string, TaskStatus>([["task_f", "completed"]]);
    const { sandboxes, counts } = manager(60_000, statuses);
    (await sandboxes.acquire("task_f", "s", spec("task"))).done();
    await sandboxes.sweep();
    await until(() => counts.released === 1, { what: "the release" });
  });

  it("stops waiting for a slow start when the run stops, and aborts the driver's acquire", async () => {
    const local = new LocalSandboxDriver();
    let driverSignal: AbortSignal | undefined;
    const slow: EngineDriver = {
      id: "local",
      capabilities: local.capabilities,
      validateSpec: (value) => local.validateSpec(value),
      probe: () => local.probe(),
      acquire: (request) =>
        new Promise((_, reject) => {
          driverSignal = request.signal;
          request.signal?.addEventListener("abort", () =>
            reject(new Error("pull aborted")),
          );
        }),
    };
    const { sandboxes } = manager(10, new Map(), slow);
    const run = new AbortController();
    const waiting = sandboxes.acquire("task_s", "s", spec("task"), run.signal);
    await until(() => driverSignal !== undefined, { what: "the acquire" });
    run.abort(new Error("stop"));
    await expect(waiting).rejects.toThrow(
      "stopped while its sandbox was starting",
    );
    expect(driverSignal?.aborted).toBe(true);
    expect(sandboxes.holds("task_s")).toBe(false);
  });

  it("refuses a driver that is not installed", async () => {
    const { sandboxes } = manager(10);
    await expect(
      sandboxes.acquire("task_x", "s", { ...spec("task"), driver: "docker" }),
    ).rejects.toThrow('Sandbox driver "docker" is not installed');
  });
});
