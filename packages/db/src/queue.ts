import { and, asc, eq, inArray, lt, lte, or, type SQL, sql } from "drizzle-orm";
import { type AnyPgColumn, alias } from "drizzle-orm/pg-core";
import type { Executor } from "./database";
import { newId } from "./ids";
import { type JobKind, type JobRow, type JsonObject, jobs } from "./schema";

// Each operation is one SQL statement, except claim(), which first fails
// exhausted jobs and then claims. Pass the database for autocommit, or a
// transaction to make the job change atomic with other writes.

/** `last_error` of a job failed by claim() because its lease expired `max_attempts` times. */
export const LEASE_EXHAUSTED_ERROR = "lease expired too many times";

/**
 * One claim of one job. `attempt` is the claim's generation, so a runner whose
 * lease expired and was reclaimed (even by the same owner) is fenced out.
 */
export interface Lease {
  jobId: string;
  owner: string;
  attempt: number;
  kind: JobKind;
}

export type ClaimedJob = JobRow & { lease: Lease };

export interface ClaimResult {
  /** Jobs now leased to the caller, oldest `run_after` first. */
  jobs: ClaimedJob[];
  /**
   * Jobs whose lease expired after their last allowed attempt. claim() marked
   * them `failed` with `LEASE_EXHAUSTED_ERROR`; the caller fails their session
   * or chat visibly.
   */
  exhausted: JobRow[];
}

export interface EnqueueInput {
  kind: JobKind;
  taskId?: string | null;
  /** Required for `session.run`. */
  sessionId?: string | null;
  /** Required for `chat.reply`. */
  botId?: string | null;
  payload?: JsonObject;
  /** Not claimable before this time (database clock). Defaults to now. */
  runAfter?: Date;
  /** Claims allowed before an expired lease is no longer reclaimed. Default 3. */
  maxAttempts?: number;
  /** Defaults to a new `job_…` id. */
  id?: string;
}

function positiveInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw new RangeError(`${name} must be a positive integer.`);
}

const leaseExpiry = (leaseMs: number) =>
  sql`now() + ${leaseMs}::integer * interval '1 millisecond'`;

/**
 * Kinds that run one at a time per key: at most one queued and one running
 * job per session (`session.run`) or bot (`chat.reply`), enforced by the
 * partial unique indexes on `jobs`. A new kind must choose (null: no key).
 */
const SINGLE_RUN: Record<
  JobKind,
  { key: AnyPgColumn; keyName: "sessionId" | "botId"; pending: SQL } | null
> = {
  "session.run": {
    key: jobs.sessionId,
    keyName: "sessionId",
    pending: sql`${jobs.kind} = 'session.run' and ${jobs.status} = 'queued'`,
  },
  "chat.reply": {
    key: jobs.botId,
    keyName: "botId",
    pending: sql`${jobs.kind} = 'chat.reply' and ${jobs.status} = 'queued'`,
  },
};

/**
 * Insert a queued job. A `session.run` (or `chat.reply`) for a session (or
 * bot) that already has one queued is coalesced: nothing is inserted and the
 * result is null, because the pending job will see everything committed
 * before it runs. Enqueue in the transaction that records the work (the inbox
 * item or user message), never after it.
 *
 * Coalescing row-locks the pending job until the caller commits, so it cannot
 * be claimed (and its inbox read) before the new work is visible. A plain
 * ON CONFLICT DO NOTHING would leave that window open and could lose a wake.
 */
export async function enqueue(
  exec: Executor,
  job: EnqueueInput,
): Promise<JobRow | null> {
  const id = job.id ?? newId("job");
  if (job.maxAttempts !== undefined)
    positiveInteger(job.maxAttempts, "maxAttempts");
  const insert = exec.insert(jobs).values({
    id,
    kind: job.kind,
    taskId: job.taskId ?? null,
    sessionId: job.sessionId ?? null,
    botId: job.botId ?? null,
    payload: job.payload ?? {},
    ...(job.runAfter ? { runAfter: job.runAfter } : {}),
    ...(job.maxAttempts !== undefined ? { maxAttempts: job.maxAttempts } : {}),
  });
  const single = SINGLE_RUN[job.kind];
  const [row] = single
    ? await insert
        .onConflictDoUpdate({
          target: single.key,
          targetWhere: single.pending,
          // A no-op write whose only purpose is the row lock described above.
          set: { updatedAt: sql`${jobs.updatedAt}` },
        })
        .returning()
    : await insert.returning();
  if (!row) throw new Error("The job insert returned no row.");
  return row.id === id ? row : null;
}

/**
 * Claim up to `limit` jobs for `owner` with a lease of `leaseMs`. Claims due
 * queued jobs, and running jobs whose lease expired and that have attempts
 * left (their owner is presumed dead). Rows are locked with
 * `FOR UPDATE SKIP LOCKED`, so concurrent claimers never take the same job and
 * never wait on each other. A queued `session.run` (or `chat.reply`) whose
 * session (or bot) already has one running is skipped until that run ends.
 * Each claim increments `attempts`, the lease generation. Expired jobs without
 * attempts left are failed first and returned as `exhausted`.
 */
export async function claim(
  exec: Executor,
  owner: string,
  limit: number,
  leaseMs: number,
): Promise<ClaimResult> {
  if (!owner) throw new Error("A lease owner is required.");
  positiveInteger(limit, "Claim limit");
  positiveInteger(leaseMs, "Lease duration");

  const expired = and(
    eq(jobs.status, "running"),
    lt(jobs.leaseUntil, sql`now()`),
  );
  const exhaustedIds = exec
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(expired, sql`${jobs.attempts} >= ${jobs.maxAttempts}`))
    .for("update", { skipLocked: true });
  const exhausted = await exec
    .update(jobs)
    .set({
      status: "failed",
      leaseUntil: null,
      lastError: LEASE_EXHAUSTED_ERROR,
      updatedAt: sql`now()`,
    })
    .where(inArray(jobs.id, exhaustedIds))
    .returning();

  // A queued single-run job waits while its key has a running job, so the
  // running unique index can never make this statement fail.
  const running = alias(jobs, "running_job");
  const waitsForRun = (Object.keys(SINGLE_RUN) as JobKind[]).flatMap((kind) => {
    const single = SINGLE_RUN[kind];
    if (!single) return [];
    const runningOfKey = exec
      .select({ one: sql`1` })
      .from(running)
      .where(
        and(
          eq(running.kind, kind),
          eq(running.status, "running"),
          eq(running[single.keyName], jobs[single.keyName]),
        ),
      );
    return [sql`not (${jobs.kind} = ${kind} and exists ${runningOfKey})`];
  });
  const claimable = exec
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      or(
        and(
          eq(jobs.status, "queued"),
          lte(jobs.runAfter, sql`now()`),
          ...waitsForRun,
        ),
        and(expired, sql`${jobs.attempts} < ${jobs.maxAttempts}`),
      ),
    )
    .orderBy(asc(jobs.runAfter), asc(jobs.id))
    .limit(limit)
    .for("update", { skipLocked: true });
  const claimed = await exec
    .update(jobs)
    .set({
      status: "running",
      leaseOwner: owner,
      leaseUntil: leaseExpiry(leaseMs),
      attempts: sql`${jobs.attempts} + 1`,
      updatedAt: sql`now()`,
    })
    .where(inArray(jobs.id, claimable))
    .returning();
  claimed.sort(
    (a, b) =>
      a.runAfter.getTime() - b.runAfter.getTime() ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return {
    jobs: claimed.map((job) => ({ ...job, lease: leaseOf(job) })),
    exhausted,
  };
}

/** The lease of a claimed (running) job row. */
export function leaseOf(job: JobRow): Lease {
  if (job.status !== "running" || !job.leaseOwner)
    throw new Error(`Job ${job.id} is not leased.`);
  return {
    jobId: job.id,
    owner: job.leaseOwner,
    attempt: job.attempts,
    kind: job.kind,
  };
}

/**
 * Extend the lease. Returns false when it is no longer held (reclaimed, even
 * by the same owner, finished or cancelled); the caller must then stop and
 * write nothing. Called with a transaction, it also row-locks the job until
 * commit, so a write-back that starts with a successful heartbeat cannot
 * interleave with a reclaim.
 */
export async function heartbeat(
  exec: Executor,
  lease: Lease,
  leaseMs: number,
): Promise<boolean> {
  positiveInteger(leaseMs, "Lease duration");
  const rows = await exec
    .update(jobs)
    .set({ leaseUntil: leaseExpiry(leaseMs), updatedAt: sql`now()` })
    .where(held(lease))
    .returning({ id: jobs.id });
  return rows.length > 0;
}

/** Mark the leased job done. Returns false when the lease is no longer held. */
export async function complete(exec: Executor, lease: Lease): Promise<boolean> {
  const rows = await exec
    .update(jobs)
    .set({ status: "done", leaseUntil: null, updatedAt: sql`now()` })
    .where(held(lease))
    .returning({ id: jobs.id });
  return rows.length > 0;
}

/**
 * Record a failure of the leased job. Returns false when the lease is no
 * longer held. With `retryAt` the job is queued again (no owner) and becomes
 * claimable at that time; without it the job is failed. `session.run` and
 * `chat.reply` are never requeued, since a requeued job would collide with a
 * wake that is already pending: fail or complete them and enqueue a new one.
 */
export async function fail(
  exec: Executor,
  lease: Lease,
  error: string,
  retryAt?: Date,
): Promise<boolean> {
  if (retryAt && SINGLE_RUN[lease.kind])
    throw new Error(
      `${lease.kind} jobs are not requeued; fail the job and enqueue a new one.`,
    );
  const rows = await exec
    .update(jobs)
    .set(
      retryAt
        ? {
            status: "queued",
            runAfter: retryAt,
            leaseOwner: null,
            leaseUntil: null,
            lastError: error,
            updatedAt: sql`now()`,
          }
        : {
            status: "failed",
            leaseUntil: null,
            lastError: error,
            updatedAt: sql`now()`,
          },
    )
    .where(held(lease))
    .returning({ id: jobs.id });
  return rows.length > 0;
}

/**
 * Cancel every queued job of a task (or of a session). Running jobs are left to
 * their owners, which observe the cancellation and stop. Returns the cancelled ids.
 */
export async function cancelWhere(
  exec: Executor,
  filter: { taskId: string } | { sessionId: string },
): Promise<string[]> {
  const target =
    "taskId" in filter
      ? eq(jobs.taskId, filter.taskId)
      : eq(jobs.sessionId, filter.sessionId);
  const rows = await exec
    .update(jobs)
    .set({ status: "cancelled", updatedAt: sql`now()` })
    .where(and(target, eq(jobs.status, "queued")))
    .returning({ id: jobs.id });
  return rows.map((row) => row.id);
}

function held(lease: Lease) {
  return and(
    eq(jobs.id, lease.jobId),
    eq(jobs.leaseOwner, lease.owner),
    eq(jobs.attempts, lease.attempt),
    eq(jobs.status, "running"),
  );
}
