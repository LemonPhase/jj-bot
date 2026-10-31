import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { type BackendStore, openStore, type StoreTx } from "./index";

const stores: BackendStore[] = [];
const directories: string[] = [];
async function memory() {
  const store = await openStore({ mode: "pglite", path: "memory://" });
  stores.push(store);
  return store;
}
afterEach(async () => {
  await Promise.all(stores.splice(0).map((store) => store.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("durable backend store", () => {
  it("preserves records and ordered events when a file-backed store reopens", async () => {
    const path = await mkdtemp(join(tmpdir(), "jj-store-"));
    directories.push(path);
    const first = await openStore({ mode: "pglite", path });
    await first.transaction(async (tx) => {
      await tx.put("tasks", "t1", { id: "t1", goal: "Persist me" });
      await tx.appendEvent({
        taskId: "t1",
        type: "task.created",
        payload: { goal: "Persist me" },
      });
    });
    await first.close();
    const second = await openStore({ mode: "pglite", path });
    stores.push(second);
    expect(await second.read((tx) => tx.get("tasks", "t1"))).toEqual({
      id: "t1",
      goal: "Persist me",
    });
    expect((await second.events("t1"))[0]?.sequence).toBe(1);
  }, 20_000);

  it("rolls back records and events together and accepts a later transaction", async () => {
    const store = await memory();
    await expect(
      store.transaction(async (tx) => {
        await tx.put("jobs", "j1", { status: "running" });
        await tx.appendEvent({
          taskId: "t1",
          type: "session.started",
          payload: {},
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await store.read((tx) => tx.get("jobs", "j1"))).toBeUndefined();
    expect(await store.events("t1")).toEqual([]);
    const event = await store.transaction((tx) =>
      tx.appendEvent({ taskId: "t1", type: "task.created", payload: {} }),
    );
    expect(event.sequence).toBe(1);
  });

  it("serializes competing claims and gives each task gap-free replay cursors", async () => {
    const store = await memory();
    await store.transaction((tx) => tx.put("jobs", "j1", { claimed: false }));
    const claims = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        store.transaction(async (tx) => {
          const job = await tx.get<{ claimed: boolean }>("jobs", "j1");
          if (job?.claimed) return false;
          await tx.put("jobs", "j1", { claimed: true, owner: index });
          return true;
        }),
      ),
    );
    expect(claims.filter(Boolean)).toHaveLength(1);
    await Promise.all(
      Array.from({ length: 10 }, () =>
        store.transaction((tx) =>
          tx.appendEvent({ taskId: "t1", type: "message.posted", payload: {} }),
        ),
      ),
    );
    await store.transaction((tx) =>
      tx.appendEvent({ taskId: "t2", type: "task.created", payload: {} }),
    );
    expect((await store.events("t1")).map((event) => event.sequence)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    expect(
      (await store.events("t1", 7)).map((event) => event.sequence),
    ).toEqual([8, 9, 10]);
    expect((await store.events("t2"))[0]?.sequence).toBe(1);
    await expect(store.events("t1", -1)).rejects.toThrow("cursor");
  });

  it("isolates collections, upserts and deletes records", async () => {
    const store = await memory();
    await store.transaction(async (tx) => {
      await tx.put("bots", "same", { name: "first" });
      await tx.put("tasks", "same", { goal: "other collection" });
      await tx.put("bots", "same", { name: "updated" });
    });
    expect(await store.read((tx) => tx.list("bots"))).toEqual([
      { name: "updated" },
    ]);
    await store.transaction((tx) => tx.delete("bots", "same"));
    expect(await store.read((tx) => tx.list("bots"))).toEqual([]);
    expect(await store.read((tx) => tx.get("tasks", "same"))).toEqual({
      goal: "other collection",
    });
  });

  it("refuses read-scope writes and use of expired transaction handles", async () => {
    const store = await memory();
    let expired: StoreTx | undefined;
    await store.read(async (tx) => {
      expired = tx;
    });
    await expect(expired?.list("bots")).rejects.toThrow("finished");
    await expect(store.read((tx) => tx.put("bots", "b", {}))).rejects.toThrow(
      "read-only",
    );
    await store.close();
    await expect(store.read((tx) => tx.list("bots"))).rejects.toThrow("closed");
  });
});

// Opt in against a disposable local/server PostgreSQL database; never read/log .env here.
describe.skipIf(!process.env.JJ_TEST_DATABASE_URL)(
  "PostgreSQL adapter integration",
  () => {
    it("serializes claims across connections, rolls back and replays after reopen", async () => {
      const connectionString = process.env.JJ_TEST_DATABASE_URL;
      const first = await openStore({ mode: "postgres", connectionString });
      const second = await openStore({ mode: "postgres", connectionString });
      stores.push(first, second);
      const collection = `integration-${Date.now()}`;
      const taskId = `${collection}-task`;
      await first.transaction((tx) =>
        tx.put(collection, "job", { claimed: false }),
      );
      const winners = await Promise.all(
        Array.from({ length: 8 }, (_, index) =>
          (index % 2 ? first : second).transaction(async (tx) => {
            const job = await tx.get<{ claimed: boolean }>(collection, "job");
            if (job?.claimed) return false;
            await tx.put(collection, "job", { claimed: true, owner: index });
            await tx.appendEvent({
              taskId,
              type: "session.started",
              payload: { owner: index },
            });
            return true;
          }),
        ),
      );
      expect(winners.filter(Boolean)).toHaveLength(1);
      await expect(
        second.transaction(async (tx) => {
          await tx.put(collection, "rollback", { incomplete: true });
          await tx.appendEvent({
            taskId,
            type: "message.posted",
            payload: { rolledBack: true },
          });
          throw new Error("expected rollback");
        }),
      ).rejects.toThrow("expected rollback");
      expect(
        await first.read((tx) => tx.get(collection, "rollback")),
      ).toBeUndefined();
      await Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          (index % 2 ? first : second).transaction((tx) =>
            tx.appendEvent({
              taskId,
              type: "message.posted",
              payload: { index },
            }),
          ),
        ),
      );
      expect(
        (await second.events(taskId)).map((event) => event.sequence),
      ).toEqual([1, 2, 3, 4, 5, 6, 7]);
      await first.close();
      const reopened = await openStore({ mode: "postgres", connectionString });
      stores.push(reopened);
      expect(
        (
          await reopened.read((tx) =>
            tx.get<{ claimed: boolean }>(collection, "job"),
          )
        )?.claimed,
      ).toBe(true);
      expect(
        (await reopened.events(taskId, 5)).map((event) => event.sequence),
      ).toEqual([6, 7]);
      await reopened.transaction((tx) => tx.delete(collection, "job"));
    }, 20_000);
  },
);
