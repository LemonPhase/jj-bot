import type { JJApi } from "./client";
import { createDemoApi } from "./demoApi";
import { createLiveApi, fetchBootstrap } from "./liveApi";

/**
 * Live backend when `/api/bootstrap` reports `mode: "backend"`; demo data
 * otherwise. Add `?demo` to the URL to force demo data.
 */
export async function resolveApi(): Promise<JJApi> {
  if (new URLSearchParams(window.location.search).has("demo"))
    return createDemoApi();
  const bootstrap = await fetchBootstrap();
  return bootstrap?.mode === "backend"
    ? createLiveApi(bootstrap)
    : createDemoApi();
}
