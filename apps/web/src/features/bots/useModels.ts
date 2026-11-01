import type { ModelsView } from "@jj/contracts";
import { useEffect, useState } from "react";
import { useApi } from "../../api/ApiContext";

/** `GET /api/models`, fetched once per mount. `null` while loading or after a failure. */
export function useModels(): {
  models: ModelsView | null;
  error: string | null;
} {
  const api = useApi();
  const [models, setModels] = useState<ModelsView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    api.getModels().then(
      (view) => {
        if (!cancelled) setModels(view);
      },
      (reason: unknown) => {
        if (!cancelled)
          setError(
            reason instanceof Error ? reason.message : "Models did not load.",
          );
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api]);
  return { models, error };
}
