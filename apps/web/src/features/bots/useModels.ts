import type { ModelsView } from "@jj/contracts";
import { useCallback, useEffect, useState } from "react";
import { useApi } from "../../api/ApiContext";

/**
 * `GET /api/models`, fetched on mount and again whenever a stored key changes
 * (`secrets.changed`). `null` while loading or after a failure. `replace`
 * shows a view a key change answered with, without waiting for the refetch.
 */
export function useModels(): {
  models: ModelsView | null;
  error: string | null;
  replace: (view: ModelsView) => void;
} {
  const api = useApi();
  const [models, setModels] = useState<ModelsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api.getModels().then(
        (view) => {
          if (cancelled) return;
          setModels(view);
          setError(null);
        },
        (reason: unknown) => {
          if (!cancelled)
            setError(
              reason instanceof Error ? reason.message : "Models did not load.",
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
  }, [api]);
  const replace = useCallback((view: ModelsView) => {
    setModels(view);
    setError(null);
  }, []);
  return { models, error, replace };
}
