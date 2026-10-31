import { CopilotKit } from "@copilotkit/react-core/v2";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ApiProvider } from "./api/ApiContext";
import { createDemoApi } from "./api/demoApi";
import { WorkspaceProvider } from "./state/WorkspaceContext";
import "./styles.css";

// Placeholder backend. Swap for a real `JJApi` implementation once the API is ready.
const api = createDemoApi();

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
createRoot(root).render(
  <StrictMode>
    <CopilotKit
      runtimeUrl="/api/copilotkit"
      agent="jj"
      showDevConsole={false}
      enableInspector={false}
    >
      <ApiProvider api={api}>
        <WorkspaceProvider>
          <App />
        </WorkspaceProvider>
      </ApiProvider>
    </CopilotKit>
  </StrictMode>,
);
