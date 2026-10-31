import type { JJApi } from "./client";
import { createDemoApi } from "./demoApi";
import { createLiveApi, probeBackend } from "./liveApi";
import { readApiToken } from "./token";

/**
 * The live backend when `/api/bootstrap` answers `mode: "backend"` with a
 * compatible contract; demo data otherwise, with the reason in the badge
 * tooltip. Add `?demo` to the URL to force demo data.
 */
export async function resolveApi(): Promise<JJApi> {
  const token = readApiToken();
  if (new URLSearchParams(window.location.search).has("demo"))
    return createDemoApi({ reason: "Opened with ?demo." });
  const probe = await probeBackend({ token });
  return probe.ok
    ? createLiveApi({ bootstrap: probe.bootstrap, models: probe.models, token })
    : createDemoApi({ reason: probe.reason });
}
