import { and, eq, isNull, max, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "./database";
import { nextConversationSequence } from "./events";
import { newId } from "./ids";
import {
  type ClaimedJob,
  cancelWhere,
  claim,
  complete,
  enqueue,
  fail,
  heartbeat,
  LEASE_EXHAUSTED_ERROR,
} from "./queue";
import { conversationMessages, jobs, sessionInbox } from "./schema";
import {
  cleanup,
  gate,
  OPEN_TIMEOUT,
  postgresTarget,
  postgresUrl,
  seedBots,
  seedSessions,
  settlesWithin,
  sleep,
  targets,
} from "./test-helpers";

afterAll(cleanup, OPEN_TIMEOUT);

async function jobRow(database: Database, id: string) {
  const [row] = await database.db.select().from(jobs).where(eq(jobs.id, id));
  return row;
}

async function claimIds(
  database: Database,
  owner: string,
  limit = 10,
  leaseMs = 30_000,
) {
  return (await claim(database.db, owner, limit, leaseMs)).jobs.map(
    (job) => job.id,
  );
}

const must = <T>(value: T | null | undefined): T => {
  if (value === null || value === undefined) throw new Error("missing");
  return value;
};

describe.each(targets)("job queue on $name", (target) => {
  let database: Database;
  beforeAll(async () => {
    database = await (await target.fresh()).open();
  }, OPEN_TIMEOUT);
  // claim() takes any claimable job, so each test starts from an empty queue.
  beforeEach(async () => {
    await database.db.delete(jobs);
  }, OPEN_TIMEOUT);

  it("claims due jobs oldest first, leases them, and completes only with the lease", async () => {
    const { db } = database;
    const { task, sessions } = await seedSessions(db, 2);
    const [bot] = await seedBots(db, 2);
    const older = must(
      await enqueue(db, {
        kind: "session.run",
        taskId: task.id,
        sessionId: sessions[0]?.id,
        payload: { reason: "start" },
        runAfter: new Date(Date.now() - 60_000),
      }),
    );
    const newer = must(
      await enqueue(db, { kind: "chat.reply", botId: bot?.id }),
    );
    const later = must(
      await enqueue(db, {
        kind: "session.run",
        sessionId: sessions[1]?.id,
        runAfter: new Date(Date.now() + 60 * 60_000),
      }),
    );
    expect(older).toMatchObject({
      status: "queued",
      attempts: 0,
      maxAttempts: 3,
      leaseOwner: null,
    });
    expect(older.id.startsWith("job_")).toBe(true);

    const { jobs: claimed, exhausted } = await claim(db, "a", 10, 30_000);
    expect(exhausted).toEqual([]);
    expect(claimed.map((job) => job.id)).toEqual([older.id, newer.id]);
    for (const job of claimed) {
      expect(job).toMatchObject({
        status: "running",
        leaseOwner: "a",
        attempts: 1,
      });
      expect(job.lease).toEqual({
        jobId: job.id,
        owner: "a",
        attempt: 1,
        kind: job.kind,
      });
      expect(job.leaseUntil?.getTime()).toBeGreaterThan(Date.now() + 20_000);
    }
    expect(claimed[0]?.payload).toEqual({ reason: "start" });
    // Nothing else is due; the future job stays queued.
    expect(await claimIds(database, "b")).toEqual([]);
    expect((await jobRow(database, later.id))?.status).toBe("queued");

    const lease = must(claimed[0]).lease;
    const forged = { ...lease, owner: "b" };
    expect(await heartbeat(db, forged, 30_000)).toBe(false);
    expect(await complete(db, forged)).toBe(false);
    expect(await heartbeat(db, lease, 30_000)).toBe(true);
    expect(await complete(db, lease)).toBe(true);
    expect(await jobRow(database, older.id)).toMatchObject({
      status: "done",
      leaseOwner: "a",
      leaseUntil: null,
    });
    // Finished: no more heartbeats or completions, even for the holder.
    expect(await heartbeat(db, lease, 30_000)).toBe(false);
    expect(await complete(db, lease)).toBe(false);
  });

  it("respects the claim limit and validates its arguments", async () => {
    const { db } = database;
    for (const bot of await seedBots(db, 5))
      await enqueue(db, { kind: "chat.reply", botId: bot.id });
    expect(await claimIds(database, "w", 2)).toHaveLength(2);
    expect(await claimIds(database, "w", 2)).toHaveLength(2);
    expect(await claimIds(database, "w", 2)).toHaveLength(1);
    await expect(claim(db, "w", 0, 30_000)).rejects.toThrow("limit");
    await expect(claim(db, "w", 1, 0)).rejects.toThrow("Lease");
    await expect(
      enqueue(db, { kind: "chat.reply", botId: "x", maxAttempts: 0 }),
    ).rejects.toThrow("maxAttempts");
  });

  it("requires the key of a single-run job", async () => {
    const { db } = database;
    await expect(enqueue(db, { kind: "session.run" })).rejects.toThrow();
    await expect(enqueue(db, { kind: "chat.reply" })).rejects.toThrow();
  });

  it("reclaims an expired lease, fencing out the old runner even when it is the same owner", async () => {
    const { db } = database;
    const [bot] = await seedBots(db, 1);
    const job = must(await enqueue(db, { kind: "chat.reply", botId: bot?.id }));
    const first = must((await claim(db, "w", 1, 50)).jobs[0]);
    // A live lease is not reclaimed.
    expect(await claimIds(database, "w")).toEqual([]);
    await sleep(120);
    const second = must((await claim(db, "w", 1, 30_000)).jobs[0]);
    expect(second).toMatchObject({ id: job.id, leaseOwner: "w", attempts: 2 });
    expect(second.lease).toEqual({ ...first.lease, attempt: 2 });
    // The first runner still believes it holds the job: every call is fenced.
    expect(await heartbeat(db, first.lease, 30_000)).toBe(false);
    expect(await complete(db, first.lease)).toBe(false);
    expect(await fail(db, first.lease, "late")).toBe(false);
    expect(await heartbeat(db, second.lease, 30_000)).toBe(true);
    // Another owner reclaims after the second expiry, too.
    await db
      .update(jobs)
      .set({ leaseUntil: sql`now() - interval '1 second'` })
      .where(eq(jobs.id, job.id));
    const third = must((await claim(db, "rescuer", 1, 30_000)).jobs[0]);
    expect(third.lease).toMatchObject({ owner: "rescuer", attempt: 3 });
    expect(await complete(db, second.lease)).toBe(false);
    expect(await complete(db, third.lease)).toBe(true);
  });

  it("fails a job whose lease expired max_attempts times, and reports it once", async () => {
    const { db } = database;
    const [capped, defaulted] = await seedBots(db, 2);
    const job = must(
      await enqueue(db, {
        kind: "chat.reply",
        botId: capped?.id,
        maxAttempts: 2,
      }),
    );
    const other = must(
      await enqueue(db, { kind: "chat.reply", botId: defaulted?.id }),
    );
    expect(other.maxAttempts).toBe(3);
    const expire = () =>
      db
        .update(jobs)
        .set({ leaseUntil: sql`now() - interval '1 second'` })
        .where(eq(jobs.status, "running"));
    await claim(db, "w", 10, 30_000); // attempt 1 of both
    await expire();
    expect(
      (await claim(db, "w", 10, 30_000)).jobs.map((j) => j.attempts),
    ).toEqual([2, 2]);
    await expire();
    const result = await claim(db, "w", 10, 30_000);
    // The capped job is out of attempts; the default one gets its third.
    expect(result.jobs.map((j) => [j.id, j.attempts])).toEqual([[other.id, 3]]);
    expect(result.exhausted).toHaveLength(1);
    expect(result.exhausted[0]).toMatchObject({
      id: job.id,
      status: "failed",
      lastError: LEASE_EXHAUSTED_ERROR,
      leaseUntil: null,
      attempts: 2,
    });
    expect(await claim(db, "w", 10, 30_000)).toEqual({
      jobs: [],
      exhausted: [],
    });
    expect((await jobRow(database, job.id))?.status).toBe("failed");
  });

  it("fails a job, and never requeues a single-run job", async () => {
    const { db } = database;
    const [bot] = await seedBots(db, 1);
    const job = must(await enqueue(db, { kind: "chat.reply", botId: bot?.id }));
    const { lease } = must((await claim(db, "w", 1, 30_000)).jobs[0]);
    await expect(
      fail(db, lease, "overloaded", new Date(Date.now() + 1_000)),
    ).rejects.toThrow("not requeued");
    expect((await jobRow(database, job.id))?.status).toBe("running");
    expect(await fail(db, lease, "bad input")).toBe(true);
    expect(await jobRow(database, job.id)).toMatchObject({
      status: "failed",
      lastError: "bad input",
      leaseUntil: null,
    });
    expect(await fail(db, lease, "again")).toBe(false);
  });

  it("coalesces wakes: one pending and one running session.run per session", async () => {
    const { db } = database;
    const { task, sessions } = await seedSessions(db, 2);
    const [s1, s2] = sessions.map((s) => s.id);
    const wake = (sessionId?: string) =>
      enqueue(db, { kind: "session.run", taskId: task.id, sessionId });
    const pending = must(await wake(s1));
    expect(await wake(s1)).toBeNull(); // already pending
    const independent = must(await wake(s2));
    const { jobs: running } = await claim(db, "w", 10, 30_000);
    expect(running.map((j) => j.id).sort()).toEqual(
      [pending.id, independent.id].sort(),
    );
    // While s1 runs, a wake queues a follow-up run instead of coalescing...
    const followUp = must(await wake(s1));
    expect(await wake(s1)).toBeNull();
    // ...which is not claimed until the running one ends.
    expect(await claimIds(database, "w")).toEqual([]);
    const s1Run = must(running.find((j) => j.sessionId === s1));
    expect(await complete(db, s1Run.lease)).toBe(true);
    expect(await claimIds(database, "w")).toEqual([followUp.id]);
  });

  it("coalesces chat.reply per bot the same way", async () => {
    const { db } = database;
    const [bot] = await seedBots(db, 1);
    const reply = () => enqueue(db, { kind: "chat.reply", botId: bot?.id });
    const first = must(await reply());
    expect(await reply()).toBeNull();
    const [running] = (await claim(db, "w", 10, 30_000)).jobs;
    const next = must(await reply());
    expect(await claimIds(database, "w")).toEqual([]);
    expect(await complete(db, must(running).lease)).toBe(true);
    expect(await claimIds(database, "w")).toEqual([next.id]);
    expect(first.id).not.toBe(next.id);
  });

  it("cancels a task's queued jobs and leaves running ones to their owner", async () => {
    const { db } = database;
    const { task, sessions } = await seedSessions(db, 3);
    const other = await seedSessions(db, 1);
    const run = (sessionId?: string, runAfter?: Date) =>
      enqueue(db, {
        kind: "session.run",
        taskId: task.id,
        sessionId,
        runAfter,
      });
    const running = must(await run(sessions[0]?.id));
    await claim(db, "w", 1, 30_000);
    const queued = must(await run(sessions[1]?.id));
    const future = must(
      await run(sessions[2]?.id, new Date(Date.now() + 60_000)),
    );
    const unrelated = must(
      await enqueue(db, {
        kind: "session.run",
        taskId: other.task.id,
        sessionId: other.sessions[0]?.id,
      }),
    );
    const cancelled = await db.transaction((tx) =>
      cancelWhere(tx, { taskId: task.id }),
    );
    expect(cancelled.sort()).toEqual([queued.id, future.id].sort());
    expect((await jobRow(database, running.id))?.status).toBe("running");
    expect((await jobRow(database, unrelated.id))?.status).toBe("queued");
    expect(await claimIds(database, "w")).toEqual([unrelated.id]);
  });

  it("commits an enqueue only with its transaction", async () => {
    const { db } = database;
    const [bot] = await seedBots(db, 1);
    await expect(
      db.transaction(async (tx) => {
        await enqueue(tx, { kind: "chat.reply", botId: bot?.id });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await claimIds(database, "w")).toEqual([]);
  });

  it(
    "never runs a session twice and never loses a wake (functional)",
    async () => {
      await wakeStress(database, database, {
        wakers: 3,
        wakes: 12,
        workers: 3,
        keys: 6,
      });
    },
    OPEN_TIMEOUT,
  );

  it(
    "never runs a bot's chat twice and never loses a message (functional)",
    async () => {
      await chatStress(database, database, {
        wakers: 3,
        wakes: 12,
        workers: 3,
        keys: 6,
      });
    },
    OPEN_TIMEOUT,
  );
});

interface StressShape {
  wakers: number;
  wakes: number;
  workers: number;
  /** Sessions or bots woken. More keys means more final wakes, the ones a lost wake can hide in. */
  keys: number;
}

const jitter = (ms: number) => sleep(Math.floor(Math.random() * (ms + 1)));

/**
 * Wakers post an inbox item and enqueue a session.run in one transaction,
 * pausing before commit as an engine transaction might. Workers claim runs,
 * drain the inbox at the start and at a later "turn boundary", and complete.
 * Asserts no session ever has two runs at once and every item is delivered.
 */
async function wakeStress(
  wakerDb: Database,
  workerDb: Database,
  shape: StressShape,
) {
  const { task, sessions } = await seedSessions(wakerDb.db, shape.keys);
  const active = new Set<string>();
  const violations: string[] = [];
  const delivered: string[] = [];
  let wakersDone = false;

  async function waker(index: number) {
    for (let wake = 0; wake < shape.wakes; wake += 1) {
      const session = must(sessions[(index + wake) % sessions.length]);
      await wakerDb.db.transaction(async (tx) => {
        await tx.insert(sessionInbox).values({
          id: newId("inboxItem"),
          sessionId: session.id,
          taskId: task.id,
          kind: "message",
          text: `${index}:${wake}`,
        });
        await enqueue(tx, {
          kind: "session.run",
          taskId: task.id,
          sessionId: session.id,
        });
        // Longer than a worker's run: a run claimed in this window could
        // finish before the commit if the pending job were claimable.
        await jitter(6);
      });
      await jitter(1);
    }
  }

  async function drain(sessionId: string) {
    const rows = await workerDb.db
      .update(sessionInbox)
      .set({ deliveredAt: sql`now()` })
      .where(
        and(
          eq(sessionInbox.sessionId, sessionId),
          isNull(sessionInbox.deliveredAt),
        ),
      )
      .returning({ text: sessionInbox.text });
    delivered.push(...rows.map((row) => row.text));
  }

  async function run(job: ClaimedJob) {
    const sessionId = must(job.sessionId);
    if (active.has(sessionId)) violations.push(`double run of ${sessionId}`);
    active.add(sessionId);
    await drain(sessionId);
    await jitter(1);
    await drain(sessionId);
    // Leave the set before completing: until then no other run can be claimed.
    active.delete(sessionId);
    if (!(await complete(workerDb.db, job.lease)))
      violations.push(`lost lease ${job.id}`);
  }

  await workUntilIdle(
    workerDb,
    shape,
    run,
    () => wakersDone,
    async () => {
      await Promise.all(
        Array.from({ length: shape.wakers }, (_, index) => waker(index)),
      );
      wakersDone = true;
    },
  );

  expect(violations).toEqual([]);
  const undelivered = await workerDb.db
    .select()
    .from(sessionInbox)
    .where(
      and(eq(sessionInbox.taskId, task.id), isNull(sessionInbox.deliveredAt)),
    );
  expect(undelivered).toEqual([]);
  expect(delivered).toHaveLength(shape.wakers * shape.wakes);
  expect(new Set(delivered).size).toBe(delivered.length);
}

/** The chat.reply equivalent: user messages per bot, one reply job per bot at a time. */
async function chatStress(
  wakerDb: Database,
  workerDb: Database,
  shape: StressShape,
) {
  const bots = await seedBots(wakerDb.db, shape.keys);
  const active = new Set<string>();
  const violations: string[] = [];
  const handled = new Map<string, number>();
  let wakersDone = false;

  async function waker(index: number) {
    for (let wake = 0; wake < shape.wakes; wake += 1) {
      const bot = must(bots[(index + wake) % bots.length]);
      await wakerDb.db.transaction(async (tx) => {
        const sequence = await nextConversationSequence(tx, bot.id);
        await tx.insert(conversationMessages).values({
          id: newId("conversationMessage"),
          botId: bot.id,
          sequence,
          role: "user",
          text: `${index}:${wake}`,
        });
        await enqueue(tx, { kind: "chat.reply", botId: bot.id });
        // Longer than a worker's run: a run claimed in this window could
        // finish before the commit if the pending job were claimable.
        await jitter(6);
      });
      await jitter(1);
    }
  }

  async function latestUserMessage(botId: string) {
    const [row] = await workerDb.db
      .select({ sequence: max(conversationMessages.sequence) })
      .from(conversationMessages)
      .where(
        and(
          eq(conversationMessages.botId, botId),
          eq(conversationMessages.role, "user"),
        ),
      );
    return row?.sequence ?? 0;
  }

  async function run(job: ClaimedJob) {
    const botId = must(job.botId);
    if (active.has(botId)) violations.push(`double reply for ${botId}`);
    active.add(botId);
    handled.set(botId, await latestUserMessage(botId));
    await jitter(1);
    active.delete(botId);
    if (!(await complete(workerDb.db, job.lease)))
      violations.push(`lost lease ${job.id}`);
  }

  await workUntilIdle(
    workerDb,
    shape,
    run,
    () => wakersDone,
    async () => {
      await Promise.all(
        Array.from({ length: shape.wakers }, (_, index) => waker(index)),
      );
      wakersDone = true;
    },
  );

  expect(violations).toEqual([]);
  for (const bot of bots)
    expect(handled.get(bot.id) ?? 0).toBe(await latestUserMessage(bot.id));
  const total = [...handled.values()].reduce((sum, value) => sum + value, 0);
  expect(total).toBe(shape.wakers * shape.wakes);
}

/** Runs workers until the wakers are done and no job is queued or running. */
async function workUntilIdle(
  database: Database,
  shape: StressShape,
  run: (job: ClaimedJob) => Promise<void>,
  wakersDone: () => boolean,
  wake: () => Promise<void>,
) {
  async function worker(index: number) {
    for (;;) {
      const { jobs: batch } = await claim(database.db, `w${index}`, 2, 60_000);
      if (batch.length > 0) {
        await Promise.all(batch.map(run));
        continue;
      }
      if (wakersDone()) {
        const [open] = await database.db
          .select({ count: sql<number>`count(*)::int` })
          .from(jobs)
          .where(sql`${jobs.status} in ('queued', 'running')`);
        if ((open?.count ?? 0) === 0) return;
      }
      await sleep(2);
    }
  }
  await Promise.all([
    wake(),
    ...Array.from({ length: shape.workers }, (_, index) => worker(index)),
  ]);
}

describe.skipIf(!postgresUrl)("job queue under PostgreSQL concurrency", () => {
  let first: Database;
  let second: Database;
  beforeAll(async () => {
    const fresh = await postgresTarget.fresh();
    // Separate pools: claims race on different connections, as two workers would.
    first = await fresh.open(8);
    second = await fresh.open(8);
  }, OPEN_TIMEOUT);
  beforeEach(async () => {
    await first.db.delete(jobs);
  }, OPEN_TIMEOUT);

  it("never gives one job to two claimers", async () => {
    const total = 120;
    for (const bot of await seedBots(first.db, total))
      await enqueue(first.db, { kind: "chat.reply", botId: bot.id });
    const won = new Map<string, string>();
    const duplicates: string[] = [];
    async function worker(database: Database, owner: string) {
      for (;;) {
        const { jobs: batch } = await claim(database.db, owner, 3, 60_000);
        if (batch.length === 0) return;
        for (const job of batch) {
          if (won.has(job.id)) duplicates.push(job.id);
          won.set(job.id, owner);
        }
      }
    }
    await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        worker(index % 2 ? first : second, `worker-${index}`),
      ),
    );
    expect(duplicates).toEqual([]);
    expect(won.size).toBe(total);
    const rows = await first.db.select().from(jobs);
    for (const row of rows) {
      expect(row.status).toBe("running");
      expect(row.attempts).toBe(1);
      expect(row.leaseOwner).toBe(won.get(row.id));
    }
    // More than one claimer actually won work.
    expect(new Set(won.values()).size).toBeGreaterThan(1);
  });

  it("skips rows another claimer holds instead of waiting for them", async () => {
    const [botA, botB] = await seedBots(first.db, 2);
    const a = must(
      await enqueue(first.db, { kind: "chat.reply", botId: botA?.id }),
    );
    await sleep(5);
    const b = must(
      await enqueue(first.db, { kind: "chat.reply", botId: botB?.id }),
    );
    const holding = gate();
    const release = gate();
    // An open transaction holds the claim of the oldest job.
    const holder = first.db.transaction(async (tx) => {
      const held = await claim(tx, "slow", 1, 60_000);
      expect(held.jobs.map((job) => job.id)).toEqual([a.id]);
      holding.open();
      await release.promise;
    });
    await holding.promise;
    try {
      const other = claim(second.db, "fast", 5, 60_000);
      expect(await settlesWithin(other, 2_000)).toBe("settled");
      expect((await other).jobs.map((job) => job.id)).toEqual([b.id]);
    } finally {
      release.open();
      await holder;
    }
    expect((await jobRow(first, a.id))?.leaseOwner).toBe("slow");
  });

  it("lets a write-back that starts with a heartbeat finish before any reclaim", async () => {
    const [bot] = await seedBots(first.db, 1);
    const job = must(
      await enqueue(first.db, { kind: "chat.reply", botId: bot?.id }),
    );
    const { lease } = must((await claim(first.db, "owner", 1, 50)).jobs[0]);
    const holding = gate();
    const release = gate();
    const writeBack = first.db.transaction(async (tx) => {
      expect(await heartbeat(tx, lease, 50)).toBe(true);
      holding.open();
      await release.promise;
      expect(await complete(tx, lease)).toBe(true);
    });
    await holding.promise;
    try {
      // The lease has expired by now, but the write-back holds the row.
      await sleep(150);
      const rescue = claim(second.db, "rescuer", 5, 60_000);
      expect(await settlesWithin(rescue, 2_000)).toBe("settled");
      expect((await rescue).jobs).toEqual([]);
    } finally {
      release.open();
      await writeBack;
    }
    expect(await jobRow(first, job.id)).toMatchObject({
      status: "done",
      leaseOwner: "owner",
    });
  });

  it("keeps a coalesced wake unclaimable until the waker commits", async () => {
    const { task, sessions } = await seedSessions(first.db, 1);
    const sessionId = must(sessions[0]).id;
    const pending = must(
      await enqueue(first.db, {
        kind: "session.run",
        taskId: task.id,
        sessionId,
      }),
    );
    const enqueued = gate();
    const release = gate();
    const waker = first.db.transaction(async (tx) => {
      expect(
        await enqueue(tx, { kind: "session.run", taskId: task.id, sessionId }),
      ).toBeNull();
      enqueued.open();
      await release.promise;
    });
    await enqueued.promise;
    try {
      // Claimed now, the run could read the inbox before the waker's item is
      // visible and finish without it.
      expect(await claimIds(second, "worker")).toEqual([]);
    } finally {
      release.open();
      await waker;
    }
    expect(await claimIds(second, "worker")).toEqual([pending.id]);
  });

  it(
    "never runs a session twice and never loses a wake under concurrency",
    async () => {
      await wakeStress(first, second, {
        wakers: 3,
        wakes: 60,
        workers: 4,
        keys: 30,
      });
    },
    OPEN_TIMEOUT,
  );

  it(
    "never runs a bot's chat twice and never loses a message under concurrency",
    async () => {
      await chatStress(first, second, {
        wakers: 3,
        wakes: 60,
        workers: 4,
        keys: 30,
      });
    },
    OPEN_TIMEOUT,
  );
});
