// The event payload cap: in a payload over it, what no record bounds is
// clipped and the whole payload saved as an `output` artifact the event names;
// record snapshots are stored whole; every stored event, and the view, parse.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type TaskEvent,
  type TaskView,
  taskEventSchema,
  taskViewSchema,
  type VerificationPlan,
} from "@jj/contracts";
import type { Tx } from "@jj/db";
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
import { emit } from "./events";
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

/** A plan of 20 criteria, each within its limits, whose JSON is over 256 KiB. */
function largePlan(): VerificationPlan {
  const schema = {
    type: "object",
    properties: Object.fromEntries(
      Array.from({ length: 300 }, (_, index) => [
        `field_${String(index).padStart(3, "0")}`,
        { type: "string", description: "A field of the record" },
      ]),
    ),
  };
  return [
    ...Array.from({ length: 18 }, (_, index) => ({
      id: `shape-${index}`,
      description: "The result is the record",
      method: "result" as const,
      expect: "json" as const,
      schema,
    })),
    // 4000 characters, 4200 bytes: a cut after 4 KiB plus a marker passes 4000.
    {
      id: "command",
      description: "The long command passes",
      method: "command" as const,
      command: `${"echo ok; ".repeat(390)}${"中".repeat(100)}`,
    },
    // A regular expression of 2000 characters, 6 KB: cut, it no longer compiles.
    {
      id: "matches",
      description: "The notes say it",
      method: "file" as const,
      path: "notes.md",
      expect: "matches" as const,
      value: `(${"中".repeat(1998)})`,
    },
  ];
}

describe("the event payload cap", () => {
  it("stores a task with a large plan so that every event, and the view, parse", async () => {
    const test = await testEngine(db.database, { start: false });
    engines.push(test);
    const { engine } = test;
    const team = await createTeam(engine, ["Ada"]);
    const plan = largePlan();
    expect(payloadBytes(plan)).toBeGreaterThan(256 * 1024);
    const { task } = await engine.tasks.create({
      goal: "Check the record",
      coordinatorBotId: team.ids[0] as string,
      verificationPlan: plan,
    });
    // The plan changes, so task.updated and task.goal_changed carry it too.
    const changed = largePlan().map((criterion) => ({
      ...criterion,
      description: `${criterion.description}, again`,
    }));
    await engine.tasks.postMessage(task.id, {
      text: "Check it again.",
      verificationPlan: changed,
      observedGoalVersion: 1,
    });
    const events = await allEvents(engine, task.id);
    for (const event of events)
      expect(
        taskEventSchema.safeParse(JSON.parse(JSON.stringify(event))).success,
        `${event.type} #${event.sequence}`,
      ).toBe(true);
    const view = taskViewSchema.safeParse(
      JSON.parse(JSON.stringify(await engine.tasks.get(task.id))),
    );
    expect(view.success).toBe(true);
    expect(view.data?.task.verificationPlan).toEqual(changed);
    // A record snapshot is bounded by its schema: stored whole, never clipped.
    expect(events.filter((event) => event.payloadArtifactId)).toEqual([]);
  });

  it("stores record snapshots whole over the cap, and spills the unbounded text of task.finished", async () => {
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
    expect(view.task.result).toBe(result);
    expect(view.sessions[0]?.result).toBe(result);

    const events = await allEvents(engine, task.id);
    for (const event of events)
      expect(taskEventSchema.safeParse(event).success, event.type).toBe(true);
    // The session's and the task's snapshots are whole, over the cap.
    const completed = events.find(
      (event): event is Extract<TaskEvent, { type: "session.updated" }> =>
        event.type === "session.updated" &&
        event.payload.session.status === "completed",
    );
    expect(completed?.payloadArtifactId).toBeUndefined();
    expect(completed?.payload.session.result).toBe(result);
    expect(payloadBytes(completed?.payload)).toBeGreaterThan(
      MIN_EVENT_PAYLOAD_CAP_BYTES,
    );
    // task.finished's result is free text: clipped, its saved copy whole.
    const finished = events.find(
      (event): event is Extract<TaskEvent, { type: "task.finished" }> =>
        event.type === "task.finished",
    );
    if (!finished) throw new Error("No task.finished.");
    expect(clippedText(finished.payload.result as string)).toBe(true);
    expect(await savedCopy(engine, finished)).toEqual({
      ...finished.payload,
      result,
    });
    // Its artifact is announced before it, so a client folding it can link it.
    const announced = events.find(
      (event) =>
        event.type === "artifact.created" &&
        event.payload.artifact.id === finished.payloadArtifactId,
    );
    expect(announced?.sequence).toBe(finished.sequence - 1);
    expect(
      events
        .filter((event) => event.payloadArtifactId)
        .map((event) => event.type),
    ).toEqual(["task.finished"]);
    // Counted once its transaction committed.
    expect(await engine.metrics.text()).toMatch(
      /jj_event_payloads_spilled_total\{type="task\.finished"\} 1\b/,
    );
  });

  it("counts a spilled payload only once its transaction commits", async () => {
    const test = await testEngine(db.database, {
      start: false,
      config: { eventPayloadCapBytes: MIN_EVENT_PAYLOAD_CAP_BYTES },
    });
    engines.push(test);
    const { engine } = test;
    const team = await createTeam(engine, ["Ada"]);
    const { task } = await engine.tasks.create({
      goal: "Fail loudly",
      coordinatorBotId: team.ids[0] as string,
    });
    const ctx = engine.context;
    const spill = (tx: Tx) =>
      emit(tx, ctx, task.id, {
        type: "run.finished",
        payload: { outcome: "failed", error: "e".repeat(200_000) },
      });
    const spilled =
      /jj_event_payloads_spilled_total\{type="run\.finished"\} (\d+)/;
    await expect(
      ctx.db.transaction(async (tx) => {
        await spill(tx);
        throw new Error("rolled back");
      }),
    ).rejects.toThrow("rolled back");
    expect((await engine.metrics.text()).match(spilled)?.[1] ?? "0").toBe("0");
    await ctx.db.transaction(spill);
    expect((await engine.metrics.text()).match(spilled)?.[1]).toBe("1");
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
