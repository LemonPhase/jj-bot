// Event retention through the whole server on the scripted model: after a
// compaction pass, a stream resumed from a `Last-Event-ID` inside the
// compacted range, and an event page read from any cursor, fold into the
// view the API serves; the metrics count what was compacted.
import {
  applyTaskEvent,
  emptyUsage,
  parseTaskEvent,
  type TaskEvent,
  type TaskView,
  taskEventPageSchema,
  taskViewSchema,
} from "@jj/contracts";
import { jobs, runs } from "@jj/db";
import { and, count, eq, inArray, or } from "drizzle-orm";
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
  t = await testApp();
  bots = await createBots(t, ["Ada", "Grace", "Linus"]);
}, OPEN_TIMEOUT);
afterAll(async () => {
  await t?.dispose();
});

async function events(taskId: string, after = 0) {
  const all: TaskEvent[] = [];
  let cursor = after;
  for (;;) {
    const { body } = await t.call(
      "GET",
      `/api/tasks/${taskId}/events?after=${cursor}`,
    );
    const page = taskEventPageSchema.parse(body);
    all.push(...(page.events as TaskEvent[]));
    cursor = page.cursor;
    if (!page.hasMore) return { events: all, page };
  }
}

/** Until nothing of the task runs, is queued or is pending a snapshot. */
async function settled(taskId: string) {
  await until(
    async () => {
      const [open] = await t.database.db
        .select({ value: count() })
        .from(runs)
        .where(
          and(
            eq(runs.taskId, taskId),
            or(eq(runs.status, "running"), eq(runs.snapshotPending, true)),
          ),
        );
      const [queued] = await t.database.db
        .select({ value: count() })
        .from(jobs)
        .where(
          and(
            eq(jobs.taskId, taskId),
            inArray(jobs.status, ["queued", "running"]),
          ),
        );
      return open?.value === 0 && queued?.value === 0;
    },
    { what: "the task to settle", timeoutMs: 45_000 },
  );
}

/** The view at `n`, as a client that loaded it then held it: the first n events folded. */
function viewAt(log: readonly TaskEvent[], n: number): TaskView {
  const created = log[0] as Extract<TaskEvent, { type: "task.created" }>;
  return log
    .filter((event) => event.sequence <= n)
    .reduce(applyTaskEvent, {
      task: created.payload.task,
      sessions: [],
      messages: [],
      artifacts: [],
      approvals: [],
      verificationChecks: [],
      usage: { total: emptyUsage(), bySession: {} },
      events: [],
      firstSequence: 1,
      hasEarlier: false,
      cursor: 0,
      compactedThrough: 0,
    } satisfies TaskView);
}

const byCreation = <Row extends { createdAt: string; id: string }>(
  rows: readonly Row[],
) =>
  [...rows].sort(
    (a, b) =>
      a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
  );

/** The records a fold must reproduce, in the server's order. */
const records = (view: TaskView) => ({
  task: view.task,
  sessions: byCreation(view.sessions),
  messages: [...view.messages].sort((a, b) => a.sequence - b.sequence),
  artifacts: byCreation(view.artifacts),
  approvals: byCreation(view.approvals),
  verificationChecks: view.verificationChecks,
  usage: view.usage,
  cursor: view.cursor,
  compactedThrough: view.compactedThrough,
});

async function finished(body: unknown, check: (view: TaskView) => boolean) {
  const id = (body as { task: { id: string } }).task.id;
  await untilTask(t, id, check, "the task");
  await settled(id);
  return id;
}

describe("a compacted task through the API", () => {
  it("converges from a Last-Event-ID inside the compacted range, and from every cursor", async () => {
    // A team task, and one whose call waits for approval and is approved.
    const team = await t.call("POST", "/api/tasks", {
      goal: "Write the notes: run `echo notes > notes.txt`",
      coordinatorBotId: bots.Ada,
      participantBotIds: [bots.Grace, bots.Linus],
    });
    const teamId = await finished(
      team.body,
      (view) => view.task.status === "completed",
    );
    const profile = await t.call("POST", "/api/runtime-profiles", {
      name: "Guarded",
      sandbox: { driver: "local", network: { mode: "open" } },
      approvals: [{ tool: "bash", match: "git push" }],
    });
    const nova = await t.call("POST", "/api/bots", {
      name: "Nova",
      runtimeProfileId: profile.body.profile.id,
    });
    const held = await t.call("POST", "/api/tasks", {
      goal: "Ship: run `echo shipped > shipped.txt # git push`",
      coordinatorBotId: nova.body.bot.id,
    });
    const heldId = held.body.task.id as string;
    const waiting = await untilTask(
      t,
      heldId,
      (view) =>
        view.approvals.some((approval) => approval.status === "pending"),
      "the held call",
    );
    const approval = waiting.approvals[0];
    const decided = await t.call(
      "POST",
      `/api/tasks/${heldId}/approvals/${approval?.id}`,
      { decision: "approve" },
    );
    expect(decided.status).toBe(200);
    await finished(held.body, (view) => view.task.status === "completed");

    const originals = new Map<string, TaskEvent[]>();
    for (const id of [teamId, heldId])
      originals.set(id, (await events(id)).events);
    const pass = await t.engine.maintenance.compactEvents({
      finishedBefore: new Date(Date.now() + 60_000),
    });
    expect(pass.tasks.map((done) => done.taskId).sort()).toEqual(
      [teamId, heldId].sort(),
    );

    for (const id of [teamId, heldId]) {
      const original = originals.get(id) as TaskEvent[];
      const { events: kept, page } = await events(id);
      const view = taskViewSchema.parse(
        (await t.call("GET", `/api/tasks/${id}`)).body,
      );
      const through = original.at(-1)?.sequence as number;
      expect(view.compactedThrough).toBe(through);
      expect(page.compactedThrough).toBe(through);
      expect(kept.at(-1)?.type).toBe("task.compacted");
      const keptSequences = new Set(kept.map((event) => event.sequence));
      const deleted = original
        .map((event) => event.sequence)
        .filter((sequence) => !keptSequences.has(sequence));
      expect(deleted.length).toBeGreaterThan(0);
      if (id === heldId)
        expect(
          original.filter((event) => event.type.startsWith("approval.")).length,
        ).toBeGreaterThan(
          kept.filter((event) => event.type.startsWith("approval.")).length,
        );

      // A browser that had the view at a deleted event's sequence reconnects.
      const resumeAt = deleted[Math.floor(deleted.length / 2)] as number;
      const response = await t.app.request(`/api/tasks/${id}/stream`, {
        headers: {
          Accept: "text/event-stream",
          "Last-Event-ID": String(resumeAt),
        },
      });
      expect(response.status).toBe(200);
      const reader = new SseReader(response);
      await reader.until((r) => r.frames.at(-1)?.id === String(view.cursor), {
        what: "the stream to reach the view's cursor",
      });
      await reader.close();
      const streamed = reader.frames.map(
        (frame) => parseTaskEvent(JSON.parse(frame.data)) as TaskEvent,
      );
      expect(streamed.map((event) => event.sequence)).toEqual(
        kept
          .filter((event) => event.sequence > resumeAt)
          .map((event) => event.sequence),
      );
      const resumed = streamed.reduce(
        applyTaskEvent,
        viewAt(original, resumeAt),
      );
      expect(records(resumed)).toEqual(records(view));

      // And from every cursor, through the event pages.
      for (let n = 1; n <= through; n += 1) {
        const after = (await events(id, n)).events;
        expect(
          records(after.reduce(applyTaskEvent, viewAt(original, n))),
          `${id} after ${n}`,
        ).toEqual(records(view));
      }
    }

    const metrics = await t.app.request("/metrics");
    const text = await metrics.text();
    expect(text).toMatch(
      new RegExp(
        `jj_events_compacted_total\\{action="removed"\\} ${pass.removed}\\b`,
      ),
    );
    expect(text).toMatch(
      new RegExp(
        `jj_events_compacted_total\\{action="stripped"\\} ${pass.stripped}\\b`,
      ),
    );
  }, 120_000);

  it("reports the retention in bootstrap", async () => {
    const { body } = await t.call("GET", "/api/bootstrap");
    expect(body.eventRetentionDays).toBe(30);
  });
});
