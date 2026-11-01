// Both event streams: SSE framing, resuming from Last-Event-ID or ?after=
// without duplicates, the heartbeat, closing the engine subscription on
// disconnect, and workspace hints.
import { apiErrorSchema, parseTaskEvent } from "@jj/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createBots,
  OPEN_TIMEOUT,
  SseReader,
  type TestApp,
  testApp,
  until,
  untilTask,
} from "./testing";

let t: TestApp;
let bots: Record<string, string>;

beforeAll(async () => {
  t = await testApp({ app: { heartbeatMs: 100 } });
  bots = await createBots(t, ["Ada", "Grace", "Linus"]);
}, OPEN_TIMEOUT);
afterAll(async () => {
  await t?.dispose();
});

const open = (path: string, headers: Record<string, string> = {}) =>
  t.app.request(path, { headers: { Accept: "text/event-stream", ...headers } });

async function finishedTask(goal: string) {
  const { body } = await t.call("POST", "/api/tasks", {
    goal,
    coordinatorBotId: bots.Ada,
    participantBotIds: [bots.Grace, bots.Linus],
  });
  return untilTask(t, body.task.id, (view) => view.task.status === "completed");
}

describe("task stream", () => {
  it("frames each event with id = sequence, event = type and data = the event", async () => {
    const view = await finishedTask("Framing check");
    const response = await open(`/api/tasks/${view.task.id}/stream`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(response.headers.get("Cache-Control")).toBe("no-cache");
    expect(response.headers.get("X-Accel-Buffering")).toBe("no");
    const reader = new SseReader(response);
    await reader.until((r) => r.frames.length >= view.cursor);
    await reader.close();

    expect(reader.frames.map((frame) => Number(frame.id))).toEqual(
      Array.from({ length: view.cursor }, (_, index) => index + 1),
    );
    for (const frame of reader.frames) {
      const event = parseTaskEvent(JSON.parse(frame.data));
      expect(frame.event).toBe(event.type);
      expect(String(event.sequence)).toBe(frame.id);
      expect(event.taskId).toBe(view.task.id);
    }
    // One field per line, a blank line after each frame.
    expect(reader.raw).toMatch(
      /event: task\.created\ndata: \{[^\n]*\}\nid: 1\n\n/,
    );
  });

  it("resumes after Last-Event-ID, which wins over ?after=", async () => {
    const view = await finishedTask("Resume check");
    const id = view.task.id;
    const fromHeader = new SseReader(
      await open(`/api/tasks/${id}/stream?after=2`, { "Last-Event-ID": "5" }),
    );
    await fromHeader.until((r) => r.frames.length >= view.cursor - 5);
    await fromHeader.close();
    expect(fromHeader.frames[0]?.id).toBe("6");

    const fromQuery = new SseReader(
      await open(`/api/tasks/${id}/stream?after=7`),
    );
    await fromQuery.until((r) => r.frames.length >= view.cursor - 7);
    await fromQuery.close();
    expect(fromQuery.frames[0]?.id).toBe("8");
    expect(fromQuery.frames.at(-1)?.id).toBe(String(view.cursor));
  });

  it("replays a reconnect mid-task from the cursor with no duplicates or gaps", async () => {
    const { body } = await t.call("POST", "/api/tasks", {
      goal: "Reconnect check",
      coordinatorBotId: bots.Ada,
      participantBotIds: [bots.Grace, bots.Linus],
    });
    const id = body.task.id;
    const first = new SseReader(await open(`/api/tasks/${id}/stream`));
    await first.until((r) => r.frames.length >= 3, { what: "three events" });
    await first.close();
    const seen = first.events();
    const last = seen.at(-1)?.sequence ?? 0;

    const second = new SseReader(
      await open(`/api/tasks/${id}/stream`, { "Last-Event-ID": String(last) }),
    );
    await second.until(
      (r) => r.events().some((event) => event.type === "task.finished"),
      { what: "the task to finish" },
    );
    await second.close();
    const sequences = [...seen, ...second.events()].map(
      (event) => event.sequence,
    );
    expect(sequences).toEqual(
      Array.from({ length: sequences.length }, (_, index) => index + 1),
    );
    // The two connections together are exactly the durable log, and the
    // reconnect re-ran nothing: every run is a start or a wake, none a recovery.
    const streamed = [...seen, ...second.events()];
    const log = await t.call("GET", `/api/tasks/${id}/events?after=0`);
    const logged = (log.body.events as { id: string }[]).slice(
      0,
      streamed.length,
    );
    expect(streamed.map((event) => event.id)).toEqual(
      logged.map((event) => event.id),
    );
    const reasons = streamed
      .filter((event) => event.type === "run.started")
      .map((event) => (event.payload as { reason: string }).reason);
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons).not.toContain("recovery");
  });

  it("sends a comment heartbeat while idle", async () => {
    const view = await finishedTask("Heartbeat check");
    const reader = new SseReader(
      await open(`/api/tasks/${view.task.id}/stream`, {
        "Last-Event-ID": String(view.cursor),
      }),
    );
    await reader.until((r) => r.comments.includes("heartbeat"), {
      what: "a heartbeat",
    });
    await reader.close();
    expect(reader.frames).toEqual([]);
    expect(reader.raw).toContain(": heartbeat\n\n");
  });

  it("closes the engine subscription when the client disconnects", async () => {
    const view = await finishedTask("Disconnect check");
    const before = t.app.openStreams;
    const reader = new SseReader(
      await open(`/api/tasks/${view.task.id}/stream`),
    );
    await reader.until((r) => r.frames.length > 0);
    expect(t.app.openStreams).toBe(before + 1);
    await reader.close();
    await until(() => t.app.openStreams === before, {
      what: "the stream to close",
    });
  });

  it("answers an unknown task or a bad cursor before opening a stream", async () => {
    const missing = await open("/api/tasks/task_missing/stream");
    expect(missing.status).toBe(404);
    expect(apiErrorSchema.parse(await missing.json()).error.code).toBe(
      "NOT_FOUND",
    );
    const view = await finishedTask("Bad cursor check");
    const bad = await open(`/api/tasks/${view.task.id}/stream`, {
      "Last-Event-ID": "not-a-number",
    });
    expect(bad.status).toBe(400);
    expect(apiErrorSchema.parse(await bad.json()).error.code).toBe(
      "VALIDATION_FAILED",
    );
  });

  it("ends open streams on shutdown", async () => {
    const view = await finishedTask("Shutdown check");
    const reader = new SseReader(
      await open(`/api/tasks/${view.task.id}/stream`),
    );
    await reader.until((r) => r.frames.length > 0);
    t.app.endStreams();
    await reader.ended();
    expect(reader.isDone).toBe(true);
  });
});

describe("workspace stream", () => {
  it("sends hints named by their type for bot, task, conversation and profile changes", async () => {
    const reader = new SseReader(await open("/api/stream"));
    await reader.until((r) => r.comments.includes("connected"));
    const created = await t.call("POST", "/api/bots", { name: "Hinted" });
    const botId = created.body.bot.id;
    await t.call("POST", `/api/bots/${botId}/messages`, { text: "Hello" });
    const task = await t.call("POST", "/api/tasks", {
      goal: "Hint check",
      coordinatorBotId: botId,
    });
    await t.call("POST", "/api/runtime-profiles", {
      name: "Hint profile",
      sandbox: { driver: "local", network: { mode: "open" } },
    });
    const has = (r: SseReader, type: string, match: Record<string, string>) =>
      r.frames.some((frame) => {
        const hint = JSON.parse(frame.data);
        return (
          frame.event === type &&
          hint.type === type &&
          Object.entries(match).every(([key, value]) => hint[key] === value)
        );
      });
    await reader.until(
      (r) =>
        has(r, "bots.changed", { botId }) &&
        has(r, "conversation.changed", { botId }) &&
        has(r, "tasks.changed", { taskId: task.body.task.id }) &&
        has(r, "profiles.changed", {}),
      { what: "all four hint types" },
    );
    await reader.close();
    expect(reader.frames.every((frame) => frame.id === undefined)).toBe(true);
  });

  it("heartbeats while idle and closes its subscription on disconnect", async () => {
    const before = t.app.openStreams;
    const reader = new SseReader(await open("/api/stream"));
    await reader.until((r) => r.comments.includes("heartbeat"), {
      what: "a heartbeat",
    });
    expect(t.app.openStreams).toBe(before + 1);
    await reader.close();
    await until(() => t.app.openStreams === before, {
      what: "the stream to close",
    });
  });
});
