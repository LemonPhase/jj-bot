import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ApiProvider } from "./api/ApiContext";
import { resolveApi } from "./api/resolveApi";
import { StartFailed } from "./features/shell/AppShell";
import { WorkspaceProvider } from "./state/WorkspaceContext";
import "./styles/index.css";

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
