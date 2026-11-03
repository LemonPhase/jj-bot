import type { SecretsView } from "@jj/contracts";
import { useCallback, useEffect, useState } from "react";
import { useApi } from "../../api/ApiContext";

export interface SecretsState {
  /** Null while the first load runs or after it failed. */
  view: SecretsView | null;
  error: string | null;
  reload: () => void;
}

/**
 * `GET /api/secrets`: the stored sandbox secrets by name, never a value.
 * Fetched on mount and again on every `secrets.changed` hint.
 */
export function useSecrets(): SecretsState {
  const api = useApi();
  const [view, setView] = useState<SecretsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);
  // `generation` asks for a reload.
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api.listSecrets().then(
        (next) => {
          if (cancelled) return;
          setView(next);
          setError(null);
        },
        (reason: unknown) => {
          if (!cancelled)
            setError(
              reason instanceof Error
                ? reason.message
                : "Secrets did not load.",
            );
        },
      );
    void load();
    const unsubscribe = api.subscribeHints(
      (hint) => {
        if (hint.type === "secrets.changed") void load();
      },
      { onResync: () => void load() },
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [api, generation]);
  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  return { view, error, reload };
}
