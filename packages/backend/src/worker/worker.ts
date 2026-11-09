// The job loop: claims up to `concurrency` jobs, heartbeats their leases,
// aborts runs on stop requests, recovers what a crashed worker left, and
// drains: stops claiming and lets running sessions reach a turn boundary.
// Waiting sessions hold no job, so they never take a slot.
import { isFinishedStatus } from "@jj/contracts";
import {
  type ClaimedJob,
  claim,
  complete,
  enqueue,
  heartbeat,
  type JobKind,
  pruneWorkerHeartbeats,
  recordWorkerHeartbeat,
  releaseLease,
  removeWorkerHeartbeat,
  sessions,
  tasks,
  type Unsubscribe,
} from "@jj/db";
import { eq, inArray } from "drizzle-orm";
import type { EngineContext } from "../context";
import { errorMessage } from "../errors";
import { withLogFields } from "../observability/logger";
import type { ChatResponder, RunExecutor } from "../ports";
import { sweepStagedUploads } from "../services/uploads";
import { snapshotFinishedTask } from "./artifacts";
import { runChatJob } from "./chat-reply";
import { refreshHolders, releaseHolder } from "./holders";
import { runCompactionJob, scheduleCompaction } from "./maintenance";
import { runDiscoveryJob } from "./mcp-discovery";
import { handleExhausted } from "./recovery";
import { type AbortReason, JobControl } from "./run-context";
import { TaskSandboxes } from "./sandboxes";
import { runSessionJob } from "./session-run";

interface ActiveJob {
  job: ClaimedJob;
  control: JobControl;
  done: Promise<void>;
}

/** Jobs that every free slot may take. */
const WORK_KINDS: readonly JobKind[] = [
  "session.run",
  "chat.reply",
  "maintenance.compact",
];
/** Jobs that take at most `maxConcurrentDiscoveries` slots. */
const DISCOVERY_KINDS: readonly JobKind[] = ["mcp.discover"];

/** How often a polling worker records its heartbeat row (`worker_heartbeats`). */
export const WORKER_HEARTBEAT_MS = 5_000;
/** How often the worker deletes staged uploads past their time. */
const STAGED_SWEEP_MS = 60_000;
/** Heartbeat rows older than this belong to workers long gone and are deleted at start. */
const STALE_HEARTBEAT_MS = 24 * 60 * 60 * 1000;

export interface Worker {
  /** Reaps driver orphans, then claims and runs jobs until stopped. */
  start(): Promise<void>;
  /**
   * Graceful stop: no new claims, running jobs aborted and handed to the next
   * worker (their sessions resume from the last completed turn), sandboxes
   * released. Resolves once all of that is done.
   */
  stop(): Promise<void>;
  /**
   * Graceful drain, then `stop`. No new claims, while leases are kept and
   * stop requests still apply; each running session stops at its next turn
   * boundary, handed back as `stop` hands it back, and a chat reply runs to
   * its end. What still runs after `timeoutMs` is interrupted as a lost
   * lease is: fenced, so it writes nothing more, and its lease released once
   * it has stopped (`releaseLease`, which costs the job no attempt), so the
   * next worker reclaims it at once and resumes its session from the last
   * completed turn. Then sandboxes are released.
   * Resolves once all of that is done.
   */
  drain(timeoutMs: number): Promise<void>;
  /**
   * Stops at once, as a crash would: every run is fenced first, so none starts
   * a new write (one already open, and a claim pass in flight, still commit),
   * leases are left to expire and another worker reclaims the runs. For tests
   * and fatal exits.
   */
  abandon(): Promise<void>;
  /** From the start of a drain until the worker has stopped. */
  readonly draining: boolean;
  /** Jobs currently running in this worker. */
  readonly activeJobs: number;
  /**
   * When the job loop last finished a claim pass; null before `start()` and
   * after a stop. A stale value means the loop is stuck or the database is
   * failing, so readiness checks use it as the worker's heartbeat.
   */
  readonly lastPollAt: Date | null;
}

export function createWorker(
  ctx: EngineContext,
  executor: RunExecutor,
  chat: ChatResponder,
): Worker {
  const sandboxes = new TaskSandboxes(ctx, {
    // A crash writes nothing, the final snapshot included.
    onFinished: async (taskId, sandbox, secrets) => {
      // Built before any transaction: it reads the stored secrets.
      const redact = await ctx.redactor(secrets);
      await snapshotFinishedTask(
        ctx,
        (fn) =>
          crashing
            ? Promise.reject(new Error("The worker stopped like a crash."))
            : ctx.db.transaction(fn),
        taskId,
        sandbox,
        (text) => redact(text),
      );
    },
    onRelease: (taskId, spec) => {
      if (spec.workspace !== "ephemeral") return;
      void releaseHolder(ctx, taskId).catch((error: unknown) =>
        ctx.logger.warn(`Clearing the sandbox holder of ${taskId} failed`, {
          error: errorMessage(error),
        }),
      );
    },
  });
  // Every redactor of this worker covers the values its sandboxes hold.
  ctx.heldSecrets = () => sandboxes.heldSecrets();
  const deps = { ctx, sandboxes };
  const active = new Map<string, ActiveJob>();
  const timers: NodeJS.Timeout[] = [];
  const unsubscribers: Unsubscribe[] = [];
  let started = false;
  let stopping = false;
  /** Claims nothing more; running jobs go on to a turn boundary (`drain`). */
  let draining = false;
  let drained: Promise<void> | undefined;
  let pumping = false;
  let again = false;
  let crashing = false;
  let lastPollAt: Date | null = null;
  let lastBeatAt = 0;

  const abortWhere = (
    match: (job: ClaimedJob) => boolean,
    reason: AbortReason,
  ) => {
    for (const entry of active.values())
      if (match(entry.job)) entry.control.abort(reason);
  };

  function launch(job: ClaimedJob) {
    const control = new JobControl();
    // Every line the job logs carries its ids (the run's is added once known),
    // and only its own: whatever context woke the loop is left behind.
    const run = withLogFields(
      {
        jobId: job.id,
        ...(job.botId ? { botId: job.botId } : {}),
        ...(job.taskId ? { taskId: job.taskId } : {}),
        ...(job.sessionId ? { sessionId: job.sessionId } : {}),
      },
      () =>
        (job.kind === "session.run"
          ? runSessionJob(deps, executor, job, control)
          : job.kind === "chat.reply"
            ? runChatJob(deps, chat, job, control)
            : job.kind === "mcp.discover"
              ? runDiscoveryJob(deps, job, control)
              : runCompactionJob(ctx, job, control)
        ).catch((error: unknown) => {
          ctx.logger.error(`Job ${job.id} (${job.kind}) failed unexpectedly`, {
            error: errorMessage(error),
          });
        }),
      true,
    );
    const entry: ActiveJob = {
      job,
      control,
      done: run.finally(() => {
        active.delete(job.id);
        if (!stopping && !draining) void pump();
      }),
    };
    active.set(job.id, entry);
  }

  /** A job claimed while stopping or draining goes straight back to the queue. */
  async function handBack(job: ClaimedJob) {
    if (crashing) return;
    await ctx.db
      .transaction(async (tx) => {
        if (!(await complete(tx, job.lease))) return;
        await enqueue(tx, {
          kind: job.kind,
          taskId: job.taskId,
          sessionId: job.sessionId,
          botId: job.botId,
          payload: job.payload,
        });
      })
      .catch((error: unknown) =>
        ctx.logger.warn(`Returning job ${job.id} to the queue failed`, {
          error: errorMessage(error),
        }),
      );
  }

  /**
   * A claim pass, outside whatever scope asked for it (a request's wake, a
   * job's end): its lines and the jobs it launches carry no one else's ids.
   */
  const pump = (): Promise<void> => withLogFields({}, claimPass, true);

  async function claimPass(): Promise<void> {
    if (stopping || draining) return;
    if (pumping) {
      again = true;
      return;
    }
    pumping = true;
    try {
      do {
        again = false;
        while (!stopping && !draining && active.size < ctx.config.concurrency) {
          // Discoveries take at most their own slots, which leave session
          // runs and chat replies at least `concurrency - 1`. With slots to
          // spare a waiting discovery goes first, so steady chat never
          // starves it; with one slot, once it has waited
          // `discoveryMaxWaitMs`, or when nothing else waits.
          const free = ctx.config.concurrency - active.size;
          const discovering = [...active.values()].filter(
            (entry) => entry.job.kind === "mcp.discover",
          ).length;
          const room = Math.min(
            free,
            ctx.config.maxConcurrentDiscoveries - discovering,
          );
          const single = ctx.config.concurrency === 1;
          const first =
            room > 0
              ? await claimOf(
                  room,
                  DISCOVERY_KINDS,
                  single ? ctx.config.discoveryMaxWaitMs : undefined,
                )
              : 0;
          const work =
            free > first && !stopping && !draining
              ? await claimOf(free - first, WORK_KINDS)
              : 0;
          const idle =
            single && room > first && work === 0 && !stopping && !draining
              ? await claimOf(room - first, DISCOVERY_KINDS)
              : 0;
          if (first + work + idle === 0) break;
        }
      } while (again && !stopping && !draining);
      if (!stopping && !draining) {
        lastPollAt = new Date();
        await beat();
      }
    } catch (error) {
      ctx.logger.warn("Claiming jobs failed; retrying at the next poll", {
        error: errorMessage(error),
      });
    } finally {
      pumping = false;
    }
  }

  /**
   * Claims up to `limit` jobs of `kinds` (queued ones due for at least
   * `waitedMs`, when given) and launches them; returns how many it claimed.
   */
  async function claimOf(
    limit: number,
    kinds: readonly JobKind[],
    waitedMs?: number,
  ): Promise<number> {
    // Never its own runs: a stall that held their heartbeats past the
    // lease leaves them alive, not abandoned.
    const { jobs, exhausted } = await claim(
      ctx.db,
      ctx.config.workerId,
      limit,
      ctx.config.leaseMs,
      {
        running: [...active.keys()],
        kinds,
        ...(waitedMs !== undefined ? { waitedMs } : {}),
      },
    );
    for (const job of exhausted) {
      const result = await handleExhausted(ctx, job).catch((error: unknown) => {
        ctx.logger.error(`Recovering job ${job.id} failed`, {
          error: errorMessage(error),
        });
        return {} as { finishedTaskId?: string };
      });
      if (result.finishedTaskId) sandboxes.finish(result.finishedTaskId);
    }
    for (const job of jobs) {
      // The first claim: how long the job waited once it was due.
      if (job.attempts === 1)
        ctx.metrics.claimed(
          job.kind,
          (job.updatedAt.getTime() - job.runAfter.getTime()) / 1000,
        );
      if (stopping || draining) await handBack(job);
      else launch(job);
    }
    return jobs.length;
  }

  /**
   * Records this worker in `worker_heartbeats` at most every
   * `WORKER_HEARTBEAT_MS`, after a claim pass: an API without an embedded
   * worker is ready only while some worker's row is fresh.
   */
  async function beat() {
    if (!ctx.config.workerHeartbeat) return;
    const now = Date.now();
    if (now - lastBeatAt < WORKER_HEARTBEAT_MS) return;
    lastBeatAt = now;
    await recordWorkerHeartbeat(ctx.db, ctx.config.workerId).catch(
      (error: unknown) =>
        ctx.logger.warn("Recording the worker heartbeat failed", {
          error: errorMessage(error),
        }),
    );
  }

  /** Extends every lease, and stops runs whose task or parent is gone (durable cancellation). */
  async function tick() {
    if (stopping) return;
    await refreshHolders(ctx, sandboxes.heldEphemeral()).catch(() => {});
    for (const entry of [...active.values()]) {
      const held = await heartbeat(
        ctx.db,
        entry.job.lease,
        ctx.config.leaseMs,
      ).catch(() => true);
      if (!held) entry.control.abort("lease-lost");
    }
    const running = [...active.values()].filter(
      (entry) => entry.job.kind === "session.run" && entry.job.sessionId,
    );
    if (running.length === 0) return;
    const rows = await ctx.db
      .select({
        id: sessions.id,
        parentSessionId: sessions.parentSessionId,
        status: sessions.status,
        taskStatus: tasks.status,
        cancelRequestedAt: tasks.cancelRequestedAt,
      })
      .from(sessions)
      .innerJoin(tasks, eq(tasks.id, sessions.taskId))
      .where(
        inArray(
          sessions.id,
          running.map((entry) => entry.job.sessionId as string),
        ),
      )
      .catch(() => []);
    const parents = rows.flatMap((row) =>
      row.parentSessionId ? [row.parentSessionId] : [],
    );
    const parentRows =
      parents.length > 0
        ? await ctx.db
            .select({ id: sessions.id, status: sessions.status })
            .from(sessions)
            .where(inArray(sessions.id, parents))
            .catch(() => [])
        : [];
    for (const row of rows) {
      const parent = parentRows.find(
        (entry) => entry.id === row.parentSessionId,
      );
      if (
        row.cancelRequestedAt ||
        isFinishedStatus(row.taskStatus) ||
        isFinishedStatus(row.status) ||
        (parent && isFinishedStatus(parent.status))
      )
        abortWhere((job) => job.sessionId === row.id, "cancel");
    }
  }

  async function onControl(message: {
    kind: string;
    taskId: string;
    sessionId?: string;
  }) {
    if (message.kind === "wake") return void pump();
    if (message.kind === "cancel") {
      abortWhere(
        (job) =>
          job.taskId === message.taskId &&
          (!message.sessionId || job.sessionId === message.sessionId),
        "cancel",
      );
      // A stop that finished elsewhere (nothing ran here) still frees this worker's sandbox.
      if (!message.sessionId) {
        const [task] = await ctx.db
          .select({ status: tasks.status })
          .from(tasks)
          .where(eq(tasks.id, message.taskId));
        if (task && isFinishedStatus(task.status))
          sandboxes.finish(message.taskId);
      }
    }
    // `steer` needs nothing here: the executor drains the inbox at every turn
    // boundary, and the run's end drains it once more.
  }

  async function reapOrphans() {
    for (const driver of ctx.drivers.all()) {
      if (!driver.reapOrphans) continue;
      try {
        const { removed } = await driver.reapOrphans();
        if (removed.length > 0)
          ctx.logger.info(
            `Removed ${removed.length} orphaned ${driver.id} sandbox(es)`,
            { removed },
          );
      } catch (error) {
        ctx.logger.warn(`Reaping orphaned ${driver.id} sandboxes failed`, {
          error: errorMessage(error),
        });
      }
    }
  }

  /**
   * Stops claiming, lets running jobs reach a turn boundary or their end for
   * up to `timeoutMs`, interrupts the rest as a lost lease, then stops.
   */
  async function drainThenStop(timeoutMs: number) {
    if (!started || stopping) return;
    // From here no job is launched (a claim pass in flight hands back what
    // it claims), so these are all the jobs left to finish.
    draining = true;
    const running = [...active.values()];
    for (const entry of running) entry.control.draining = true;
    // The loop no longer polls, which readiness reports.
    lastPollAt = null;
    while (pumping) await new Promise((resolve) => setTimeout(resolve, 5));
    // An API without an embedded worker no longer counts this one as polling.
    if (ctx.config.workerHeartbeat)
      await removeWorkerHeartbeat(ctx.db, ctx.config.workerId).catch(
        (error: unknown) =>
          ctx.logger.warn("Removing the worker heartbeat failed", {
            error: errorMessage(error),
          }),
      );
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(running.map((entry) => entry.done)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
    clearTimeout(timer);
    const interrupted = [...active.values()];
    if (interrupted.length > 0) {
      ctx.logger.warn(
        `The drain timed out after ${timeoutMs} ms: interrupting ${interrupted.length} job(s) as a lost lease does; the next worker resumes them`,
        { jobIds: interrupted.map((entry) => entry.job.id) },
      );
      for (const entry of interrupted) entry.control.abort("lease-lost");
    }
    await shutDown("shutdown");
    // Only now, with each job stopped, so no write-back can follow: the next
    // claim finds these leases expired, as after a crash, without waiting,
    // and the interruption costs none of the job's attempts.
    for (const entry of interrupted)
      await releaseLease(ctx.db, entry.job.lease).catch((error: unknown) =>
        ctx.logger.warn(
          `Releasing the lease of job ${entry.job.id} failed; it is reclaimed once the lease runs out`,
          { error: errorMessage(error) },
        ),
      );
    draining = false;
  }

  async function shutDown(reason: AbortReason) {
    if (!started) return;
    stopping = true;
    crashing = reason === "crash";
    // A crash fences every run before waiting on anything below, which a busy
    // database can hold for seconds, so no run starts a new write meanwhile.
    if (crashing) abortWhere(() => true, reason);
    started = false;
    lastPollAt = null;
    for (const timer of timers.splice(0)) clearInterval(timer);
    for (const unsubscribe of unsubscribers.splice(0))
      await unsubscribe().catch(() => {});
    while (pumping) await new Promise((resolve) => setTimeout(resolve, 5));
    for (const entry of active.values()) entry.control.abort(reason);
    await Promise.all([...active.values()].map((entry) => entry.done));
    await sandboxes.releaseAll();
    // A crash leaves its row to go stale, as a dead process would.
    if (!crashing && ctx.config.workerHeartbeat)
      await removeWorkerHeartbeat(ctx.db, ctx.config.workerId).catch(
        (error: unknown) =>
          ctx.logger.warn("Removing the worker heartbeat failed", {
            error: errorMessage(error),
          }),
      );
  }

  return {
    get activeJobs() {
      return active.size;
    },
    get lastPollAt() {
      return lastPollAt;
    },
    get draining() {
      return draining;
    },
    async start() {
      if (started) return;
      started = true;
      stopping = false;
      draining = false;
      drained = undefined;
      crashing = false;
      lastBeatAt = 0;
      if (ctx.config.workerHeartbeat)
        await pruneWorkerHeartbeats(ctx.db, STALE_HEARTBEAT_MS).catch(
          (error: unknown) =>
            ctx.logger.warn("Pruning old worker heartbeats failed", {
              error: errorMessage(error),
            }),
        );
      await reapOrphans();
      // The first compaction pass soon after boot, unless one is queued already.
      await scheduleCompaction(ctx.db, ctx, 0).catch((error: unknown) =>
        ctx.logger.warn("Scheduling event compaction failed", {
          error: errorMessage(error),
        }),
      );
      unsubscribers.push(
        await ctx.bus.subscribe("jj_control", (message) => {
          void onControl(message).catch((error: unknown) =>
            ctx.logger.warn("Handling a control message failed", {
              error: errorMessage(error),
            }),
          );
        }),
      );
      const offReconnect = ctx.bus.onReconnect(() => void pump());
      unsubscribers.push(async () => offReconnect());
      const every = (ms: number, fn: () => unknown) => {
        const timer = setInterval(() => {
          void Promise.resolve(fn()).catch((error: unknown) =>
            ctx.logger.warn("A worker timer failed", {
              error: errorMessage(error),
            }),
          );
        }, ms);
        timer.unref();
        timers.push(timer);
      };
      every(ctx.config.pollIntervalMs, pump);
      every(Math.max(50, Math.floor(ctx.config.leaseMs / 3)), tick);
      // Also frees sandboxes of tasks that finished on another worker.
      every(Math.min(ctx.config.sandboxIdleMs, 30_000), () =>
        sandboxes.sweep(),
      );
      every(STAGED_SWEEP_MS, () => sweepStagedUploads(ctx));
      await pump();
    },
    stop: () => shutDown("shutdown"),
    drain(timeoutMs) {
      drained ??= drainThenStop(timeoutMs);
      return drained;
    },
    abandon: () => shutDown("crash"),
  };
}
