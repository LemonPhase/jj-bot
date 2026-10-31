import { HttpAgent } from "@ag-ui/client";
import { CopilotRuntime } from "@copilotkit/runtime/v2";
import { createCopilotHonoHandler } from "@copilotkit/runtime/v2/hono";
import type { BackendService } from "@jj/backend";
import { bootstrapSchema, CONTRACT_VERSION } from "@jj/contracts";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { backendRoutes, createAgentTask } from "./routes";

export interface AppConfig {
  agentUrl: string;
  modelConfigured: boolean;
  service?: BackendService;
  apiToken?: string;
}
export function createApp(config: AppConfig) {
  const app = new Hono();
  const service = config.service;
  if (config.apiToken)
    app.use("/api/*", async (c, next) => {
      if (c.req.header("Authorization") !== `Bearer ${config.apiToken}`)
        return c.json({ error: "UNAUTHORIZED" }, 401);
      await next();
    });
  const runtime = new CopilotRuntime({
    agents: {
      jj: new HttpAgent({
        url: config.agentUrl,
        headers: config.apiToken
          ? { Authorization: `Bearer ${config.apiToken}` }
          : {},
        description: "JJ Bot durable execution",
      }),
    },
  });
  app.get("/health", (c) =>
    c.json({
      status: "ok",
      service: "jj-api",
      mode: service ? "backend" : "scaffold",
    }),
  );
  app.get("/api/bootstrap", async (c) =>
    c.json(
      bootstrapSchema.parse({
        mode: service ? "backend" : "scaffold",
        contractVersion: CONTRACT_VERSION,
        modelConfigured: config.modelConfigured,
        capabilities: {
          agentExecution: Boolean(service && config.modelConfigured),
          persistence: Boolean(service),
          taskStreaming: Boolean(service),
        },
        bots: service ? await service.listBots() : [],
        tasks: service ? await service.listTasks() : [],
      }),
    ),
  );
  if (service) app.route("/api", backendRoutes(service));
  app.post("/api/agent", async (c) => {
    if (!service)
      return c.body(
        `data: ${JSON.stringify({ type: "RUN_ERROR", code: "SCAFFOLD_NOT_IMPLEMENTED", message: "Agent execution is not implemented." })}\n\n`,
        200,
        { "Content-Type": "text/event-stream" },
      );
    let run: Awaited<ReturnType<typeof createAgentTask>>;
    try {
      run = await createAgentTask(service, await c.req.json());
    } catch (error) {
      return c.json(
        {
          error: "INVALID_AGENT_REQUEST",
          message: error instanceof Error ? error.message : "Invalid request",
        },
        400,
      );
    }
    return streamSSE(c, async (stream) => {
      const emit = (event: unknown) =>
        stream.writeSSE({ data: JSON.stringify(event) });
      await emit({
        type: "RUN_STARTED",
        threadId: run.threadId,
        runId: run.runId,
      });
      await emit({
        type: "CUSTOM",
        name: "jj.task",
        value: { taskId: run.taskId },
      });
      let after = 0;
      while (!stream.aborted) {
        const events = await service.store.events(run.taskId, after);
        for (const event of events) {
          await emit({ type: "CUSTOM", name: "jj.task.event", value: event });
          after = event.sequence;
        }
        const task = await service.getTask(run.taskId);
        if (
          ["completed", "failed", "cancelled", "waiting"].includes(task.status)
        ) {
          if (task.result) {
            await emit({
              type: "TEXT_MESSAGE_START",
              messageId: run.messageId,
              role: "assistant",
            });
            await emit({
              type: "TEXT_MESSAGE_CONTENT",
              messageId: run.messageId,
              delta: task.result,
            });
            await emit({ type: "TEXT_MESSAGE_END", messageId: run.messageId });
          }
          if (task.status === "completed")
            await emit({
              type: "RUN_FINISHED",
              threadId: run.threadId,
              runId: run.runId,
            });
          else
            await emit({
              type: "RUN_ERROR",
              code: `TASK_${task.status.toUpperCase()}`,
              message: `Task is ${task.status}; inspect its snapshot for evidence and next actions.`,
            });
          return;
        }
        await stream.sleep(250);
      }
      // Closing a browser connection never cancels the durable task.
    });
  });
  app.route(
    "/",
    createCopilotHonoHandler({ runtime, basePath: "/api/copilotkit" }),
  );
  app.notFound((c) => c.json({ error: "NOT_FOUND" }, 404));
  return app;
}
