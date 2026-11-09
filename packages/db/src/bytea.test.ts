// Binary values on PGlite take milliseconds, not seconds: a 16 MiB bytea
// written and read back must not hold the event loop, which serves every
// request and run of the process (PGlite's own codec held it for seconds).
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Database, openDatabase } from "./database";
import { artifacts, stagedUploads } from "./schema";
import { seedTask } from "./test-helpers";

/** Far above the fast path (a few hundred ms on a loaded machine), far below PGlite's own codec (5 s and more). */
const STALL_BOUND_MS = 2_000;

let database: Database;

beforeAll(async () => {
  database = await openDatabase({ mode: "pglite", onError: () => {} });
}, 60_000);
afterAll(async () => {
  await database?.close();
});

/** The longest the event loop was held while `fn` ran, in ms: the widest gap between ticks of a 10 ms timer. */
async function stall<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; ms: number }> {
  let last = performance.now();
  let widest = 0;
  const timer = setInterval(() => {
    const now = performance.now();
    widest = Math.max(widest, now - last);
    last = now;
  }, 10);
  try {
    const value = await fn();
    // Let the timer fire once more, so a hold that lasted to the end counts.
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { value, ms: widest };
  } finally {
    clearInterval(timer);
  }
}

describe("bytea on PGlite", () => {
  it("writes and reads 16 MiB without holding the event loop", async () => {
    const content = Buffer.alloc(16 * 1024 * 1024);
    for (let index = 0; index < content.length; index += 4096)
      content[index] = index % 251;
    const now = new Date();
    const written = await stall(() =>
      database.db.insert(stagedUploads).values({
        id: "upl_bytea_stall",
        name: "big.bin",
        contentType: "application/octet-stream",
        sizeBytes: content.length,
        sha256: "0".repeat(64),
        content,
        createdAt: now,
        expiresAt: new Date(now.getTime() + 60_000),
      }),
    );
    expect(written.ms).toBeLessThan(STALL_BOUND_MS);
    const read = await stall(() =>
      database.db
        .select({ content: stagedUploads.content })
        .from(stagedUploads)
        .where(eq(stagedUploads.id, "upl_bytea_stall")),
    );
    expect(read.ms).toBeLessThan(STALL_BOUND_MS);
    const [row] = read.value;
    expect(row?.content).toBeInstanceOf(Uint8Array);
    expect(Buffer.compare(Buffer.from(row?.content ?? []), content)).toBe(0);
    console.info(
      `16 MiB bytea on PGlite: the write held the loop ${Math.round(written.ms)} ms, the read ${Math.round(read.ms)} ms`,
    );
  }, 120_000);

  it("writes and reads an artifact's content, as snapshots and spills do, without holding the event loop", async () => {
    const task = await seedTask(database.db);
    const content = Buffer.alloc(16 * 1024 * 1024, 3);
    const written = await stall(() =>
      database.db.insert(artifacts).values({
        id: "art_bytea_stall",
        taskId: task.id,
        kind: "output",
        path: "output/big.txt",
        name: "big.txt",
        contentType: "text/plain",
        sizeBytes: content.length,
        sha256: "0".repeat(64),
        content,
      }),
    );
    expect(written.ms).toBeLessThan(STALL_BOUND_MS);
    const read = await stall(() =>
      database.db
        .select({ content: artifacts.content })
        .from(artifacts)
        .where(eq(artifacts.id, "art_bytea_stall")),
    );
    expect(read.ms).toBeLessThan(STALL_BOUND_MS);
    expect(read.value[0]?.content.byteLength).toBe(content.length);
  }, 120_000);

  it("keeps empty and small values exact", async () => {
    for (const [id, bytes] of [
      ["upl_bytea_empty", new Uint8Array()],
      ["upl_bytea_small", new Uint8Array([0, 1, 127, 128, 254, 255])],
    ] as const) {
      const now = new Date();
      await database.db.insert(stagedUploads).values({
        id,
        name: "a.bin",
        contentType: "application/octet-stream",
        sizeBytes: bytes.length,
        sha256: "0".repeat(64),
        content: bytes,
        createdAt: now,
        expiresAt: now,
      });
      const [row] = await database.db
        .select({ content: stagedUploads.content })
        .from(stagedUploads)
        .where(eq(stagedUploads.id, id));
      expect([...(row?.content ?? [])]).toEqual([...bytes]);
    }
  });
});
