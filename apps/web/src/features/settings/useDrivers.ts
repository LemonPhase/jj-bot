import type { SandboxDriverInfo } from "@jj/contracts";
import { useCallback, useEffect, useState } from "react";
import { useApi } from "../../api/ApiContext";

export interface DriversState {
  /** Null while the first load runs or after it failed. */
  drivers: SandboxDriverInfo[] | null;
  error: string | null;
  loading: boolean;
  /** Asks the server again (it reuses probe results for a few seconds). */
  reload: () => void;
}

/** `GET /api/sandbox-drivers`: availability, capabilities and the spec schema of each driver. */
export function useDrivers(): DriversState {
  const api = useApi();
  const [drivers, setDrivers] = useState<SandboxDriverInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [generation, setGeneration] = useState(0);

  // `generation` asks for a reload.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.listDrivers().then(
      (list) => {
        if (cancelled) return;
        setDrivers(list);
        setError(null);
        setLoading(false);
      },
      (reason: unknown) => {
        if (cancelled) return;
        setError(
          reason instanceof Error ? reason.message : "Drivers did not load.",
        );
        setLoading(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, generation]);

  const reload = useCallback(() => setGeneration((value) => value + 1), []);
  return { drivers, error, loading, reload };
}
