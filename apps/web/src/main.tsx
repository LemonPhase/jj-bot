import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ApiProvider } from "./api/ApiContext";
import { resolveApi } from "./api/resolveApi";
import { WorkspaceProvider } from "./state/WorkspaceContext";
import "./styles.css";

const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing application root");
const root = createRoot(rootElement);

void resolveApi().then((api) =>
  root.render(
    <StrictMode>
      <ApiProvider api={api}>
        <WorkspaceProvider>
          <App />
        </WorkspaceProvider>
      </ApiProvider>
    </StrictMode>,
  ),
);
