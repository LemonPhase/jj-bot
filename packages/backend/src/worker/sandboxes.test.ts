import type { TaskStatus } from "@jj/contracts";
import { LocalSandboxDriver } from "@jj/sandbox";
import { sandboxSpecSchema } from "@jj/sandbox/contract";
import { describe, expect, it } from "vitest";
import { type EngineConfigInput, resolveConfig } from "../config";
import type { EngineContext } from "../context";
import { createDriverRegistry } from "../drivers";
import type { EngineDriver } from "../ports";
import { countingDriver, quietLogger, until } from "../testing/harness";
import { TaskSandboxes } from "./sandboxes";

function manager(
  idleMs: number,
  statuses = new Map<string, TaskStatus>(),
  driver: EngineDriver = new LocalSandboxDriver(),
  config: EngineConfigInput = {},
) {
  const counting = countingDriver(driver);
  const ctx = {
    config: resolveConfig({ sandboxIdleMs: idleMs, ...config }),
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

  it("releases idle task-workspace sandboxes, but keeps an open task's ephemeral one", async () => {
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
    await until(() => counts.released === 1, { what: "the idle release" });
    expect(sandboxes.holds("task_t")).toBe(false);
    // The waiting task's ephemeral workspace survives the task idle time.
    await sandboxes.sweep(Date.now() + 5 * 60 * 60_000);
    expect(sandboxes.holds("task_e")).toBe(true);
    expect(sandboxes.wasDiscarded("task_e")).toBe(false);
    // Re-acquired on demand; the task workspace keeps its files.
    const again = await sandboxes.acquire("task_t", "s", spec("task"));
    expect(counts.acquired).toBe(3);
    again.done();
    // Once its task finishes, the ephemeral sandbox goes and is recorded discarded.
    statuses.set("task_e", "completed");
    await sandboxes.sweep();
    await until(() => counts.released === 2, { what: "the finished release" });
    expect(sandboxes.wasDiscarded("task_e")).toBe(true);
    expect(sandboxes.wasDiscarded("task_t")).toBe(false);
    await sandboxes.releaseAll();
    expect(counts.released).toBe(3);
  });

  it("releases an open task's idle ephemeral sandbox after the ephemeral time limit", async () => {
    const statuses = new Map<string, TaskStatus>([["task_e", "waiting"]]);
    const { sandboxes, counts } = manager(10, statuses, undefined, {
      ephemeralIdleMs: 60_000,
    });
    (await sandboxes.acquire("task_e", "s", spec("ephemeral"))).done();
    await sandboxes.sweep(Date.now() + 30_000);
    expect(sandboxes.holds("task_e")).toBe(true);
    await sandboxes.sweep(Date.now() + 61_000);
    await until(() => counts.released === 1, { what: "the TTL release" });
    // Its next session fails visibly with the discarded-workspace message.
    expect(sandboxes.wasDiscarded("task_e")).toBe(true);
  });

  it("holds at most maxHeldSandboxes, releasing the least recently used idle one, task workspaces first", async () => {
    const statuses = new Map<string, TaskStatus>(
      ["task_e", "task_a", "task_b", "task_busy", "task_new", "task_more"].map(
        (id) => [id, "waiting"],
      ),
    );
    const { sandboxes, counts } = manager(60_000, statuses, undefined, {
      maxHeldSandboxes: 3,
    });
    (await sandboxes.acquire("task_e", "s", spec("ephemeral"))).done();
    (await sandboxes.acquire("task_a", "s", spec("task"))).done();
    await new Promise((resolve) => setTimeout(resolve, 5));
    (await sandboxes.acquire("task_b", "s", spec("task"))).done();
    // Over the cap: the older idle task workspace goes, not the ephemeral one.
    const busy = await sandboxes.acquire("task_busy", "s", spec("task"));
    await until(() => counts.released === 1, { what: "the LRU release" });
    expect(sandboxes.holds("task_a")).toBe(false);
    expect(sandboxes.holds("task_b")).toBe(true);
    expect(sandboxes.holds("task_e")).toBe(true);
    // A sandbox in use is never released; the ephemeral one goes last.
    const fresh = await sandboxes.acquire("task_new", "s", spec("task"));
    await until(() => counts.released === 2, { what: "the second release" });
    expect(sandboxes.holds("task_b")).toBe(false);
    const more = await sandboxes.acquire("task_more", "s", spec("task"));
    await until(() => counts.released === 3, { what: "the third release" });
    expect(sandboxes.wasDiscarded("task_e")).toBe(true);
    expect(sandboxes.holds("task_busy")).toBe(true);
    busy.done();
    fresh.done();
    more.done();
    await sandboxes.releaseAll();
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
