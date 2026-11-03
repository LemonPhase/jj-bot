import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ApiProvider } from "./api/ApiContext";
import { resolveApi } from "./api/resolveApi";
import { StartFailed } from "./features/shell/AppShell";
import { parseRoute } from "./features/shell/router";
import { preloadScreen } from "./features/shell/screens";
import { WorkspaceProvider } from "./state/WorkspaceContext";
import "./styles/index.css";

// A deep link's or reload's screen starts downloading now, while the API is
// probed and the workspace loads, instead of once they are done.
preloadScreen(parseRoute(window.location.hash));

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing application root");
const root = createRoot(rootElement);

void resolveApi().then(
  (api) =>
    root.render(
      <StrictMode>
        <ApiProvider api={api}>
          <WorkspaceProvider>
            <App />
          </WorkspaceProvider>
        </ApiProvider>
      </StrictMode>,
    ),
  (error: unknown) =>
    root.render(
      <StrictMode>
        <StartFailed
          message={error instanceof Error ? error.message : String(error)}
        />
      </StrictMode>,
    ),
);
