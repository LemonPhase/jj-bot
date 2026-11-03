import { eq, lt, sql } from "drizzle-orm";
import type { Executor } from "./database";
import { workerHeartbeats } from "./schema";

// Worker heartbeats (`worker_heartbeats`): one row per live job loop,
// written with the database clock so processes on other hosts agree on age.

const ago = (ms: number) =>
  sql`now() - ${Math.max(0, Math.floor(ms))}::integer * interval '1 millisecond'`;

/** Records that `workerId`'s claim loop just passed. */
export async function recordWorkerHeartbeat(
  exec: Executor,
  workerId: string,
): Promise<void> {
  await exec
    .insert(workerHeartbeats)
    .values({ workerId })
    .onConflictDoUpdate({
      target: workerHeartbeats.workerId,
      set: { seenAt: sql`now()` },
    });
}

/** Removes `workerId`'s row: it stopped. */
export async function removeWorkerHeartbeat(
  exec: Executor,
  workerId: string,
): Promise<void> {
  await exec
    .delete(workerHeartbeats)
    .where(eq(workerHeartbeats.workerId, workerId));
}

/** Deletes rows not seen for `olderThanMs`: workers that crashed long ago. */
export async function pruneWorkerHeartbeats(
  exec: Executor,
  olderThanMs: number,
): Promise<number> {
  const removed = await exec
    .delete(workerHeartbeats)
    .where(lt(workerHeartbeats.seenAt, ago(olderThanMs)))
    .returning({ workerId: workerHeartbeats.workerId });
  return removed.length;
}

export interface WorkerHeartbeatStatus {
  /** Workers seen within `freshMs`. */
  fresh: number;
  /** How long ago the most recently seen worker was seen; null when none ever was. */
  newestAgeMs: number | null;
}

/** The heartbeats as of the database's clock. */
export async function workerHeartbeatStatus(
  exec: Executor,
  freshMs: number,
): Promise<WorkerHeartbeatStatus> {
  const [row] = await exec
    .select({
      fresh: sql<number>`count(*) filter (where ${workerHeartbeats.seenAt} > ${ago(freshMs)})`,
      newestAgeMs: sql<
        number | null
      >`extract(epoch from (now() - max(${workerHeartbeats.seenAt}))) * 1000`,
    })
    .from(workerHeartbeats);
  return {
    fresh: Number(row?.fresh ?? 0),
    newestAgeMs:
      row?.newestAgeMs === null || row?.newestAgeMs === undefined
        ? null
        : Math.max(0, Math.round(Number(row.newestAgeMs))),
  };
}
