import type { AuthState } from "@jj/contracts";
import {
  type AuthApi,
  authState,
  createAuthApi,
  hasPendingSignIn,
} from "./auth";
import { ApiError, type JJApi } from "./client";
import { createLiveApi, probeBackend } from "./liveApi";

/** What the app opens on: the workspace, or the login screen first. */
export type Startup =
  | { kind: "app"; api: JJApi }
  | { kind: "login"; auth: AuthApi; state: AuthState; error?: string };

const UNREACHABLE = "The JJ Bot API isn't reachable.";

/**
 * The live backend when `/api/bootstrap` answers `mode: "backend"` with a
 * compatible contract, once this browser is signed in where the server asks
 * for it: a login link's code (`#/login?code=`) signs it in on the way, and
 * otherwise the login screen comes first. Demo data, with the reason in the
 * badge tooltip, only with `?demo` or when no JJ Bot backend is there at all
 * (a static build, a scaffold API). An API that is unreachable (offline, a
 * 5xx) or speaks another contract rejects with the reason instead: demo data
 * would pass for the user's workspace.
 *
 * The demo data is a chunk of its own, downloaded only when it is used, so
 * the live app never loads it. If that chunk cannot load either, this rejects
 * with the reason the backend was not used. So is what signs in with a code
 * or a kept token (./signIn.ts), loaded only when the load brings one.
 *
 * `onSignedOut` runs when a request or stream later finds the session ended.
 */
export async function resolveApi(
  loadDemo: () => Promise<typeof import("./demoApi")> = () =>
    import("./demoApi"),
  onSignedOut?: () => void,
): Promise<Startup> {
  const demo = async (reason: string): Promise<Startup> => {
    const { createDemoApi } = await loadDemo().catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${reason} The demo data did not load either: ${detail}`);
    });
    return { kind: "app", api: createDemoApi({ reason }) };
  };
  // Neither a login code nor an old token stays in the address bar.
  let storage: Storage | undefined;
  try {
    storage = window.localStorage;
  } catch {
    // Storage blocked: no token was kept.
  }
  const pending = hasPendingSignIn(window.location.href, storage)
    ? await import("./signIn")
    : null;
  pending?.dropTokenFromAddress();
  const code = pending?.takeLoginCode() ?? null;
  if (new URLSearchParams(window.location.search).has("demo"))
    return demo("Opened with ?demo.");
  const auth = createAuthApi();
  let state: AuthState | null;
  try {
    state = await authState(auth);
    // No sign-in routes: a kept token has nothing to be exchanged for.
    if (state === null) pending?.forgetKeptToken();
    else if (pending) {
      const signIn = await pending.signInOnce(auth, state, code);
      if (!signIn.signedIn)
        return {
          kind: "login",
          auth,
          state,
          ...(signIn.error ? { error: signIn.error } : {}),
        };
    } else if (state.required && !state.authenticated)
      return { kind: "login", auth, state };
  } catch (error) {
    if (error instanceof ApiError && error.code === "NETWORK_ERROR")
      throw new Error(UNREACHABLE);
    throw error;
  }
  const probe = await probeBackend({});
  if (probe.ok)
    return {
      kind: "app",
      api: createLiveApi({
        bootstrap: probe.bootstrap,
        models: probe.models,
        // A server without the sign-in routes (null) has no devices to list.
        ...(state ? { auth } : {}),
        ...(onSignedOut ? { onUnauthorized: onSignedOut } : {}),
      }),
    };
  if (!probe.demo) throw new Error(probe.reason);
  return demo(probe.reason);
}
