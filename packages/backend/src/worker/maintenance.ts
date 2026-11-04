// The compaction job (`maintenance.compact`): one pass at a time for the
// whole instance (the queue keeps one queued and one running), every
// `compactionIntervalMs` while retention is on. A pass that stops at its
// budget with tasks left is followed by another soon, so a backlog drains a
// pass at a time without holding a worker slot for long.
import { type ClaimedJob, complete, type Executor, enqueue } from "@jj/db";
import type { EngineContext } from "../context";
import { errorMessage } from "../errors";
import { compactionPass } from "../services/retention";
import type { JobControl } from "./run-context";

/** The pause before the next pass when the last one left tasks to compact. */
export const COMPACTION_BACKLOG_DELAY_MS = 60_000;

/**
 * Queues a pass `delayMs` from now, unless one is queued already (it keeps
 * its time). Nothing while retention is off.
 */
export async function scheduleCompaction(
  exec: Executor,
  ctx: EngineContext,
  delayMs: number,
): Promise<void> {
  if (ctx.config.eventRetentionDays === 0) return;
  await enqueue(exec, {
    kind: "maintenance.compact",
    runAfter: new Date(Date.now() + delayMs),
  });
}

/**
 * Runs one pass, then ends the job and queues the next pass in one
 * transaction, fenced on the lease: a pass a crash or another worker took
 * over writes nothing more. A failed pass is logged and tried again at the
 * next interval.
 */
export async function runCompactionJob(
  ctx: EngineContext,
  job: ClaimedJob,
  control: JobControl,
): Promise<void> {
  let more = false;
  try {
    const pass = await compactionPass(ctx, {
      stop: () => control.controller.signal.aborted,
    });
    more = pass.more;
  } catch (error) {
    ctx.logger.warn(
      "A compaction pass failed; it runs again at the next interval",
      {
        error: errorMessage(error),
      },
    );
  }
  if (control.fenced) return;
  await ctx.db.transaction(async (tx) => {
    if (!(await complete(tx, job.lease))) return;
    await scheduleCompaction(
      tx,
      ctx,
      more ? COMPACTION_BACKLOG_DELAY_MS : ctx.config.compactionIntervalMs,
    );
  });
}
