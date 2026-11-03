import type { JJApi } from "./client";
import { createLiveApi, probeBackend } from "./liveApi";
import { readApiToken } from "./token";

/**
 * The live backend when `/api/bootstrap` answers `mode: "backend"` with a
 * compatible contract. Demo data, with the reason in the badge tooltip, only
 * with `?demo` or when no JJ Bot backend is there at all (a static build, a
 * scaffold API). An API that is unreachable (offline, a 5xx), asks for a
 * token or speaks another contract rejects with the reason instead: demo
 * data would pass for the user's workspace.
 *
 * The demo data is a chunk of its own, downloaded only when it is used, so
 * the live app never loads it. If that chunk cannot load either, this rejects
 * with the reason the backend was not used.
 */
export async function resolveApi(
  loadDemo: () => Promise<typeof import("./demoApi")> = () =>
    import("./demoApi"),
): Promise<JJApi> {
  const demo = async (reason: string) => {
    const { createDemoApi } = await loadDemo().catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${reason} The demo data did not load either: ${detail}`);
    });
    return createDemoApi({ reason });
  };
  const token = readApiToken();
  if (new URLSearchParams(window.location.search).has("demo"))
    return demo("Opened with ?demo.");
  const probe = await probeBackend({ token });
  if (probe.ok)
    return createLiveApi({
      bootstrap: probe.bootstrap,
      models: probe.models,
      token,
    });
  if (!probe.demo) throw new Error(probe.reason);
  return demo(probe.reason);
}
