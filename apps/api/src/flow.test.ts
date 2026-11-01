// One full multi-bot flow over HTTP: chat a bot into creating a task with two
// others, follow the task stream to completion folding events onto the
// snapshot, check parallel delegation and artifacts, then continue the task.
import {
  applyTaskEvent,
  conversationViewSchema,
  parseTaskEvent,
  type TaskEvent,
  type TaskView,
  taskViewSchema,
} from "@jj/contracts";
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

beforeAll(async () => {
  t = await testApp();
}, OPEN_TIMEOUT);
afterAll(async () => {
  await t?.dispose();
});

/** Most runs of `sessionIds` open at once, from run.started/run.finished in log order. */
function maxParallelRuns(events: TaskEvent[], sessionIds: Set<string>) {
  const open = new Set<string>();
  let peak = 0;
  for (const event of events) {
    if (!event.sessionId || !sessionIds.has(event.sessionId)) continue;
    if (event.type === "run.started") open.add(event.sessionId);
    if (event.type === "run.finished") open.delete(event.sessionId);
    peak = Math.max(peak, open.size);
  }
  return peak;
}

describe("a multi-bot task over HTTP", () => {
  it("runs from direct chat to a completed task with parallel workers and downloadable artifacts", async () => {
    const bots = await createBots(t, ["Ada", "Grace", "Linus"]);

    // Direct chat: the scripted chat model creates a task with the bots it mentions.
    const sent = await t.call("POST", `/api/bots/${bots.Ada}/messages`, {
      text: "Please research penguins with Grace and Linus",
    });
    expect(sent.status).toBe(201);
    const conversation = await until(
      async () => {
        const { body } = await t.call("GET", `/api/bots/${bots.Ada}/messages`);
        const view = conversationViewSchema.parse(body);
        return view.messages.find((message) => message.taskId) ? view : null;
      },
      { what: "a reply that links a task" },
    );
    const taskId = conversation.messages.find((message) => message.taskId)
      ?.taskId as string;

    // Snapshot, then fold the stream onto it until the task finishes.
    const snapshot = taskViewSchema.parse(
      (await t.call("GET", `/api/tasks/${taskId}`)).body,
    );
    expect(snapshot.task.coordinatorBotId).toBe(bots.Ada);
    expect([...snapshot.task.participantBotIds].sort()).toEqual(
      [bots.Ada, bots.Grace, bots.Linus].sort(),
    );
    let view: TaskView = snapshot;
    const reader = new SseReader(
      await t.app.request(`/api/tasks/${taskId}/stream`, {
        headers: { "Last-Event-ID": String(snapshot.cursor) },
      }),
    );
    await reader.until(
      (r) =>
        r.events().some((event) => event.type === "task.finished") ||
        snapshot.task.status === "completed",
      { what: "task.finished" },
    );
    await reader.close();
    for (const frame of reader.frames)
      view = applyTaskEvent(view, parseTaskEvent(JSON.parse(frame.data)));

    const fresh = taskViewSchema.parse(
      await untilTask(t, taskId, (current) => current.cursor >= view.cursor),
    );
    expect(view.task).toEqual(fresh.task);
    expect(view.sessions).toEqual(fresh.sessions);
    expect(view.messages).toEqual(fresh.messages);
    expect(view.artifacts).toEqual(fresh.artifacts);
    expect(fresh.task.status).toBe("completed");
    expect(fresh.task.result).toContain("Grace");
    expect(fresh.task.result).toContain("Linus");

    // The coordinator delegated to both others, and their runs overlapped.
    const workers = fresh.sessions.filter(
      (session) => session.role === "worker",
    );
    expect(workers.map((session) => session.botId).sort()).toEqual(
      [bots.Grace, bots.Linus].sort(),
    );
    expect(workers.every((session) => session.status === "completed")).toBe(
      true,
    );
    const log = (await t.call("GET", `/api/tasks/${taskId}/events?after=0`))
      .body.events as TaskEvent[];
    expect(
      maxParallelRuns(log, new Set(workers.map((session) => session.id))),
    ).toBe(2);

    // Each worker's notes file is an artifact with its content.
    const files = fresh.artifacts.filter(
      (artifact) => artifact.kind === "file",
    );
    expect(files.map((artifact) => artifact.name).sort()).toEqual([
      "notes-grace.md",
      "notes-linus.md",
    ]);
    for (const artifact of files) {
      const response = await t.app.request(
        `/api/tasks/${taskId}/artifacts/${artifact.id}/content`,
      );
      expect(response.status).toBe(200);
      const content = await response.text();
      expect(content).toContain("# Notes");
      expect(content.length).toBe(artifact.sizeBytes);
    }

    // A follow-up message continues the completed task.
    const followUp = await t.call("POST", `/api/tasks/${taskId}/messages`, {
      text: "Add one more line about emperor penguins.",
    });
    expect(followUp.status).toBe(201);
    const continued = await untilTask(
      t,
      taskId,
      (current) =>
        current.task.status === "completed" && current.cursor > fresh.cursor,
      "the continued task to complete",
    );
    expect(continued.task.result).toContain("emperor penguins");
  });
});
