/**
 * A debounced refetch where only the newest response lands. Workspace hints
 * often arrive in bursts (a task step changes the task list and the bots);
 * each burst becomes one request, and a slow older answer never overwrites a
 * newer one.
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
  options: { delayMs: number; onError?: (reason: unknown) => void },
): Refetcher {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest = 0;
  let cancelled = false;

  const run = async () => {
    clearTimeout(timer);
    timer = undefined;
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
      clearTimeout(timer);
      timer = setTimeout(() => void run(), options.delayMs);
    },
    now: () => (cancelled ? Promise.resolve() : run()),
    cancel() {
      cancelled = true;
      clearTimeout(timer);
    },
  };
}
