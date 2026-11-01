// Who holds a task's ephemeral sandbox. An ephemeral workspace exists only in
// the sandbox of the worker that created it, so that worker records itself on
// the task with a short lease it refreshes while it holds the sandbox. Other
// workers hand the task's sessions back while the lease is live, and fail them
// visibly once it is gone.
import { type Tx, tasks } from "@jj/db";
import { and, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import type { EngineContext } from "../context";

const until = (ctx: EngineContext) =>
  sql`now() + ${ctx.config.leaseMs}::integer * interval '1 millisecond'`;

/** Records this worker as the holder, unless another live holder exists. */
export async function claimHolder(ctx: EngineContext, taskId: string) {
  await ctx.db
    .update(tasks)
    .set({ sandboxHolder: ctx.config.workerId, sandboxHolderUntil: until(ctx) })
    .where(
      and(
        eq(tasks.id, taskId),
        or(
          isNull(tasks.sandboxHolder),
          eq(tasks.sandboxHolder, ctx.config.workerId),
          lt(tasks.sandboxHolderUntil, sql`now()`),
        ),
      ),
    );
}

/** Extends this worker's holder leases (called from the heartbeat tick). */
export async function refreshHolders(ctx: EngineContext, taskIds: string[]) {
  if (taskIds.length === 0) return;
  await ctx.db
    .update(tasks)
    .set({ sandboxHolderUntil: until(ctx) })
    .where(
      and(
        inArray(tasks.id, [...taskIds].sort()),
        eq(tasks.sandboxHolder, ctx.config.workerId),
      ),
    );
}

/** Clears this worker's holder record when it releases the sandbox. */
export async function releaseHolder(ctx: EngineContext, taskId: string) {
  await ctx.db
    .update(tasks)
    .set({ sandboxHolder: null, sandboxHolderUntil: null })
    .where(
      and(eq(tasks.id, taskId), eq(tasks.sandboxHolder, ctx.config.workerId)),
    );
}

/** Another worker holds the task's ephemeral sandbox and its lease is live. */
export async function heldByAnotherWorker(
  tx: Tx,
  taskId: string,
  workerId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(
      and(
        eq(tasks.id, taskId),
        ne(tasks.sandboxHolder, workerId),
        sql`${tasks.sandboxHolderUntil} > now()`,
      ),
    );
  return row !== undefined;
}
