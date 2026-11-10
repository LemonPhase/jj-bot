import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ApiProvider } from "./api/ApiContext";
import { isLoginHash, LOGIN_HASH } from "./api/auth";
import { resolveApi, type Startup } from "./api/resolveApi";
import { Spinner } from "./components/ui";
import { StartFailed } from "./features/shell/AppShell";
import { parseRoute } from "./features/shell/router";
import { preloadScreen } from "./features/shell/screens";
import { LoadBoundary, lazyComponent } from "./lib/lazyComponent";
import { registerServiceWorker } from "./lib/serviceWorker";
import { watchStylesheets } from "./lib/stylesheets";
import { WorkspaceProvider } from "./state/WorkspaceContext";
import "./styles/index.css";

/** The login screen, loaded only when the browser is not signed in. */
const loginScreen = lazyComponent("LoginScreen", () =>
  import("./features/auth/LoginScreen").then((module) => module.LoginScreen),
);

// Before any lazy chunk loads: a stylesheet that fails is asked for again
// before the next chunk renders, never skipped.
watchStylesheets();
// A deep link's or reload's screen starts downloading now, while the API is
// probed and the workspace loads, instead of once they are done.
preloadScreen(parseRoute(window.location.hash));
// After the page has loaded, in production builds only.
registerServiceWorker();

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing application root");
const root = createRoot(rootElement);

/** Where to go once signed in: where the user was, never the login screen. */
let returnTo = isLoginHash(window.location.hash) ? "" : window.location.hash;

const setHash = (hash: string) =>
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}${hash}`,
  );

let starting = false;
/** Signs in if needed, then opens the workspace. */
function start() {
  if (starting) return;
  starting = true;
  void resolveApi(undefined, signedOut)
    .then(show, (error: unknown) =>
      root.render(
        <StrictMode>
          <StartFailed
            message={error instanceof Error ? error.message : String(error)}
          />
        </StrictMode>,
      ),
    )
    .finally(() => {
      starting = false;
    });
}

/** A request or stream found the session ended: back to the login screen. */
function signedOut() {
  if (!isLoginHash(window.location.hash)) returnTo = window.location.hash;
  start();
}

function show(startup: Startup) {
  if (startup.kind === "login") {
    if (!isLoginHash(window.location.hash)) {
      returnTo = window.location.hash;
      setHash(LOGIN_HASH);
    }
    root.render(
      <StrictMode>
        <LoadBoundary
          failed={(error) => (
            <StartFailed message={`the sign-in screen: ${error.message}`} />
          )}
        >
          <Suspense
            fallback={
              <main className="screen screen--center">
                <Spinner label="Loading…" showLabel />
              </main>
            }
          >
            <loginScreen.Component
              auth={startup.auth}
              state={startup.state}
              {...(startup.error ? { error: startup.error } : {})}
              onSignedIn={start}
            />
          </Suspense>
        </LoadBoundary>
      </StrictMode>,
    );
    return;
  }
  if (isLoginHash(window.location.hash)) setHash(returnTo);
  root.render(
    <StrictMode>
      <ApiProvider api={startup.api}>
        <WorkspaceProvider>
          <App />
        </WorkspaceProvider>
      </ApiProvider>
    </StrictMode>,
  );
}

// A login link opened in this tab changes only the hash: sign in with its
// code now (which also takes it out of the address bar), then go back to
// where the user was.
window.addEventListener("hashchange", (event) => {
  if (!window.location.hash.startsWith(`${LOGIN_HASH}?`)) return;
  const previous = new URL(event.oldURL).hash;
  if (!isLoginHash(previous)) returnTo = previous;
  start();
});

start();
