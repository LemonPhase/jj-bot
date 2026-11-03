import type { JJApi } from "./client";
import { createLiveApi, probeBackend } from "./liveApi";
import { readApiToken } from "./token";

/**
 * The live backend when `/api/bootstrap` answers `mode: "backend"` with a
 * compatible contract; demo data otherwise, with the reason in the badge
 * tooltip. Add `?demo` to the URL to force demo data.
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
  return probe.ok
    ? createLiveApi({ bootstrap: probe.bootstrap, models: probe.models, token })
    : demo(probe.reason);
}
