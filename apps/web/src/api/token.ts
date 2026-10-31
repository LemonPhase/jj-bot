/**
 * The optional API bearer token (`API_TOKEN` on the server). It is never part
 * of the bundle: the user opens the app once with `?token=<value>`, which is
 * kept in this browser's localStorage and removed from the address bar.
 * `?token=` with no value forgets it.
 */
const STORAGE_KEY = "jj.apiToken";

interface TokenEnvironment {
  location: Pick<Location, "href">;
  history?: Pick<History, "replaceState">;
  storage?: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

const browserEnvironment = (): TokenEnvironment => {
  let storage: Storage | undefined;
  try {
    storage = window.localStorage;
  } catch {
    // Storage blocked: a pasted token still works for this page load.
  }
  return { location: window.location, history: window.history, storage };
};

export function readApiToken(
  environment: TokenEnvironment = browserEnvironment(),
): string | null {
  const { location, history, storage } = environment;
  const url = new URL(location.href);
  if (url.searchParams.has("token")) {
    const pasted = url.searchParams.get("token")?.trim() ?? "";
    // Drop only the token pair, leaving the rest of the query as typed.
    const rest = url.search
      .slice(1)
      .split("&")
      .filter((pair) => pair && pair !== "token" && !pair.startsWith("token="));
    url.search = rest.length ? `?${rest.join("&")}` : "";
    history?.replaceState(null, "", url.toString());
    try {
      if (pasted) storage?.setItem(STORAGE_KEY, pasted);
      else storage?.removeItem(STORAGE_KEY);
    } catch {
      // Not persisted; used for this page load only.
    }
    return pasted || null;
  }
  try {
    return storage?.getItem(STORAGE_KEY)?.trim() || null;
  } catch {
    return null;
  }
}
