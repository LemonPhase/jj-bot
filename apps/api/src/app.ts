import { randomUUID } from "node:crypto";
import { HttpAgent } from "@ag-ui/client";
import { EventType } from "@ag-ui/core";
import { CopilotRuntime } from "@copilotkit/runtime/v2";
import { createCopilotHonoHandler } from "@copilotkit/runtime/v2/hono";
import { bootstrapSchema, CONTRACT_VERSION } from "@jj/contracts";
import { Hono } from "hono";

export interface AppConfig {
  agentUrl: string;
  modelConfigured: boolean;
}

export function createApp(config: AppConfig) {
  const app = new Hono();
  // Local, non-durable OSS runner only. This is not JJ's eventual job scheduler.
  const runtime = new CopilotRuntime({
    agents: {
      jj: new HttpAgent({
        url: config.agentUrl,
        description: "JJ execution endpoint · scaffold only",
      }),
    },
  });
  app.get("/health", (context) =>
    context.json({ status: "ok", service: "jj-api", mode: "scaffold" }),
  );
  app.get("/api/bootstrap", (context) =>
    context.json(
      bootstrapSchema.parse({
        mode: "scaffold",
        contractVersion: CONTRACT_VERSION,
        modelConfigured: config.modelConfigured,
        capabilities: {
          agentExecution: false,
          persistence: false,
          taskStreaming: false,
        },
        bots: [],
        tasks: [],
      }),
    ),
  );
  // A real protocol boundary with an explicit unimplemented result, not simulated work.
  app.post("/api/agent", (context) => {
    const events = [
      {
        type: EventType.RUN_ERROR,
        code: "SCAFFOLD_NOT_IMPLEMENTED",
        message:
          "Agent execution is not implemented. Build the Gemini session executor before enabling chat.",
        timestamp: Date.now(),
        id: randomUUID(),
      },
    ];
    return context.body(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      200,
      {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
      },
    );
  });
  app.route(
    "/",
    createCopilotHonoHandler({ runtime, basePath: "/api/copilotkit" }),
  );
  app.notFound((context) => context.json({ error: "NOT_FOUND" }, 404));
  return app;
}
