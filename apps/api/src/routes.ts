import { randomUUID } from "node:crypto";
import { BackendError, type BackendService } from "@jj/backend";
import { z } from "@jj/contracts/legacy";
import {
  botTurnCommandSchema,
  createBotSchema,
  createTaskSchema,
  postMessageSchema,
  spawnSessionSchema,
  steerTaskSchema,
  stopTaskSchema,
} from "@jj/contracts/legacy/backend";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";

export function backendRoutes(service: BackendService) {
  const routes = new Hono();
  routes.onError((error, context) => {
    if (error instanceof z.ZodError)
      return context.json(
        { error: "VALIDATION_ERROR", issues: error.issues },
        400,
      );
    if (error instanceof SyntaxError)
      return context.json({ error: "INVALID_JSON" }, 400);
    if (error instanceof BackendError)
      return context.json(
        { error: error.code, message: error.message },
        error.status as 400,
      );
    console.error(
      "Backend request failed",
      error instanceof Error ? error.name : "UnknownError",
    );
    return context.json({ error: "INTERNAL_ERROR" }, 500);
  });
  routes.get("/bots", async (c) => c.json({ bots: await service.listBots() }));
  routes.post("/bots", async (c) =>
    c.json(
      await service.createBot(createBotSchema.parse(await c.req.json())),
      201,
    ),
  );
  routes.get("/bots/:id", async (c) =>
    c.json(await service.getBot(c.req.param("id"))),
  );
  routes.get("/bots/:id/memory", async (c) =>
    c.json({ memory: await service.getMemory(c.req.param("id")) }),
  );
  routes.put("/bots/:id/memory", async (c) => {
    const { text } = z
      .object({ text: z.string().max(20000) })
      .parse(await c.req.json());
    return c.json(await service.setMemory(c.req.param("id"), text));
  });
  routes.get("/bots/:id/messages", async (c) =>
    c.json({ messages: await service.listConversation(c.req.param("id")) }),
  );
  routes.post("/bots/:id/messages", async (c) => {
    const body = z
      .object({
        text: z.string().min(1).max(20000),
        participantBotIds: z.array(z.string()).optional(),
        verificationPlan: createTaskSchema.shape.verificationPlan.optional(),
        checks: createTaskSchema.shape.checks.optional(),
      })
      .parse(await c.req.json());
    const bot = await service.getBot(c.req.param("id"));
    const task = await service.createTask({
      goal: body.text,
      coordinatorBotId: bot.id,
      participantBotIds: body.participantBotIds ?? [bot.id],
      verificationPlan: body.verificationPlan ?? [
        {
          id: "request",
          description:
            "Address the user request accurately, with supporting evidence and any remaining limitations.",
          method: "Independent rubric review",
          expectedEvidence:
            "Supporting context/tool results and reviewer assessment",
        },
      ],
      checks: body.checks,
    });
    await service.recordConversation({
      botId: bot.id,
      role: "user",
      text: body.text,
      taskId: task.id,
    });
    return c.json({ task }, 202);
  });
  routes.post("/bots/:id/turn", async (c) => {
    const { text } = botTurnCommandSchema.parse(await c.req.json());
    return c.json(await service.botTurn(c.req.param("id"), text));
  });
  routes.get("/tasks", async (c) =>
    c.json({ tasks: await service.listTasks() }),
  );
  routes.post("/tasks", async (c) =>
    c.json(
      await service.createTask(createTaskSchema.parse(await c.req.json())),
      201,
    ),
  );
  routes.get("/tasks/:id", async (c) =>
    c.json(await service.snapshot(c.req.param("id"))),
  );
  routes.get("/tasks/:id/view", async (c) =>
    c.json(await service.snapshot(c.req.param("id"))),
  );
  routes.post("/tasks/:id/messages", async (c) =>
    c.json(
      await service.postMessage(
        c.req.param("id"),
        postMessageSchema.parse(await c.req.json()),
      ),
      201,
    ),
  );
  routes.post("/tasks/:id/sessions", async (c) =>
    c.json(
      await service.spawnSession(
        c.req.param("id"),
        spawnSessionSchema.parse(await c.req.json()),
      ),
      201,
    ),
  );
  routes.post("/tasks/:id/steer", async (c) =>
    c.json(
      await service.steer(
        c.req.param("id"),
        steerTaskSchema.parse(await c.req.json()),
      ),
    ),
  );
  const stopHandler = async (c: {
    req: { param(name: string): string; text(): Promise<string> };
    json(data: unknown): Response;
  }) => {
    const raw = (await c.req.text()).trim();
    const parsed = raw ? stopTaskSchema.parse(JSON.parse(raw)) : {};
    return c.json(await service.cancel(c.req.param("id"), parsed.reason));
  };
  routes.post("/tasks/:id/stop", stopHandler);
  routes.post("/tasks/:id/cancel", stopHandler);
  routes.post("/tasks/:id/participants", async (c) => {
    const { botId, activate } = z
      .object({
        botId: z.string().min(1),
        activate: z.boolean().optional(),
      })
      .parse(await c.req.json());
    return c.json(
      await service.addParticipant(c.req.param("id"), botId, Boolean(activate)),
    );
  });
  routes.post("/tasks/:id/coordinator", async (c) => {
    const { botId } = z
      .object({ botId: z.string().min(1) })
      .parse(await c.req.json());
    return c.json(await service.transferCoordinator(c.req.param("id"), botId));
  });
  routes.get("/tasks/:id/events", async (c) => {
    await service.getTask(c.req.param("id"));
    const after = cursor(c.req.query("after"));
    return c.json({
      events: await service.store.events(c.req.param("id"), after),
    });
  });
  routes.get("/tasks/:id/stream", async (c) => {
    const taskId = c.req.param("id");
    await service.getTask(taskId);
    let after = cursor(c.req.header("Last-Event-ID") ?? c.req.query("after"));
    return streamSSE(c, async (stream) => {
      while (!stream.aborted) {
        const events = await service.store.events(taskId, after);
        for (const event of events) {
          await stream.writeSSE({
            id: String(event.sequence),
            event: event.type,
            data: JSON.stringify(event),
          });
          after = event.sequence;
        }
        const task = await service.getTask(taskId);
        if (
          ["completed", "failed", "cancelled"].includes(task.status) &&
          events.length === 0
        )
          break;
        await stream.sleep(250);
      }
    });
  });
  return routes;
}
function cursor(value?: string) {
  const n = Number(value ?? 0);
  if (!Number.isSafeInteger(n) || n < 0)
    throw new BackendError(
      400,
      "INVALID_CURSOR",
      "Cursor must be a nonnegative integer",
    );
  return n;
}

/** AG-UI is a transport over the same durable tasks, never a second agent scheduler. */
export async function createAgentTask(service: BackendService, input: unknown) {
  const body = z
    .object({
      threadId: z.string().min(1),
      runId: z.string().min(1),
      messages: z.array(
        z.object({ role: z.string(), content: z.unknown() }).passthrough(),
      ),
      forwardedProps: z.record(z.string(), z.unknown()).optional(),
    })
    .parse(input);
  const props = body.forwardedProps ?? {};
  let taskId = typeof props.taskId === "string" ? props.taskId : undefined;
  if (!taskId) {
    const user = body.messages.filter((m) => m.role === "user").at(-1);
    if (!user || typeof user.content !== "string")
      throw new BackendError(
        400,
        "MESSAGE_REQUIRED",
        "A user text message is required",
      );
    const bots = await service.listBots();
    const coordinatorBotId =
      typeof props.botId === "string" ? props.botId : bots[0]?.id;
    if (!coordinatorBotId)
      throw new BackendError(
        400,
        "BOT_REQUIRED",
        "Create a bot before starting agent execution",
      );
    const task = await service.createTask({
      goal: user.content,
      coordinatorBotId,
      participantBotIds: Array.isArray(props.participantBotIds)
        ? z.array(z.string()).parse(props.participantBotIds)
        : [coordinatorBotId],
      verificationPlan: [
        {
          id: "request",
          description:
            "Answer the request accurately using context and explicit evidence.",
          method: "Independent rubric review",
          expectedEvidence: "Result and reviewer evidence",
        },
      ],
    });
    taskId = task.id;
  } else {
    await service.getTask(taskId);
  }
  return {
    taskId,
    threadId: body.threadId,
    runId: body.runId,
    messageId: randomUUID(),
  };
}
