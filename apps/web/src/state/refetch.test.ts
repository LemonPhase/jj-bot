import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRefetcher } from "./refetch";

/** A load whose answers the test releases one by one, in any order. */
function controlledLoad() {
  const pending: ((value: number) => void)[] = [];
  let calls = 0;
  const load = vi.fn(
    () =>
      new Promise<number>((resolve) => {
        calls += 1;
        pending.push(resolve);
      }),
  );
  return { load, pending, calls: () => calls };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("hint refetches", () => {
  it("turns a burst of hints into one request", async () => {
    const { load, pending } = controlledLoad();
    const applied: number[] = [];
    const refetch = createRefetcher(load, (v) => applied.push(v), {
      delayMs: 200,
    });
    refetch.schedule();
    await vi.advanceTimersByTimeAsync(150);
    refetch.schedule();
    refetch.schedule();
    await vi.advanceTimersByTimeAsync(199);
    expect(load).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(load).toHaveBeenCalledTimes(1);
    pending[0]?.(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).toEqual([1]);
  });

  it("still fetches within the max wait while hints keep coming", async () => {
    const { load } = controlledLoad();
    const refetch = createRefetcher(load, () => {}, {
      delayMs: 200,
      maxWaitMs: 1000,
    });
    // A hint every 150 ms would push a plain debounce back forever.
    for (let elapsed = 0; elapsed < 1000; elapsed += 150) {
      refetch.schedule();
      await vi.advanceTimersByTimeAsync(150);
    }
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("applies only the newest answer when requests overlap", async () => {
    const { load, pending } = controlledLoad();
    const applied: number[] = [];
    const refetch = createRefetcher(load, (v) => applied.push(v), {
      delayMs: 10,
    });
    refetch.schedule();
    await vi.advanceTimersByTimeAsync(10);
    void refetch.now();
    expect(load).toHaveBeenCalledTimes(2);
    // The newer request answers first; the older, slower one must not win.
    pending[1]?.(2);
    await vi.advanceTimersByTimeAsync(0);
    pending[0]?.(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).toEqual([2]);
  });

  it("reports only the newest failure and applies nothing after cancel", async () => {
    const errors: unknown[] = [];
    let attempt = 0;
    const refetch = createRefetcher(
      async () => {
        attempt += 1;
        throw new Error(`failed ${attempt}`);
      },
      () => {},
      { delayMs: 5, onError: (reason) => errors.push(reason) },
    );
    await refetch.now();
    expect(errors).toHaveLength(1);
    const { load, pending } = controlledLoad();
    const applied: number[] = [];
    const cancelled = createRefetcher(load, (v) => applied.push(v), {
      delayMs: 5,
    });
    void cancelled.now();
    cancelled.schedule();
    cancelled.cancel();
    pending[0]?.(1);
    await vi.advanceTimersByTimeAsync(10);
    expect(applied).toEqual([]);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
