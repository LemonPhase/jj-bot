import { asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Database } from "./database";
import {
  appendEvent,
  listEvents,
  nextConversationSequence,
  nextMessageSequence,
  RecordNotFoundError,
} from "./events";
import { newId } from "./ids";
import { conversationMessages, taskMessages, tasks } from "./schema";
import {
  cleanup,
  gate,
  OPEN_TIMEOUT,
  postgresTarget,
  postgresUrl,
  seedBot,
  seedTask,
  settlesWithin,
  targets,
} from "./test-helpers";

afterAll(cleanup, OPEN_TIMEOUT);

describe.each(targets)("event and message sequences on $name", (target) => {
  let database: Database;
  beforeAll(async () => {
    database = await (await target.fresh()).open();
  }, OPEN_TIMEOUT);

  it("allocates gap-free per-task sequences and replays after a cursor", async () => {
    const { db } = database;
    const first = await seedTask(db);
    const second = await seedTask(db);
    // Concurrent callers on PGlite queue on its single connection; the
    // allocation is still per task.
    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        db.transaction((tx) =>
          appendEvent(tx, {
            taskId: first.id,
            type: "message.posted",
            payload: { index },
          }),
        ),
      ),
    );
    const other = await db.transaction((tx) =>
      appendEvent(tx, {
        taskId: second.id,
        type: "task.created",
        botId: second.coordinatorBotId,
        causedBy: "evt_cause",
      }),
    );
    expect(other).toMatchObject({
      sequence: 1,
      ownerId: "local",
      botId: second.coordinatorBotId,
      sessionId: null,
      causedBy: "evt_cause",
      payload: {},
    });
    expect(other.id.startsWith("evt_")).toBe(true);
    expect(other.occurredAt).toBeInstanceOf(Date);
    const events = await listEvents(db, first.id);
    expect(events.map((event) => event.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(
      (await listEvents(db, first.id, { after: 7 })).map((e) => e.sequence),
    ).toEqual([8, 9, 10]);
    expect(
      (await listEvents(db, first.id, { after: 2, limit: 2 })).map(
        (e) => e.sequence,
      ),
    ).toEqual([3, 4]);
    await expect(listEvents(db, first.id, { after: -1 })).rejects.toThrow(
      "cursor",
    );
  });

  it("releases a sequence when its transaction rolls back", async () => {
    const { db } = database;
    const task = await seedTask(db);
    await db.transaction((tx) =>
      appendEvent(tx, { taskId: task.id, type: "task.created" }),
    );
    await expect(
      db.transaction(async (tx) => {
        await appendEvent(tx, { taskId: task.id, type: "message.posted" });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    const next = await db.transaction((tx) =>
      appendEvent(tx, { taskId: task.id, type: "message.posted" }),
    );
    expect(next.sequence).toBe(2);
    expect(
      (await listEvents(db, task.id)).map((event) => event.sequence),
    ).toEqual([1, 2]);
  });

  it("refuses an unknown task or bot", async () => {
    const { db } = database;
    await expect(
      db.transaction((tx) =>
        appendEvent(tx, { taskId: "task_missing", type: "task.created" }),
      ),
    ).rejects.toBeInstanceOf(RecordNotFoundError);
    await expect(
      db.transaction((tx) => nextMessageSequence(tx, "task_missing")),
    ).rejects.toBeInstanceOf(RecordNotFoundError);
    await expect(
      db.transaction((tx) => nextConversationSequence(tx, "bot_missing")),
    ).rejects.toBeInstanceOf(RecordNotFoundError);
  });

  it("allocates task message and bot conversation sequences independently", async () => {
    const { db } = database;
    const bot = await seedBot(db);
    const task = await seedTask(db, bot.id);
    for (const text of ["one", "two", "three"]) {
      await db.transaction(async (tx) => {
        const sequence = await nextMessageSequence(tx, task.id);
        await tx.insert(taskMessages).values({
          id: newId("taskMessage"),
          taskId: task.id,
          sequence,
          authorKind: "user",
          intent: "steering",
          text,
          recipientBotIds: [bot.id],
        });
        await appendEvent(tx, {
          taskId: task.id,
          type: "message.posted",
          payload: { sequence },
        });
      });
      await db.transaction(async (tx) => {
        const sequence = await nextConversationSequence(tx, bot.id);
        await tx.insert(conversationMessages).values({
          id: newId("conversationMessage"),
          botId: bot.id,
          sequence,
          role: "user",
          text,
        });
      });
    }
    const messages = await db
      .select()
      .from(taskMessages)
      .where(eq(taskMessages.taskId, task.id))
      .orderBy(asc(taskMessages.sequence));
    expect(messages.map((m) => [m.sequence, m.text])).toEqual([
      [1, "one"],
      [2, "two"],
      [3, "three"],
    ]);
    expect(messages[0]?.recipientBotIds).toEqual([bot.id]);
    const conversation = await db
      .select()
      .from(conversationMessages)
      .where(eq(conversationMessages.botId, bot.id))
      .orderBy(asc(conversationMessages.sequence));
    expect(conversation.map((m) => m.sequence)).toEqual([1, 2, 3]);
    expect(
      (await listEvents(db, task.id)).map((event) => event.sequence),
    ).toEqual([1, 2, 3]);
  });
});

describe.skipIf(!postgresUrl)(
  "event sequences under PostgreSQL concurrency",
  () => {
    let first: Database;
    let second: Database;
    beforeAll(async () => {
      const fresh = await postgresTarget.fresh();
      // Two pools stand in for two processes.
      first = await fresh.open(10);
      second = await fresh.open(10);
    }, OPEN_TIMEOUT);

    it("keeps 50 concurrent appends to one task gap-free and ordered", async () => {
      const task = await seedTask(first.db);
      const appended = await Promise.all(
        Array.from({ length: 50 }, (_, index) =>
          (index % 2 ? first : second).db.transaction((tx) =>
            appendEvent(tx, {
              taskId: task.id,
              type: "message.posted",
              payload: { index },
            }),
          ),
        ),
      );
      expect(
        appended.map((event) => event.sequence).sort((a, b) => a - b),
      ).toEqual(Array.from({ length: 50 }, (_, index) => index + 1));
      const replay = await listEvents(second.db, task.id);
      expect(replay.map((event) => event.sequence)).toEqual(
        Array.from({ length: 50 }, (_, index) => index + 1),
      );
      // Every caller's payload landed exactly once.
      expect(
        replay
          .map((event) => event.payload.index as number)
          .sort((a, b) => a - b),
      ).toEqual(Array.from({ length: 50 }, (_, index) => index));
      // occurred_at is taken after the task row lock, so it never runs backwards.
      for (let index = 1; index < replay.length; index += 1)
        expect(replay[index]?.occurredAt.getTime()).toBeGreaterThanOrEqual(
          replay[index - 1]?.occurredAt.getTime() ?? 0,
        );
      const [counter] = await first.db
        .select({ eventSeq: tasks.eventSeq })
        .from(tasks)
        .where(eq(tasks.id, task.id));
      expect(counter?.eventSeq).toBe(50);
    });

    it("does not make one task's append wait on another task's open transaction", async () => {
      const taskA = await seedTask(first.db);
      const taskB = await seedTask(first.db);
      const holding = gate();
      const release = gate();
      // Holds task A's sequence row (and a pending notification) uncommitted.
      const holder = first.db.transaction(async (tx) => {
        await appendEvent(tx, { taskId: taskA.id, type: "task.created" });
        holding.open();
        await release.promise;
      });
      await holding.promise;
      try {
        const otherTask = second.db.transaction((tx) =>
          appendEvent(tx, { taskId: taskB.id, type: "task.created" }),
        );
        expect(await settlesWithin(otherTask, 2_000)).toBe("settled");
        expect((await otherTask).sequence).toBe(1);
        // The same task does wait: that row lock is what keeps sequences gap-free.
        const sameTask = second.db.transaction((tx) =>
          appendEvent(tx, { taskId: taskA.id, type: "message.posted" }),
        );
        expect(await settlesWithin(sameTask, 300)).toBe("pending");
        release.open();
        await holder;
        expect((await sameTask).sequence).toBe(2);
      } finally {
        release.open();
        await holder.catch(() => {});
      }
    });
  },
);
