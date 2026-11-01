// The 1.0 route table (docs/contract-changelog.md), one engine method per
// route. Bodies go to the engine unparsed; it validates each command.
import type { Engine, Logger } from "@jj/backend";
import { type Context, Hono } from "hono";
import {
  attachmentDisposition,
  idParam,
  jsonBody,
  pageQuery,
  resumeCursor,
} from "./http";
import { eventStream, STREAM_CLOSED, type StreamRegistry } from "./sse";

/** The body as the engine's command type: not validated here; the engine parses it. */
const command = async <Command>(c: Context) => (await jsonBody(c)) as Command;

export interface RouteOptions {
  engine: Engine;
  streams: StreamRegistry;
  heartbeatMs: number;
  logger: Logger;
}

export function apiRoutes({
  engine,
  streams,
  heartbeatMs,
  logger,
}: RouteOptions) {
  const api = new Hono();
  const stream = { registry: streams, heartbeatMs, logger };

  api.get("/bootstrap", async (c) => c.json(await engine.bootstrap()));

  api.get("/stream", (c) =>
    eventStream(c, {
      ...stream,
      label: "The workspace stream",
      async start(write) {
        // Hints arrive synchronously; write them one at a time, in order.
        let queue = Promise.resolve();
        const unsubscribe = await engine.subscribeHints((hint) => {
          queue = queue
            .then(() => write({ event: hint.type, data: JSON.stringify(hint) }))
            .catch(() => {});
        });
        return async () => {
          await unsubscribe();
          await queue;
        };
      },
    }),
  );

  // Bots
  api.get("/bots", async (c) => c.json(await engine.bots.list()));
  api.post("/bots", async (c) =>
    c.json(await engine.bots.create(await command(c)), 201),
  );
  api.get("/bots/:id", async (c) =>
    c.json(await engine.bots.get(idParam(c, "id"))),
  );
  api.patch("/bots/:id", async (c) =>
    c.json(await engine.bots.update(idParam(c, "id"), await command(c))),
  );
  api.delete("/bots/:id", async (c) => {
    await engine.bots.archive(idParam(c, "id"));
    return c.body(null, 204);
  });
  api.get("/bots/:id/memory", async (c) =>
    c.json(await engine.bots.getMemory(idParam(c, "id"))),
  );
  api.put("/bots/:id/memory", async (c) =>
    c.json(await engine.bots.putMemory(idParam(c, "id"), await command(c))),
  );
  api.get("/bots/:id/messages", async (c) =>
    c.json(await engine.bots.conversation(idParam(c, "id"))),
  );
  api.post("/bots/:id/messages", async (c) =>
    c.json(
      await engine.bots.sendMessage(idParam(c, "id"), await command(c)),
      201,
    ),
  );

  // Runtime profiles, drivers and models
  api.get("/runtime-profiles", async (c) =>
    c.json(await engine.profiles.list()),
  );
  api.post("/runtime-profiles", async (c) =>
    c.json(await engine.profiles.create(await command(c)), 201),
  );
  api.get("/runtime-profiles/:id", async (c) =>
    c.json(await engine.profiles.get(idParam(c, "id"))),
  );
  api.patch("/runtime-profiles/:id", async (c) =>
    c.json(await engine.profiles.update(idParam(c, "id"), await command(c))),
  );
  api.delete("/runtime-profiles/:id", async (c) => {
    await engine.profiles.delete(idParam(c, "id"));
    return c.body(null, 204);
  });
  api.get("/sandbox-drivers", async (c) => c.json(await engine.drivers()));
  api.get("/models", (c) => c.json(engine.models()));

  // Tasks
  api.get("/tasks", async (c) => c.json(await engine.tasks.list()));
  api.post("/tasks", async (c) =>
    c.json(await engine.tasks.create(await command(c)), 201),
  );
  api.get("/tasks/:id", async (c) =>
    c.json(await engine.tasks.get(idParam(c, "id"))),
  );
  api.post("/tasks/:id/messages", async (c) =>
    c.json(
      await engine.tasks.postMessage(idParam(c, "id"), await command(c)),
      201,
    ),
  );
  api.post("/tasks/:id/stop", async (c) =>
    c.json(await engine.tasks.stop(idParam(c, "id"), (await command(c)) ?? {})),
  );
  api.get("/tasks/:id/events", async (c) =>
    c.json(await engine.tasks.events(idParam(c, "id"), pageQuery(c))),
  );
  api.get("/tasks/:id/stream", async (c) => {
    const taskId = idParam(c, "id");
    const after = resumeCursor(c);
    // Answers 404 before the stream opens when the task does not exist.
    await engine.tasks.events(taskId, { after, limit: 1 });
    return eventStream(c, {
      ...stream,
      label: `The stream of task ${taskId}`,
      async start(write) {
        const subscription = await engine.tasks.subscribe(taskId, {
          after,
          onEvent: (event) =>
            write({
              id: String(event.sequence),
              event: event.type,
              data: JSON.stringify(event),
            }),
          onError: (error) => {
            if (error !== STREAM_CLOSED)
              logger.warn(`The stream of task ${taskId} failed a read`, {
                error: error instanceof Error ? error.message : String(error),
              });
          },
        });
        return () => subscription.close();
      },
    });
  });
  api.get("/tasks/:id/artifacts/:artifactId/content", async (c) => {
    const { artifact, content } = await engine.tasks.artifactContent(
      idParam(c, "id"),
      idParam(c, "artifactId"),
    );
    return c.body(new Uint8Array(content), 200, {
      "Content-Type": artifact.contentType,
      "Content-Length": String(content.byteLength),
      "Content-Disposition": attachmentDisposition(artifact.name),
      // Agent-written files never run as this origin's pages or scripts.
      "Content-Security-Policy": "sandbox; default-src 'none'",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-cache",
      ETag: `"${artifact.sha256}"`,
    });
  });

  return api;
}
