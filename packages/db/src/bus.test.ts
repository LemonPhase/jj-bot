import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type ControlMessage,
  createBus,
  decodeMessage,
  encodeMessage,
  LISTENER_APPLICATION_NAME,
  notify,
  postgresListener,
  type TaskEventNotice,
  type WorkspaceHint,
} from "./bus";
import type { Database } from "./database";
import { appendEvent } from "./events";
import {
  cleanup,
  gate,
  OPEN_TIMEOUT,
  postgresTarget,
  postgresUrl,
  seedTask,
  sleep,
  targets,
  waitFor,
} from "./test-helpers";

afterAll(cleanup, OPEN_TIMEOUT);

describe("bus payloads", () => {
  it("round-trips each channel's wire format and rejects malformed payloads", () => {
    const notice = { taskId: "task_01ABC", sequence: 42 };
    expect(encodeMessage("jj_task_event", notice)).toBe("task_01ABC:42");
    expect(decodeMessage("jj_task_event", "task_01ABC:42")).toEqual(notice);
    const control: ControlMessage = {
      kind: "steer",
      taskId: "task_1",
      sessionId: "sess_1",
    };
    expect(
      decodeMessage("jj_control", encodeMessage("jj_control", control)),
    ).toEqual(control);
    const hint: WorkspaceHint = { kind: "conversation.changed", botId: "b" };
    expect(decodeMessage("jj_hint", encodeMessage("jj_hint", hint))).toEqual(
      hint,
    );
    expect(() => decodeMessage("jj_task_event", "task_1:0")).toThrow();
    expect(() => decodeMessage("jj_task_event", "nosequence")).toThrow();
    expect(() =>
      decodeMessage("jj_control", JSON.stringify({ kind: "explode" })),
    ).toThrow();
    expect(() => decodeMessage("jj_hint", "[]")).toThrow();
    expect(() =>
      encodeMessage("jj_task_event", { taskId: "a:b", sequence: 1 }),
    ).toThrow();
    expect(() =>
      encodeMessage("jj_hint", { kind: "big", text: "x".repeat(8000) }),
    ).toThrow("bytes");
    expect(() => encodeMessage("nope" as never, {} as never)).toThrow(
      "Unknown bus channel",
    );
  });
});

describe.each(targets)("bus on $name", (target) => {
  let database: Database;
  const errors: unknown[] = [];
  beforeAll(async () => {
    database = await (await target.fresh()).open(undefined, (error) =>
      errors.push(error),
    );
  }, OPEN_TIMEOUT);

  it("delivers a notification only after its transaction commits", async () => {
    const { db, bus } = database;
    const received: ControlMessage[] = [];
    const stop = await bus.subscribe("jj_control", (message) => {
      received.push(message);
    });
    try {
      const committed = gate();
      const sent = gate();
      const writer = db.transaction(async (tx) => {
        await bus.notify(tx, "jj_control", { kind: "wake", taskId: "t1" });
        sent.open();
        // Give a premature delivery every chance to arrive.
        await committed.promise;
      });
      await sent.promise;
      // On PGlite the transaction owns the only connection; on PostgreSQL the
      // listener is a separate connection. Either way nothing has arrived yet.
      await sleep(150);
      expect(received).toEqual([]);
      committed.open();
      await writer;
      await waitFor(() => received.length === 1);
      expect(received).toEqual([{ kind: "wake", taskId: "t1" }]);
    } finally {
      await stop();
    }
  });

  it("never delivers a notification from a rolled-back transaction", async () => {
    const { db, bus } = database;
    const received: string[] = [];
    const stop = await bus.subscribe("jj_hint", (message) => {
      received.push(message.kind);
    });
    try {
      await expect(
        db.transaction(async (tx) => {
          await bus.notify(tx, "jj_hint", { kind: "rolled.back" });
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      // A later committed notification on the same channel proves the
      // listener was live while the rolled-back one would have arrived.
      await db.transaction((tx) =>
        bus.notify(tx, "jj_hint", { kind: "committed" }),
      );
      await waitFor(() => received.length >= 1);
      await sleep(50);
      expect(received).toEqual(["committed"]);
    } finally {
      await stop();
    }
  });

  it("announces appended events as taskId:sequence", async () => {
    const { db, bus } = database;
    const task = await seedTask(db);
    const notices: TaskEventNotice[] = [];
    const stop = await bus.subscribe("jj_task_event", (notice) => {
      if (notice.taskId === task.id) notices.push(notice);
    });
    try {
      await db.transaction(async (tx) => {
        await appendEvent(tx, { taskId: task.id, type: "task.created" });
        await appendEvent(tx, { taskId: task.id, type: "task.status" });
      });
      await waitFor(() => notices.length === 2);
      expect(notices).toEqual([
        { taskId: task.id, sequence: 1 },
        { taskId: task.id, sequence: 2 },
      ]);
    } finally {
      await stop();
    }
  });

  it("fans out to every subscriber, stops after unsubscribe, and isolates failures", async () => {
    const { db, bus } = database;
    const first: string[] = [];
    const second: string[] = [];
    const stopFirst = await bus.subscribe("jj_hint", (hint) => {
      first.push(hint.kind);
    });
    const stopThrowing = await bus.subscribe("jj_hint", () => {
      throw new Error("handler bug");
    });
    const stopSecond = await bus.subscribe("jj_hint", (hint) => {
      second.push(hint.kind);
    });
    await notify(db, "jj_hint", { kind: "one" });
    await waitFor(() => first.length === 1 && second.length === 1);
    await stopFirst();
    await stopFirst(); // idempotent
    await notify(db, "jj_hint", { kind: "two" });
    await waitFor(() => second.length === 2);
    expect(first).toEqual(["one"]);
    expect(second).toEqual(["one", "two"]);
    await stopSecond();
    await stopThrowing();
    // Resubscribing after the last unsubscribe listens again.
    const again: string[] = [];
    const stopAgain = await bus.subscribe("jj_hint", (hint) => {
      again.push(hint.kind);
    });
    await notify(db, "jj_hint", { kind: "three" });
    await waitFor(() => again.length === 1);
    await stopAgain();
    // The throwing handler's errors (one per notification it saw) went to
    // onError; the other handlers still received every notification.
    expect(errors.map(String)).toEqual([
      "Error: handler bug",
      "Error: handler bug",
    ]);
    errors.length = 0;
  });

  it(
    "reports malformed payloads and handler errors to onError, not to handlers",
    async () => {
      const reported: unknown[] = [];
      const own = await (await target.fresh()).open(undefined, (error) =>
        reported.push(error),
      );
      try {
        const received: unknown[] = [];
        const stop = await own.bus.subscribe("jj_control", (message) => {
          received.push(message);
          throw new Error("handler bug");
        });
        await own.db.execute(sql`select pg_notify('jj_control', 'not json')`);
        await own.bus.notify(own.db, "jj_control", {
          kind: "cancel",
          taskId: "t",
        });
        await waitFor(() => received.length === 1 && reported.length === 2);
        expect(received).toEqual([{ kind: "cancel", taskId: "t" }]);
        expect(String(reported[1])).toContain("handler bug");
        await stop();
      } finally {
        await own.close();
      }
      await expect(own.bus.subscribe("jj_control", () => {})).rejects.toThrow(
        "closed",
      );
    },
    OPEN_TIMEOUT,
  );
});

describe.skipIf(!postgresUrl)("bus across PostgreSQL connections", () => {
  let sender: Database;
  let listener: Database;
  let url = "";
  const listenerErrors: unknown[] = [];
  beforeAll(async () => {
    const fresh = await postgresTarget.fresh();
    url = fresh.url ?? "";
    sender = await fresh.open(2);
    listener = await fresh.open(2, (error) => listenerErrors.push(error));
  }, OPEN_TIMEOUT);

  it("delivers a committed notification to another process's subscriber", async () => {
    const task = await seedTask(sender.db);
    const notices: TaskEventNotice[] = [];
    const stop = await listener.bus.subscribe("jj_task_event", (notice) => {
      notices.push(notice);
    });
    try {
      const committed = gate();
      const appended = gate();
      const writer = sender.db.transaction(async (tx) => {
        await appendEvent(tx, { taskId: task.id, type: "task.created" });
        appended.open();
        await committed.promise;
      });
      await appended.promise;
      await sleep(150);
      expect(notices).toEqual([]);
      committed.open();
      await writer;
      await waitFor(() => notices.length === 1);
      expect(notices).toEqual([{ taskId: task.id, sequence: 1 }]);
    } finally {
      await stop();
    }
  });

  it("re-listens after its connection is killed and tells subscribers to resync", async () => {
    const received: string[] = [];
    let resyncs = 0;
    const stopResync = listener.bus.onReconnect(() => {
      resyncs += 1;
    });
    const stop = await listener.bus.subscribe("jj_hint", (hint) => {
      received.push(hint.kind);
    });
    try {
      // Kill the listener's connection, as a server restart or network drop would.
      const killed = (await sender.db.execute(
        sql`select pg_terminate_backend(pid) as killed from pg_stat_activity
            where datname = current_database() and application_name = ${LISTENER_APPLICATION_NAME}`,
      )) as unknown as { rows: Array<{ killed: boolean }> };
      expect(killed.rows).toEqual([{ killed: true }]);
      await waitFor(() => resyncs === 1, 10_000);
      // The drop is reported, not thrown.
      expect(String(listenerErrors[0])).toContain("terminating connection");
      await notify(sender.db, "jj_hint", { kind: "after.reconnect" });
      await waitFor(() => received.includes("after.reconnect"), 5_000);
    } finally {
      stopResync();
      await stop();
    }
  });

  it("treats a missed ping as a dead connection, reconnects and listens again", async () => {
    const errors: unknown[] = [];
    const created: Client[] = [];
    let stall = false;
    const bus = createBus(
      postgresListener(url, (error) => errors.push(error), {
        pingIntervalMs: 40,
        pingTimeoutMs: 80,
        createClient(config) {
          const client = new Client(config);
          const stallable = created.length === 0;
          created.push(client);
          const query = client.query.bind(client) as (
            ...args: unknown[]
          ) => unknown;
          // A connection that stops answering, as a dead peer behind a
          // silent network would: its pings never return.
          (client as unknown as { query: unknown }).query = (
            ...args: unknown[]
          ) =>
            stallable && stall && args[0] === "SELECT 1"
              ? new Promise(() => {})
              : query(...args);
          return client;
        },
      }),
      (error) => errors.push(error),
    );
    let resyncs = 0;
    bus.onReconnect(() => {
      resyncs += 1;
    });
    const received: string[] = [];
    const stop = await bus.subscribe("jj_hint", (hint) => {
      received.push(hint.kind);
    });
    try {
      // Healthy pings keep the connection.
      await sleep(250);
      expect(resyncs).toBe(0);
      expect(created).toHaveLength(1);
      await notify(sender.db, "jj_hint", { kind: "before" });
      await waitFor(() => received.includes("before"));
      stall = true;
      await waitFor(() => resyncs === 1, 5_000);
      expect(created).toHaveLength(2);
      expect(String(errors[0])).toContain("ping timed out");
      await notify(sender.db, "jj_hint", { kind: "after" });
      await waitFor(() => received.includes("after"));
    } finally {
      await stop();
      await bus.close();
    }
  });
});
