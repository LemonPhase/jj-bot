/**
 * A debounced refetch where only the newest response lands. Workspace hints
 * often arrive in bursts (a task step changes the task list and the bots);
 * each burst becomes one request, a steady stream still fetches at least
 * every `maxWaitMs`, and a slow older answer never overwrites a newer one.
 */
export interface Refetcher {
  /** Fetch after `delayMs` of quiet; later calls push the fetch back. */
  schedule(): void;
  /** Fetch now, cancelling any scheduled fetch. */
  now(): Promise<void>;
  /** Stop: nothing scheduled or in flight is applied afterwards. */
  cancel(): void;
}

export function createRefetcher<Value>(
  load: () => Promise<Value>,
  apply: (value: Value) => void,
  options: {
    delayMs: number;
    /**
     * The longest a fetch waits once scheduled, however often it is pushed
     * back, so a steady stream of hints cannot stall it. Default 1000 ms.
     */
    maxWaitMs?: number;
    onError?: (reason: unknown) => void;
  },
): Refetcher {
  const maxWait = options.maxWaitMs ?? 1000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** When the first still-unserved schedule() call came, for the max wait. */
  let firstAsked: number | null = null;
  let latest = 0;
  let cancelled = false;

  const run = async () => {
    clearTimeout(timer);
    timer = undefined;
    firstAsked = null;
    const request = ++latest;
    try {
      const value = await load();
      if (!cancelled && request === latest) apply(value);
    } catch (reason) {
      if (!cancelled && request === latest) options.onError?.(reason);
    }
  };

  return {
    schedule() {
      if (cancelled) return;
      const now = Date.now();
      firstAsked ??= now;
      clearTimeout(timer);
      const wait = Math.min(
        options.delayMs,
        Math.max(0, firstAsked + maxWait - now),
      );
      timer = setTimeout(() => void run(), wait);
    },
    now: () => (cancelled ? Promise.resolve() : run()),
    cancel() {
      cancelled = true;
      clearTimeout(timer);
    },
  };
}
