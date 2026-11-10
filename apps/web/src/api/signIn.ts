/**
 * What a load brings to sign in with, loaded only when it brings something
 * (`hasPendingSignIn`): a login link's one-time code (`#/login?code=`), an
 * old link's `?token=`, or a token an earlier version kept in localStorage.
 * The code and the token leave the address bar at once; the code signs this
 * browser in; a kept token is exchanged once for a session and deleted.
 */
import type { AuthState, LoginCommand } from "@jj/contracts";
import {
  type AuthApi,
  isLoginHash,
  LEGACY_TOKEN_KEY,
  LOGIN_HASH,
} from "./auth";
import { ApiError } from "./client";

interface AddressEnvironment {
  location: Pick<Location, "href">;
  history?: Pick<History, "replaceState">;
}

const browser = (): AddressEnvironment => ({
  location: window.location,
  history: window.history,
});

/**
 * Takes the one-time code out of a login link's address
 * (`#/login?code=…`), leaving `#/login` in the address bar and its history
 * entry, and returns it. The code lives in the fragment, which the browser
 * never sends to a server.
 */
export function takeLoginCode(
  environment: AddressEnvironment = browser(),
): string | null {
  const url = new URL(environment.location.href);
  if (!isLoginHash(url.hash)) return null;
  const query = url.hash.slice(LOGIN_HASH.length + 1);
  const code = new URLSearchParams(query).get("code")?.trim() || null;
  if (query) {
    url.hash = LOGIN_HASH;
    environment.history?.replaceState(null, "", url.toString());
  }
  return code;
}

/**
 * Removes a `?token=` from the address bar. Tokens no longer travel in
 * URLs: an old link's token is not used, and the address is not kept.
 */
export function dropTokenFromAddress(
  environment: AddressEnvironment = browser(),
): void {
  const url = new URL(environment.location.href);
  if (!url.searchParams.has("token")) return;
  const rest = url.search
    .slice(1)
    .split("&")
    .filter((pair) => pair && pair !== "token" && !pair.startsWith("token="));
  url.search = rest.length ? `?${rest.join("&")}` : "";
  environment.history?.replaceState(null, "", url.toString());
}

type TokenStorage = Pick<Storage, "getItem" | "removeItem">;

const browserStorage = (): TokenStorage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

/**
 * Deletes a token an earlier version kept in localStorage, unused: for a
 * server without the sign-in routes, which has no session to exchange it for
 * and to which this app never sends it.
 */
export function forgetKeptToken(
  storage: TokenStorage | undefined = browserStorage(),
): void {
  try {
    storage?.removeItem(LEGACY_TOKEN_KEY);
  } catch {
    // Storage blocked: nothing was kept.
  }
}

/** What the app opens on: the workspace, or the login screen with why. */
export type SignIn =
  | { signedIn: true }
  | { signedIn: false; state: AuthState; error?: string };

/**
 * Signs this browser in with a login link's code, or once with a token an
 * earlier version kept in localStorage: on its own, or when the code fails.
 * The token is deleted once the server has answered it, or at once when the
 * browser is signed in already.
 */
export async function signInOnce(
  auth: AuthApi,
  state: AuthState,
  code: string | null,
  storage: TokenStorage | undefined = browserStorage(),
): Promise<SignIn> {
  let token: string | null = null;
  try {
    token = storage?.getItem(LEGACY_TOKEN_KEY)?.trim() || null;
  } catch {
    // Storage blocked: nothing was kept.
  }
  const forget = () => forgetKeptToken(storage);
  if (!state.required || state.authenticated) {
    forget();
    return { signedIn: true };
  }
  const attempt = async (command: LoginCommand) => {
    try {
      await auth.login(command);
      return null;
    } catch (error) {
      if (error instanceof ApiError && error.code === "NETWORK_ERROR")
        throw error;
      return error instanceof Error ? error.message : String(error);
    }
  };
  const codeFailed = code ? await attempt({ code }) : null;
  if (code && !codeFailed) {
    forget();
    return { signedIn: true };
  }
  if (token) {
    const failed = await attempt({ token });
    forget();
    if (!failed) return { signedIn: true };
  }
  return codeFailed
    ? {
        signedIn: false,
        state,
        error: `${codeFailed} A login link works once, for 15 minutes: sign in with the token, or print a new link with \`npm run auth:login-link\`.`,
      }
    : { signedIn: false, state };
}
