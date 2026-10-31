import { CopilotKit } from "@copilotkit/react-core/v2";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

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
      <App />
    </CopilotKit>
  </StrictMode>,
);
