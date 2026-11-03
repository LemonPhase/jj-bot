// The event payload cap: a payload whose JSON is over it is stored in full as
// an `output` artifact, the event keeps a clipped copy that names it, and the
// records the view serves stay whole.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskEvent, TaskView } from "@jj/contracts";
import { ModelRegistry, PiSessionExecutor } from "@jj/runtime";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@jj/runtime/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { MIN_EVENT_PAYLOAD_CAP_BYTES } from "./config";
import type { Engine } from "./engine";
import { PAYLOAD_STRING_CLIP_BYTES, payloadBytes } from "./event-payloads";
import { said } from "./testing/fake-executor";
import {
  OPEN_TIMEOUT,
  openTestDatabase,
  type TestDatabase,
  type TestEngine,
  testEngine,
  uniqueName,
  untilTask,
} from "./testing/harness";
import { createTeam } from "./testing/scenarios";

let db: TestDatabase;
const engines: TestEngine[] = [];
const roots: string[] = [];

beforeAll(async () => {
  db = await openTestDatabase();
}, OPEN_TIMEOUT);
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.dispose();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
afterAll(async () => {
  await db?.close();
});

async function allEvents(engine: Engine, taskId: string) {
  const events: TaskEvent[] = [];
  let after = 0;
  for (;;) {
    const page = await engine.tasks.events(taskId, { after });
    events.push(...page.events);
    after = page.cursor;
    if (!page.hasMore) return events;
  }
}

/** The saved copy of a spilled event, parsed. */
async function savedCopy(engine: Engine, event: TaskEvent) {
  expect(event.payloadArtifactId).toBeDefined();
  const { artifact, content } = await engine.tasks.artifactContent(
    event.taskId,
    event.payloadArtifactId as string,
  );
  expect(artifact).toMatchObject({
    kind: "output",
    contentType: "application/json",
    sessionId: event.sessionId,
  });
  return JSON.parse(Buffer.from(content).toString("utf8")) as Record<
    string,
    never
  >;
}

const clippedText = (text: string) =>
  Buffer.byteLength(text, "utf8") < PAYLOAD_STRING_CLIP_BYTES + 100 &&
  text.endsWith("more characters in the saved copy]");

describe("the event payload cap", () => {
  it("spills an over-cap session.updated, keeps a clipped copy, and the view's records whole", async () => {
    const test = await testEngine(db.database, {
      config: { eventPayloadCapBytes: MIN_EVENT_PAYLOAD_CAP_BYTES },
    });
    engines.push(test);
    const { engine, executor } = test;
    const team = await createTeam(engine, ["Ada"]);
    const [ada] = team.names as [string];
    // 150 000 characters of two bytes each: 300 KB of JSON.
    const result = "é".repeat(150_000);
    executor.brain(ada, (view) =>
      said.turns(view) === 0
        ? { calls: [{ name: "complete_task", args: { result } }] }
        : { text: "Done." },
    );
    const { task } = await engine.tasks.create({
      goal: "Write a long result",
      coordinatorBotId: team.byName[ada] as string,
    });
    const view = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed",
      "the long result",
    );
    // The records are whole.
    expect(view.task.result).toBe(result);
    expect(view.sessions[0]?.result).toBe(result);

    const events = await allEvents(engine, task.id);
    const finished = events.find(
      (event): event is Extract<TaskEvent, { type: "session.updated" }> =>
        event.type === "session.updated" &&
        event.payload.session.status === "completed",
    );
    if (!finished) throw new Error("No session.updated completed the session.");
    expect(payloadBytes(finished.payload)).toBeLessThan(
      MIN_EVENT_PAYLOAD_CAP_BYTES,
    );
    expect(clippedText(finished.payload.session.result as string)).toBe(true);
    expect(finished.payload.session.id).toBe(view.sessions[0]?.id);
    expect(finished.payload.previousStatus).toBe("running");
    const full = await savedCopy(engine, finished);
    expect(full).toEqual({
      ...finished.payload,
      session: { ...finished.payload.session, result },
    });
    // Its artifact is announced before it, so a client folding it can link it.
    const announced = events.find(
      (event) =>
        event.type === "artifact.created" &&
        event.payload.artifact.id === finished.payloadArtifactId,
    );
    expect(announced?.sequence).toBe(finished.sequence - 1);
    // Every over-cap event spilled: none is stored over the cap.
    for (const event of events)
      expect(payloadBytes(event.payload), event.type).toBeLessThan(
        MIN_EVENT_PAYLOAD_CAP_BYTES,
      );
    const spilled = new Set(
      events.flatMap((event) => (event.payloadArtifactId ? [event.type] : [])),
    );
    expect([...spilled].sort()).toEqual(
      expect.arrayContaining([
        "session.updated",
        "task.finished",
        "task.updated",
      ]),
    );
    expect(await engine.metrics.text()).toMatch(
      /jj_event_payloads_spilled_total\{type="session\.updated"\} [1-9]/,
    );
  });

  it("spills a held write with 1 MiB of arguments, while its approval keeps them whole", async () => {
    const root = await mkdtemp(join(tmpdir(), "jj-payload-cap-"));
    roots.push(root);
    const content = "x".repeat(1024 * 1024);
    const faux = fauxProvider();
    faux.setResponses([
      fauxAssistantMessage(
        fauxToolCall("write", { path: "big.txt", content }, { id: "big" }),
        { stopReason: "toolUse" },
      ),
    ]);
    const models = new ModelRegistry({
      env: {},
      extraProviders: [faux.provider],
    });
    const test = await testEngine(db.database, {
      runExecutor: new PiSessionExecutor({ models }),
      workspaceRoot: root,
    });
    engines.push(test);
    const { engine } = test;
    const { profile } = await engine.profiles.create({
      name: uniqueName("Guarded"),
      sandbox: { driver: "local", network: { mode: "open" } },
      approvals: [{ tool: "write" }],
    });
    const { bot } = await engine.bots.create({
      name: uniqueName("Ada"),
      runtimeProfileId: profile.id,
    });
    const { task } = await engine.tasks.create({
      goal: "Write a big file",
      coordinatorBotId: bot.id,
    });
    const pendingOf = (v: TaskView) =>
      v.approvals.find((approval) => approval.status === "pending");
    const waiting = await untilTask(
      engine,
      task.id,
      (v) => pendingOf(v) !== undefined && v.task.status === "waiting",
      "the held write",
    );
    expect(pendingOf(waiting)?.args).toEqual({ path: "big.txt", content });

    const requested = (await allEvents(engine, task.id)).find(
      (event): event is Extract<TaskEvent, { type: "approval.requested" }> =>
        event.type === "approval.requested",
    );
    if (!requested) throw new Error("No approval.requested.");
    expect(payloadBytes(requested.payload)).toBeLessThan(256 * 1024);
    expect(requested.payload.approval.args.path).toBe("big.txt");
    expect(clippedText(requested.payload.approval.args.content as string)).toBe(
      true,
    );
    expect(requested.payload.approval.summary).toBe("big.txt");
    const full = await savedCopy(engine, requested);
    expect(full).toMatchObject({ approval: { args: { content } } });

    // Every change of the record spills the same way: a stop cancels it.
    await engine.tasks.stop(task.id, { reason: "Enough" });
    await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "cancelled",
      "the stop",
    );
    const updated = (await allEvents(engine, task.id)).find(
      (event): event is Extract<TaskEvent, { type: "approval.updated" }> =>
        event.type === "approval.updated",
    );
    expect(updated?.payload.approval.status).toBe("cancelled");
    expect(clippedText(updated?.payload.approval.args.content as string)).toBe(
      true,
    );
    expect((await engine.tasks.get(task.id)).approvals[0]?.args).toEqual({
      path: "big.txt",
      content,
    });
  });
});
