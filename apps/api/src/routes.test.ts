// Every route of the 1.0 table: its happy path, its main refusals, and the
// error envelope, through `app.request` against the real engine.
import type { Engine } from "@jj/backend";
import {
  apiErrorSchema,
  bootstrapSchema,
  botMemorySchema,
  botSchema,
  conversationViewSchema,
  modelsViewSchema,
  runtimeProfileSchema,
  sandboxDriverInfoSchema,
  sendBotMessageResultSchema,
  taskEventPageSchema,
  taskMessageSchema,
  taskSchema,
  taskSummarySchema,
  taskViewSchema,
  z,
} from "@jj/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app";
import {
  createBots,
  OPEN_TIMEOUT,
  quietLogger,
  type TestApp,
  testApp,
  until,
  untilTask,
} from "./testing";

let t: TestApp;
/** A second app whose worker never runs, so tasks stay unfinished. */
let idle: TestApp;
let bots: Record<string, string>;

beforeAll(async () => {
  [t, idle] = await Promise.all([testApp(), testApp({ startWorker: false })]);
  bots = await createBots(t, ["Ada", "Grace", "Linus"]);
}, OPEN_TIMEOUT);
afterAll(async () => {
  await Promise.all([t?.dispose(), idle?.dispose()]);
});

const expectError = (
  result: { status: number; body: unknown },
  status: number,
  code: string,
) => {
  expect(result.status).toBe(status);
  const envelope = apiErrorSchema.parse(result.body);
  expect(envelope.error.code).toBe(code);
  expect(envelope.error.message.length).toBeGreaterThan(0);
  return envelope;
};

describe("error envelope", () => {
  it("answers unknown routes with NOT_FOUND", async () => {
    expectError(await t.call("GET", "/api/nope"), 404, "NOT_FOUND");
    expectError(await t.call("DELETE", "/api/tasks"), 404, "NOT_FOUND");
  });

  it("rejects a body that is not JSON", async () => {
    expectError(
      await t.call("POST", "/api/bots", "{not json"),
      400,
      "VALIDATION_FAILED",
    );
  });

  it("rejects a body over the limit with 413", async () => {
    const big = { name: "x", instructions: "y".repeat(1024 * 1024) };
    expectError(
      await t.call("POST", "/api/bots", big),
      413,
      "VALIDATION_FAILED",
    );
  });

  it("rejects malformed ids and cursors before the engine", async () => {
    expectError(
      await t.call("GET", `/api/bots/${"x".repeat(200)}`),
      400,
      "VALIDATION_FAILED",
    );
    const task = await idle.call("POST", "/api/tasks", {
      goal: "Cursor checks",
      coordinatorBotId: (await createBots(idle, ["Cursor"])).Cursor,
    });
    for (const query of ["after=-1", "after=abc", "limit=0", "limit=501"])
      expectError(
        await idle.call(
          "GET",
          `/api/tasks/${task.body.task.id}/events?${query}`,
        ),
        400,
        "VALIDATION_FAILED",
      );
  });

  it("answers an unexpected failure with INTERNAL and keeps the stack in the log", async () => {
    const broken = {
      ...t.engine,
      bots: {
        ...t.engine.bots,
        list: async () => {
          throw new Error("secret detail at /srv/internal.ts:12");
        },
      },
    } as Engine;
    const app = createApp({
      engine: broken,
      config: { workerEmbedded: false },
      logger: quietLogger,
    });
    quietLogger.lines.length = 0;
    const response = await app.request("/api/bots");
    expect(response.status).toBe(500);
    const text = await response.text();
    expect(apiErrorSchema.parse(JSON.parse(text)).error.code).toBe("INTERNAL");
    expect(text).not.toContain("secret detail");
    expect(text).not.toContain("internal.ts");
    const logged = quietLogger.lines.find((line) => line.level === "error");
    expect(JSON.stringify(logged)).toContain("secret detail");
  });
});

describe("bootstrap, models and drivers", () => {
  it("GET /api/bootstrap reports the backend and its real capabilities", async () => {
    const { status, body } = await t.call("GET", "/api/bootstrap");
    expect(status).toBe(200);
    const bootstrap = bootstrapSchema.parse(body);
    expect(bootstrap).toMatchObject({
      mode: "backend",
      contractVersion: "1.0.2",
      defaultModel: "scripted/team",
      capabilities: {
        agentExecution: true,
        persistence: false,
        streaming: true,
        verification: false,
        drivers: [{ id: "local", available: true, isolated: false }],
      },
    });
    expect(bootstrap.profiles.length).toBeGreaterThan(0);
  });

  it("GET /api/models lists providers with the scripted model configured", async () => {
    const { status, body } = await t.call("GET", "/api/models");
    expect(status).toBe(200);
    const view = modelsViewSchema.parse(body);
    expect(view.defaultModel).toBe("scripted/team");
    expect(
      view.providers.find((provider) => provider.id === "scripted")?.configured,
    ).toBe(true);
    expect(
      view.providers.find((provider) => provider.id === "openai")?.configured,
    ).toBe(false);
  });

  it("GET /api/sandbox-drivers lists the local driver with its spec schema", async () => {
    const { status, body } = await t.call("GET", "/api/sandbox-drivers");
    expect(status).toBe(200);
    const { drivers } = z
      .object({ drivers: z.array(sandboxDriverInfoSchema) })
      .parse(body);
    expect(drivers.map((driver) => driver.id)).toEqual(["local"]);
    expect(drivers[0]?.capabilities.filesystemIsolation).toBe(false);
    expect(drivers[0]?.specJsonSchema).toHaveProperty("properties");
  });
});

describe("bots", () => {
  it("creates, lists, reads, updates and archives a bot", async () => {
    const created = await t.call("POST", "/api/bots", {
      name: "Hopper",
      role: "Reviewer",
    });
    expect(created.status).toBe(201);
    const bot = z.object({ bot: botSchema }).parse(created.body).bot;
    expect(bot).toMatchObject({ name: "Hopper", role: "Reviewer" });

    const list = await t.call("GET", "/api/bots");
    expect(list.status).toBe(200);
    expect(
      z
        .object({ bots: z.array(botSchema) })
        .parse(list.body)
        .bots.map((entry) => entry.name),
    ).toContain("Hopper");

    const got = await t.call("GET", `/api/bots/${bot.id}`);
    expect(got.status).toBe(200);
    expect(got.body.bot.id).toBe(bot.id);

    const patched = await t.call("PATCH", `/api/bots/${bot.id}`, {
      instructions: "Review carefully.",
    });
    expect(patched.status).toBe(200);
    expect(botSchema.parse(patched.body.bot).instructions).toBe(
      "Review carefully.",
    );

    const archived = await t.call("DELETE", `/api/bots/${bot.id}`);
    expect(archived.status).toBe(204);
    expect(archived.body).toBeNull();
    expectError(await t.call("GET", `/api/bots/${bot.id}`), 404, "NOT_FOUND");
  });

  it("refuses invalid, duplicate, unknown and empty-patch bots", async () => {
    expectError(
      await t.call("POST", "/api/bots", {}),
      400,
      "VALIDATION_FAILED",
    );
    expectError(
      await t.call("POST", "/api/bots", { name: "Ada" }),
      409,
      "CONFLICT",
    );
    expectError(await t.call("GET", "/api/bots/bot_missing"), 404, "NOT_FOUND");
    expectError(
      await t.call("PATCH", `/api/bots/${bots.Ada}`, {}),
      400,
      "VALIDATION_FAILED",
    );
    expectError(
      await t.call("PATCH", "/api/bots/bot_missing", { role: "x" }),
      404,
      "NOT_FOUND",
    );
  });

  it("refuses to archive a bot with unfinished tasks", async () => {
    const { Busy } = await createBots(idle, ["Busy"]);
    const task = await idle.call("POST", "/api/tasks", {
      goal: "Stay queued",
      coordinatorBotId: Busy,
    });
    expect(task.status).toBe(201);
    const refused = expectError(
      await idle.call("DELETE", `/api/bots/${Busy}`),
      409,
      "CONFLICT",
    );
    expect(refused.error.details).toMatchObject({
      activeTaskIds: [task.body.task.id],
    });
  });

  it("reads and replaces a bot's memory", async () => {
    const read = await t.call("GET", `/api/bots/${bots.Grace}/memory`);
    expect(read.status).toBe(200);
    expect(botMemorySchema.parse(read.body).text).toBe("");
    const written = await t.call("PUT", `/api/bots/${bots.Grace}/memory`, {
      text: "Prefers short notes.",
    });
    expect(written.status).toBe(200);
    expect(botMemorySchema.parse(written.body).text).toBe(
      "Prefers short notes.",
    );
    expectError(
      await t.call("PUT", `/api/bots/${bots.Grace}/memory`, { text: 5 }),
      400,
      "VALIDATION_FAILED",
    );
    expectError(
      await t.call("GET", "/api/bots/bot_missing/memory"),
      404,
      "NOT_FOUND",
    );
  });

  it("stores a direct message and the bot replies asynchronously", async () => {
    const sent = await t.call("POST", `/api/bots/${bots.Linus}/messages`, {
      text: "Hello!",
    });
    expect(sent.status).toBe(201);
    expect(sendBotMessageResultSchema.parse(sent.body).message).toMatchObject({
      role: "user",
      text: "Hello!",
    });
    const view = await until(
      async () => {
        const { body } = await t.call(
          "GET",
          `/api/bots/${bots.Linus}/messages`,
        );
        const parsed = conversationViewSchema.parse(body);
        return parsed.messages.some((message) => message.role === "assistant")
          ? parsed
          : undefined;
      },
      { what: "the reply" },
    );
    expect(view.replying).toBe(false);
    expect(view.messages.at(-1)?.text).toContain("Hello");
    expectError(
      await t.call("POST", `/api/bots/${bots.Linus}/messages`, { text: "" }),
      400,
      "VALIDATION_FAILED",
    );
    expectError(
      await t.call("GET", "/api/bots/bot_missing/messages"),
      404,
      "NOT_FOUND",
    );
  });
});

describe("runtime profiles", () => {
  const spec = { driver: "local", network: { mode: "open" } };

  it("creates, lists, reads, updates and deletes a profile", async () => {
    const created = await t.call("POST", "/api/runtime-profiles", {
      name: "Quick local",
      sandbox: spec,
    });
    expect(created.status).toBe(201);
    const profile = runtimeProfileSchema.parse(created.body.profile);
    expect(profile.status).toMatchObject({
      driverAvailable: true,
      isolated: false,
    });

    const list = await t.call("GET", "/api/runtime-profiles");
    expect(list.status).toBe(200);
    expect(
      z
        .object({ profiles: z.array(runtimeProfileSchema) })
        .parse(list.body)
        .profiles.map((entry) => entry.id),
    ).toContain(profile.id);

    const got = await t.call("GET", `/api/runtime-profiles/${profile.id}`);
    expect(got.status).toBe(200);
    expect(got.body.profile.name).toBe("Quick local");

    const patched = await t.call(
      "PATCH",
      `/api/runtime-profiles/${profile.id}`,
      { name: "Quicker local" },
    );
    expect(patched.status).toBe(200);
    expect(patched.body.profile.name).toBe("Quicker local");

    const deleted = await t.call(
      "DELETE",
      `/api/runtime-profiles/${profile.id}`,
    );
    expect(deleted.status).toBe(204);
    expectError(
      await t.call("GET", `/api/runtime-profiles/${profile.id}`),
      404,
      "NOT_FOUND",
    );
  });

  it("refuses isolation the driver cannot enforce, and unknown drivers", async () => {
    const unenforceable = expectError(
      await t.call("POST", "/api/runtime-profiles", {
        name: "No network",
        sandbox: { driver: "local", network: { mode: "none" } },
      }),
      422,
      "PROFILE_UNSUPPORTED",
    );
    expect(unenforceable.error.message).toMatch(/local/i);
    expectError(
      await t.call("POST", "/api/runtime-profiles", {
        name: "Elsewhere",
        sandbox: { driver: "daytona", network: { mode: "open" } },
      }),
      422,
      "PROFILE_UNSUPPORTED",
    );
    expectError(
      await t.call("POST", "/api/runtime-profiles", { name: "No spec" }),
      400,
      "VALIDATION_FAILED",
    );
  });

  it("refuses a malformed allowlist host as a field error", async () => {
    const refused = expectError(
      await t.call("POST", "/api/runtime-profiles", {
        name: "Registry only",
        sandbox: {
          driver: "docker",
          network: {
            mode: "allowlist",
            hosts: ["registry.npmjs.org", "https://pypi.org/simple"],
          },
        },
      }),
      400,
      "VALIDATION_FAILED",
    );
    expect(refused.error.message).toMatch(
      /^sandbox\.network\.hosts\.1: Use a host such as registry\.npmjs\.org/,
    );
    expect(refused.error.details).toEqual([
      expect.objectContaining({ path: ["sandbox", "network", "hosts", 1] }),
    ]);
  });

  it("refuses to delete a profile a bot uses", async () => {
    const { body } = await t.call("POST", "/api/runtime-profiles", {
      name: "In use",
      sandbox: spec,
    });
    const profileId = body.profile.id;
    const bot = await t.call("POST", "/api/bots", {
      name: "Profiled",
      runtimeProfileId: profileId,
    });
    expect(bot.status).toBe(201);
    expectError(
      await t.call("DELETE", `/api/runtime-profiles/${profileId}`),
      409,
      "PROFILE_IN_USE",
    );
  });
});

describe("tasks", () => {
  it("creates a task, lists it, reads its view and pages its events", async () => {
    const created = await t.call("POST", "/api/tasks", {
      goal: "Summarise the notes",
      coordinatorBotId: bots.Ada,
    });
    expect(created.status).toBe(201);
    const task = taskSchema.parse(created.body.task);
    expect(task.participantBotIds).toEqual([bots.Ada]);

    const list = await t.call("GET", "/api/tasks");
    expect(list.status).toBe(200);
    expect(
      z
        .object({ tasks: z.array(taskSummarySchema) })
        .parse(list.body)
        .tasks.map((entry) => entry.id),
    ).toContain(task.id);

    const view = await untilTask(
      t,
      task.id,
      (current) => current.task.status === "completed",
    );
    expect(taskViewSchema.parse(view).cursor).toBeGreaterThan(0);

    const page = await t.call(
      "GET",
      `/api/tasks/${task.id}/events?after=0&limit=3`,
    );
    expect(page.status).toBe(200);
    const parsed = taskEventPageSchema.parse(page.body);
    expect(parsed.events.map((event) => event.sequence)).toEqual([1, 2, 3]);
    expect(parsed).toMatchObject({ cursor: 3, hasMore: true });
    const rest = await t.call("GET", `/api/tasks/${task.id}/events?after=3`);
    expect(rest.body.events[0].sequence).toBe(4);
    expect(rest.body.cursor).toBe(view.cursor);
    expect(rest.body.hasMore).toBe(false);
  });

  it("refuses invalid tasks and unknown ids", async () => {
    expectError(
      await t.call("POST", "/api/tasks", { coordinatorBotId: bots.Ada }),
      400,
      "VALIDATION_FAILED",
    );
    expectError(
      await t.call("POST", "/api/tasks", {
        goal: "Ghosts",
        coordinatorBotId: "bot_missing",
      }),
      400,
      "VALIDATION_FAILED",
    );
    expectError(
      await t.call("POST", "/api/tasks", {
        goal: "Checked",
        coordinatorBotId: bots.Ada,
        verificationPlan: [
          {
            id: "c1",
            description: "It works",
            method: "Run it",
            expectedEvidence: "Output",
          },
        ],
      }),
      422,
      "VERIFICATION_UNAVAILABLE",
    );
    expectError(
      await t.call("GET", "/api/tasks/task_missing"),
      404,
      "NOT_FOUND",
    );
    expectError(
      await t.call("GET", "/api/tasks/task_missing/events"),
      404,
      "NOT_FOUND",
    );
    expectError(
      await t.call("POST", "/api/tasks/task_missing/messages", { text: "Hi" }),
      404,
      "NOT_FOUND",
    );
    expectError(
      await t.call("POST", "/api/tasks/task_missing/stop", {}),
      404,
      "NOT_FOUND",
    );
  });

  it("refuses a bot model whose provider is not configured", async () => {
    const refused = expectError(
      await t.call("POST", "/api/bots", {
        name: "Unkeyed",
        model: "openai/gpt-5-mini",
      }),
      422,
      "MODEL_NOT_CONFIGURED",
    );
    expect(refused.error.message).toContain("OPENAI_API_KEY");
    expectError(
      await t.call("PATCH", `/api/bots/${bots.Ada}`, {
        model: "openai/gpt-5-mini",
      }),
      422,
      "MODEL_NOT_CONFIGURED",
    );
  });

  it("posts steering, rejects a stale goal edit, and continues a finished task", async () => {
    const { body } = await t.call("POST", "/api/tasks", {
      goal: "First goal",
      coordinatorBotId: bots.Grace,
    });
    const taskId = body.task.id;
    await untilTask(t, taskId, (view) => view.task.status === "completed");

    const posted = await t.call("POST", `/api/tasks/${taskId}/messages`, {
      text: "Also add a summary line.",
    });
    expect(posted.status).toBe(201);
    expect(taskMessageSchema.parse(posted.body.message)).toMatchObject({
      authorKind: "user",
      text: "Also add a summary line.",
    });
    const edited = await t.call("POST", `/api/tasks/${taskId}/messages`, {
      text: "New goal",
      goal: "Second goal",
      observedGoalVersion: 1,
    });
    expect(edited.status).toBe(201);
    const stale = expectError(
      await t.call("POST", `/api/tasks/${taskId}/messages`, {
        text: "Another goal",
        goal: "Third goal",
        observedGoalVersion: 1,
      }),
      409,
      "STALE_GOAL_VERSION",
    );
    expect(stale.error.details).toMatchObject({ goalVersion: 2 });
    expectError(
      await t.call("POST", `/api/tasks/${taskId}/messages`, {
        text: "New goal",
        goal: "Second goal",
      }),
      400,
      "VALIDATION_FAILED",
    );
    const reopened = await untilTask(
      t,
      taskId,
      (view) =>
        view.task.status === "completed" &&
        view.task.goalVersion === 2 &&
        view.events.some((event) => event.type === "task.reopened"),
      "the continued task to complete",
    );
    expect(reopened.task.goal).toBe("Second goal");
    expectError(
      await t.call("POST", `/api/tasks/${taskId}/stop`, {}),
      409,
      "CONFLICT",
    );
  });

  it("stops a task, and then refuses new messages", async () => {
    const { Stopper } = await createBots(idle, ["Stopper"]);
    const { body } = await idle.call("POST", "/api/tasks", {
      goal: "Never runs",
      coordinatorBotId: Stopper,
    });
    const taskId = body.task.id;
    const stopped = await idle.call("POST", `/api/tasks/${taskId}/stop`, {
      reason: "Changed my mind",
    });
    expect(stopped.status).toBe(200);
    const task = taskSchema.parse(stopped.body.task);
    expect(task.cancelRequestedAt).not.toBeNull();
    const view = await untilTask(
      idle,
      taskId,
      (current) => current.task.status === "cancelled",
    );
    expect(view.task.cancelReason).toBe("Changed my mind");
    expect(
      view.events.find((event) => event.type === "cancellation.completed"),
    ).toBeDefined();
    // An empty JSON-typed body stops too, and stopping twice is idempotent.
    const again = await idle.app.request(`/api/tasks/${taskId}/stop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    expect(again.status).toBe(200);
    expectError(
      await idle.call("POST", `/api/tasks/${taskId}/messages`, { text: "Hi" }),
      409,
      "TASK_TERMINAL",
    );
  });
});

describe("artifacts", () => {
  it("downloads an artifact as an attachment with its content type", async () => {
    const { body } = await t.call("POST", "/api/tasks", {
      goal: "Write notes",
      coordinatorBotId: bots.Linus,
      participantBotIds: [bots.Grace],
    });
    const view = await untilTask(
      t,
      body.task.id,
      (current) =>
        current.task.status === "completed" && current.artifacts.length > 0,
    );
    const artifact = view.artifacts.find((entry) => entry.kind === "file");
    expect(artifact?.name).toBe("notes-grace.md");
    const response = await t.app.request(
      `/api/tasks/${body.task.id}/artifacts/${artifact?.id}/content`,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(response.headers.get("Content-Disposition")).toBe(
      `attachment; filename="notes-grace.md"; filename*=UTF-8''notes-grace.md`,
    );
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "sandbox",
    );
    const text = await response.text();
    expect(text).toContain("# Notes");
    expect(Number(response.headers.get("Content-Length"))).toBe(
      artifact?.sizeBytes,
    );

    expectError(
      await t.call(
        "GET",
        `/api/tasks/${body.task.id}/artifacts/artifact_missing/content`,
      ),
      404,
      "NOT_FOUND",
    );
  });
});
