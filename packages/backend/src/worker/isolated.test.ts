import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { liveIsolatedThreads, runIsolated } from "./isolated";

const until = async (check: () => boolean, ms: number) => {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  return check();
};

const busyWait = (ms: number) => {
  const end = Date.now() + ms;
  while (Date.now() < end);
};

// Backtracks for minutes.
const catastrophic = {
  kind: "match",
  pattern: "^(\\w+\\s?)+$",
  text: `${"a".repeat(40)}!`,
} as const;
// Backtracks for a few milliseconds of processor time in a fresh thread
// (whose first match is interpreted): far less than a thread must use before
// its limit stops it, yet long enough that its result arrives after the main
// thread has handled the thread's "ready".
const briefBacktrack = { ...catastrophic, text: `${"a".repeat(16)}!` };

beforeEach(async () => {
  // Each test starts once an earlier one's threads are gone (one that failed
  // may not have waited for them).
  await until(() => liveIsolatedThreads() === 0, 10_000);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("isolated evaluation", () => {
  it("matches, validates and reports issues", async () => {
    expect(
      await runIsolated({ kind: "match", pattern: "b+", text: "abbbc" }),
    ).toEqual({ ok: true, result: { kind: "match", index: 1, text: "bbb" } });
    expect(
      await runIsolated({ kind: "match", pattern: "z", text: "abc" }),
    ).toEqual({ ok: true, result: { kind: "nomatch" } });
    expect(
      await runIsolated({
        kind: "schema",
        schema: {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
        },
        value: {},
      }),
    ).toMatchObject({ ok: true, result: { kind: "invalid", count: 1 } });
  });

  it("stops a catastrophic pattern at its limit, and leaves no thread or CPU behind", async () => {
    const started = Date.now();
    const outcome = await runIsolated(catastrophic, 500);
    // Stopped for running past its limit, not for waiting on a busy host.
    expect(outcome).toEqual({
      ok: false,
      reason: "timeout",
      message: "it did not finish within 0.5 s",
    });
    expect(Date.now() - started).toBeLessThan(5_000);
    // The thread is terminated, not left spinning.
    expect(await until(() => liveIsolatedThreads() === 0, 2_000)).toBe(true);
    const before = process.cpuUsage();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const used = process.cpuUsage(before);
    expect(used.user + used.system).toBeLessThan(500_000);
  }, 20_000);

  it("finishes trivial checks run all at once, timing only the evaluation", async () => {
    const outcomes = await Promise.all(
      // A tight limit: starting 40 threads and loading the schema library
      // takes far longer than this, the evaluation itself far less.
      Array.from({ length: 40 }, () =>
        runIsolated(
          {
            kind: "schema",
            schema: { type: "object" },
            value: {},
          },
          150,
        ),
      ),
    );
    expect(
      outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome),
    ).toEqual([]);
    expect(await until(() => liveIsolatedThreads() === 0, 5_000)).toBe(true);
  }, 60_000);

  // A busy main thread: right after the thread is ready, it is kept busy far
  // past the limit, so the limit's timer is due by the time the result is
  // taken. Neither the processor time nor (where Node cannot tell it) the
  // order of arrival counts that wait against the evaluation.
  it.each([
    ["by its processor time", false],
    ["by the clock where Node cannot tell processor time", true],
  ])(
    "does not count a busy main thread against an evaluation that finished in time, %s",
    async (_, clockOnly) => {
      const cpuUsage = Object.getOwnPropertyDescriptor(
        Worker.prototype,
        "cpuUsage",
      );
      if (clockOnly)
        Object.defineProperty(Worker.prototype, "cpuUsage", {
          value: undefined,
          configurable: true,
          writable: true,
        });
      const limit = 400;
      const realSetTimeout = globalThis.setTimeout;
      let blocked = false;
      vi.spyOn(globalThis, "setTimeout").mockImplementation(((
        callback: (...args: unknown[]) => void,
        ms?: number,
        ...args: unknown[]
      ) => {
        if (ms === limit && !blocked) {
          // The limit starts: the main thread then stays busy past it.
          blocked = true;
          setImmediate(() => busyWait(3 * limit));
        }
        return realSetTimeout(callback, ms, ...args);
      }) as typeof setTimeout);
      try {
        const outcome = await runIsolated(briefBacktrack, limit);
        expect(blocked).toBe(true);
        expect(outcome).toEqual({ ok: true, result: { kind: "nomatch" } });
      } finally {
        if (cpuUsage)
          Object.defineProperty(Worker.prototype, "cpuUsage", cpuUsage);
      }
    },
  );

  // The next two report the thread's processor time as a host that keeps it
  // waiting would: none at first, or none at all.
  it("gives a thread the host kept waiting until it has run, then stops it at its limit", async () => {
    let looks = 0;
    vi.spyOn(Worker.prototype, "cpuUsage").mockImplementation(async () => {
      looks += 1;
      return looks === 1
        ? { user: 0, system: 0 }
        : { user: 60_000_000, system: 0 };
    });
    const started = Date.now();
    const outcome = await runIsolated(catastrophic, 200, 5_000);
    expect(outcome).toEqual({
      ok: false,
      reason: "timeout",
      message: "it did not finish within 0.2 s",
    });
    expect(looks).toBe(2);
    // Looked at again once it could have run long enough, not at the end of its allowance.
    expect(Date.now() - started).toBeGreaterThanOrEqual(300);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await until(() => liveIsolatedThreads() === 0, 2_000)).toBe(true);
  });

  it("stops a thread the host never runs once its allowance is up, without blaming the pattern", async () => {
    vi.spyOn(Worker.prototype, "cpuUsage").mockResolvedValue({
      user: 0,
      system: 0,
    });
    const started = Date.now();
    const outcome = await runIsolated(catastrophic, 200, 300);
    expect(outcome).toEqual({
      ok: false,
      reason: "busy",
      message: expect.stringMatching(
        /^the host was too busy to run it: it had 0 ms of processor time in \d+(\.\d)? s$/,
      ),
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await until(() => liveIsolatedThreads() === 0, 2_000)).toBe(true);
  });

  it("ends the check at the end of its allowance even when the thread never answers", async () => {
    // Node answers on the thread itself; a thread the host does not run (or
    // one blocked in a call) does not answer at all.
    vi.spyOn(Worker.prototype, "cpuUsage").mockReturnValue(
      new Promise(() => {}),
    );
    const started = Date.now();
    const outcome = await Promise.race([
      runIsolated(catastrophic, 200, 300),
      new Promise<"still pending">((resolve) =>
        setTimeout(() => resolve("still pending"), 5_000),
      ),
    ]);
    expect(outcome).toEqual({
      ok: false,
      reason: "busy",
      message: expect.stringMatching(
        /^the host was too busy to run it: it had 0 ms of processor time in \d+(\.\d)? s$/,
      ),
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(500);
    // The spinning thread is terminated, not left running.
    expect(await until(() => liveIsolatedThreads() === 0, 2_000)).toBe(true);
  });

  it("never throws, even for a value it cannot copy to its thread", async () => {
    const outcome = await runIsolated({
      kind: "schema",
      schema: { type: "object" },
      value: { fn: () => 1 },
    });
    expect(outcome).toMatchObject({ ok: false, reason: "error" });
    expect(liveIsolatedThreads()).toBe(0);
  });
});
