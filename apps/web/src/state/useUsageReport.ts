import type { UsageReport } from "@jj/contracts";
import { useEffect, useState } from "react";
import { useApi } from "../api/ApiContext";
import { createRefetcher } from "./refetch";

export interface UsageState {
  /** Null while the first load runs, or when it failed. */
  report: UsageReport | null;
  error: string | null;
}

/**
 * `GET /api/usage`, fetched on mount and again when a task or a conversation
 * changes (spend moves with them) or a profile does (caps move with those),
 * debounced so a busy task costs one request a few seconds.
 */
export function useUsageReport(): UsageState {
  const api = useApi();
  const [state, setState] = useState<UsageState>({
    report: null,
    error: null,
  });

  useEffect(() => {
    const refetch = createRefetcher(
      api.getUsage,
      (report) => setState({ report, error: null }),
      {
        delayMs: 1_000,
        maxWaitMs: 5_000,
        onError: (reason) =>
          setState((current) => ({
            ...current,
            error:
              reason instanceof Error ? reason.message : "Usage did not load.",
          })),
      },
    );
    void refetch.now();
    const unsubscribe = api.subscribeHints(
      (hint) => {
        if (
          hint.type === "tasks.changed" ||
          hint.type === "conversation.changed" ||
          hint.type === "profiles.changed" ||
          hint.type === "bots.changed"
        )
          refetch.schedule();
      },
      { onResync: () => refetch.schedule() },
    );
    return () => {
      refetch.cancel();
      unsubscribe();
    };
  }, [api]);

  return state;
}
