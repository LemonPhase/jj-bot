// The web app's live client (apps/web/src/api/liveApi.ts), run in Node against
// the real server on an ephemeral port. With a token the client streams over
// its fetch transport, so this covers requests, error envelopes, both streams
// and downloads exactly as the browser uses them: the client/server contract.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskView, WorkspaceHint } from "@jj/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ApiError, type JJApi } from "../../web/src/api/client";
import {
  createLiveApi,
  liveBadge,
  probeBackend,
} from "../../web/src/api/liveApi";
import { type RunningServer, startServer } from "./server";
import { OPEN_TIMEOUT, quietLogger, until } from "./testing";

const TOKEN = "web-client-contract-token";
let server: RunningServer;
let root: string;
let api: JJApi;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "jj-web-client-"));
  server = await startServer({
    logger: quietLogger,
    env: {
      API_PORT: "0",
      API_TOKEN: TOKEN,
      JJ_DATABASE_PATH: "memory://",
      JJ_SANDBOX_DRIVERS: "local",
      JJ_SANDBOX_ROOT: root,
      JJ_ENABLE_SCRIPTED_MODEL: "true",
    },
  });
  const probe = await probeBackend({ baseUrl: server.url, token: TOKEN });
  if (!probe.ok) throw new Error(`probe failed: ${probe.reason}`);
  api = createLiveApi({
    baseUrl: server.url,
    token: TOKEN,
    bootstrap: probe.bootstrap,
    models: probe.models,
    retryMs: 100,
  });
}, OPEN_TIMEOUT);
afterAll(async () => {
  await server?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error as ApiError,
  );

describe("liveApi against the real server", () => {
  it("probes the backend and labels the scripted model", async () => {
    const probe = await probeBackend({ baseUrl: server.url, token: TOKEN });
    expect(probe.ok).toBe(true);
    if (!probe.ok) return;
    expect(probe.bootstrap.mode).toBe("backend");
    expect(liveBadge(probe.bootstrap, probe.models).label).toBe(
      "Scripted model",
    );
    expect(api.mode).toBe("live");
    expect(api.capabilities.agentExecution).toBe(true);
  });

  it("asks for the token when it is missing", async () => {
    const probe = await probeBackend({ baseUrl: server.url });
    expect(probe).toMatchObject({ ok: false });
    if (!probe.ok) expect(probe.reason).toContain("requires a token");
  });

  it("round-trips bots, memory, profiles, drivers and models", async () => {
    const ada = await api.createBot({ name: "Ada", role: "Lead" });
    expect(ada.name).toBe("Ada");
    expect((await api.getBot(ada.id)).role).toBe("Lead");
    expect((await api.updateBot(ada.id, { role: "Coordinator" })).role).toBe(
      "Coordinator",
    );
    expect((await api.listBots()).map((bot) => bot.id)).toContain(ada.id);
    expect(
      (await api.putMemory(ada.id, { text: "Likes penguins." })).text,
    ).toBe("Likes penguins.");
    expect((await api.getMemory(ada.id)).text).toBe("Likes penguins.");

    const drivers = await api.listDrivers();
    expect(drivers.map((driver) => driver.id)).toEqual(["local"]);
    expect((await api.getModels()).defaultModel).toBe("scripted/team");
    const profile = await api.createProfile({
      name: "Client profile",
      sandbox: { driver: "local", network: { mode: "open" } },
    });
    expect((await api.getProfile(profile.id)).name).toBe("Client profile");
    expect(
      (await api.updateProfile(profile.id, { description: "From the client" }))
        .description,
    ).toBe("From the client");
    expect((await api.listProfiles()).map((entry) => entry.id)).toContain(
      profile.id,
    );
    await api.deleteProfile(profile.id);

    const temp = await api.createBot({ name: "Temp" });
    await api.archiveBot(temp.id);
    const missing = await rejection(api.getBot(temp.id));
    expect(missing).toBeInstanceOf(ApiError);
    expect(missing).toMatchObject({ code: "NOT_FOUND", status: 404 });
    const conflict = await rejection(api.createBot({ name: "Ada" }));
    expect(conflict).toMatchObject({ code: "CONFLICT", status: 409 });
  });

  it("follows a conversation and the workspace hints", async () => {
    const linus = await api.createBot({ name: "Linus" });
    const hints: WorkspaceHint[] = [];
    const states: string[] = [];
    const offHints = api.subscribeHints((hint) => hints.push(hint), {
      onState: (state) => states.push(state),
    });
    await until(() => states.includes("open"), { what: "the hint stream" });
    const views: { assistant: number }[] = [];
    const offConversation = api.subscribeConversation(linus.id, (view) =>
      views.push({
        assistant: view.messages.filter((m) => m.role === "assistant").length,
      }),
    );
    const sent = await api.sendBotMessage(linus.id, { text: "Hello there" });
    expect(sent).toMatchObject({ role: "user", text: "Hello there" });
    await until(() => views.some((view) => view.assistant > 0), {
      what: "the reply through conversation.changed",
    });
    offConversation();
    offHints();
    expect(
      hints.some(
        (hint) =>
          hint.type === "conversation.changed" && hint.botId === linus.id,
      ),
    ).toBe(true);
  });

  it("creates a three-bot task, follows it live to completion and downloads its artifacts", async () => {
    const [grace, hopper] = [
      await api.createBot({ name: "Grace" }),
      await api.createBot({ name: "Hopper" }),
    ];
    const ada = (await api.listBots()).find((bot) => bot.name === "Ada");
    if (!ada) throw new Error("Ada is missing");
    const task = await api.createTask({
      goal: "Write a penguin report",
      coordinatorBotId: ada.id,
      participantBotIds: [grace.id, hopper.id],
    });
    let latest: TaskView | undefined;
    const states: string[] = [];
    const off = api.subscribeTask(
      task.id,
      (view) => {
        latest = view;
      },
      { onState: (state) => states.push(state) },
    );
    const done = await until(
      () => (latest?.task.status === "completed" ? latest : undefined),
      { what: "the task to complete over the stream" },
    );
    off();
    expect(states).toContain("open");
    const fresh = await api.getTask(task.id);
    expect(done.task).toEqual(fresh.task);
    expect(done.sessions).toEqual(fresh.sessions);
    expect(done.artifacts).toEqual(fresh.artifacts);
    expect(done.cursor).toBe(fresh.cursor);

    expect(done.artifacts.length).toBeGreaterThanOrEqual(2);
    for (const artifact of done.artifacts) {
      const response = await fetch(api.artifactUrl(task.id, artifact.id), {
        headers: { Authorization: `Bearer ${TOKEN}` },
      });
      expect(response.status).toBe(200);
      expect((await response.arrayBuffer()).byteLength).toBe(
        artifact.sizeBytes,
      );
    }
    expect((await api.listTasks()).map((entry) => entry.id)).toContain(task.id);

    const message = await api.postTaskMessage(task.id, {
      text: "Thanks, one more detail please.",
    });
    expect(message.authorKind).toBe("user");
  });

  it("stops a task and reports refusals with the server's envelope", async () => {
    const ada = (await api.listBots()).find((bot) => bot.name === "Ada");
    if (!ada) throw new Error("Ada is missing");
    const task = await api.createTask({
      goal: "Something to stop",
      coordinatorBotId: ada.id,
    });
    const stopping = await api.stopTask(task.id, { reason: "Not needed" });
    expect(stopping.cancelRequestedAt === null).toBe(false);
    await until(
      async () => (await api.getTask(task.id)).task.status === "cancelled",
      { what: "the task to be cancelled" },
    );
    const terminal = await rejection(
      api.postTaskMessage(task.id, { text: "Hello?" }),
    );
    expect(terminal).toMatchObject({ code: "TASK_TERMINAL", status: 409 });
    const unknown = await rejection(api.getTask("task_missing"));
    expect(unknown).toMatchObject({ code: "NOT_FOUND", status: 404 });
  });
});

describe("startServer", () => {
  it("shuts down gracefully with streams still open", async () => {
    const extraRoot = await mkdtemp(join(tmpdir(), "jj-web-client-close-"));
    const other = await startServer({
      logger: quietLogger,
      env: {
        API_PORT: "0",
        JJ_DATABASE_PATH: "memory://",
        JJ_SANDBOX_DRIVERS: "local",
        JJ_SANDBOX_ROOT: extraRoot,
        JJ_ENABLE_SCRIPTED_MODEL: "true",
      },
    });
    try {
      const response = await fetch(`${other.url}/api/stream`);
      expect(response.status).toBe(200);
      const reader = response.body?.getReader();
      await reader?.read();
      const started = Date.now();
      await other.close();
      expect(Date.now() - started).toBeLessThan(2_000);
      // The stream ended instead of hanging the shutdown.
      for (;;) {
        const chunk = await reader?.read().catch(() => ({ done: true }));
        if (!chunk || chunk.done) break;
      }
      await expect(fetch(`${other.url}/health`)).rejects.toThrow();
    } finally {
      await other.close();
      await rm(extraRoot, { recursive: true, force: true });
    }
  });
});
