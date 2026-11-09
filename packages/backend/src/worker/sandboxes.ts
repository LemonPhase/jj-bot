// One sandbox per task, shared by all of the task's sessions in this worker.
// Acquired with the coordinator's profile and `workspaceKey = taskId`, held
// while runs use it, released when the task finishes (here or on another
// worker, after the `onFinished` hook's final look at it), after it idles
// (`sandboxIdleMs`; `ephemeralIdleMs` for an ephemeral workspace, whose files
// a release discards), or when the worker holds more than
// `maxHeldSandboxes` (the least recently used idle one, `task` first).
import { isFinishedStatus, type TaskStatus } from "@jj/contracts";
import { tasks } from "@jj/db";
import type { Sandbox, SandboxSpec } from "@jj/sandbox/contract";
import type { Context } from "@opentelemetry/api";
import { and, eq, inArray, isNull, ne, or } from "drizzle-orm";
import type { EngineContext } from "../context";
import { errorMessage } from "../errors";
import { endSpan, SPANS, startSpan } from "../observability/tracing";
import type { Secret } from "../redact";

interface Entry {
  acquiring: Promise<Sandbox>;
  /** Aborts the driver's acquire (a slow image pull) once no run waits for it. */
  controller: AbortController;
  sandbox?: Sandbox;
  spec: SandboxSpec;
  /** The secrets given to the driver when it started, by name. */
  secrets: Record<string, string>;
  refs: number;
  idleSince: number;
  /** Release once the last run lets go (the task finished). */
  finishing: boolean;
}

export interface SandboxHold {
  sandbox: Sandbox;
  spec: SandboxSpec;
  /**
   * The values injected into this sandbox when it started. Its commands see
   * them for as long as it lives, even after the stored secret is replaced
   * or removed, so whatever a run persists from it is redacted for them.
   */
  secrets: Secret[];
  /** Ends this run's use; the sandbox stays for the task's other runs. */
  done(): void;
}

/** A driver refused the spec or could not start a sandbox. */
export class SandboxUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxUnavailableError";
  }
}

/** Current statuses of tasks (missing ids are absent). */
export type TaskStatusLookup = (
  taskIds: string[],
) => Promise<Map<string, TaskStatus>>;

const dbStatuses =
  (ctx: EngineContext): TaskStatusLookup =>
  async (taskIds) => {
    const rows = await ctx.db
      .select({ id: tasks.id, status: tasks.status })
      .from(tasks)
      .where(inArray(tasks.id, taskIds));
    return new Map(rows.map((row) => [row.id, row.status]));
  };

/** The values a sandbox was started with, as secrets to redact. */
const injected = (entry: Entry): Secret[] =>
  Object.entries(entry.secrets).map(([name, value]) => ({
    name: `the sandbox secret ${name}`,
    value,
  }));

/** Waits for `promise`, rejecting early when `signal` aborts. */
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const onAbort = () => reject(signal.reason ?? new Error("aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Records that the task holds a `task` workspace of `driverId`, which a
 * schedule's `keepWorkspaces` may later remove through that driver. A write
 * that fails is logged and leaves the task untrimmed, never the run failed.
 */
async function recordTaskWorkspace(
  ctx: EngineContext,
  taskId: string,
  driverId: string,
): Promise<void> {
  try {
    await ctx.db
      .update(tasks)
      .set({ workspaceDriver: driverId })
      .where(
        and(
          eq(tasks.id, taskId),
          or(
            isNull(tasks.workspaceDriver),
            ne(tasks.workspaceDriver, driverId),
          ),
        ),
      );
  } catch (error) {
    ctx.logger?.warn(`Recording the workspace of task ${taskId} failed`, {
      error: errorMessage(error),
    });
  }
}

export class TaskSandboxes {
  private readonly entries = new Map<string, Entry>();
  private readonly releasing = new Set<Promise<void>>();
  /** Tasks whose ephemeral workspace this worker released (and so discarded). */
  private readonly discarded = new Set<string>();
  private readonly statuses: TaskStatusLookup;

  private readonly onRelease?: (taskId: string, spec: SandboxSpec) => void;
  private readonly beforeRelease?: (sandbox: Sandbox) => Promise<void>;
  private readonly onFinished?: (
    taskId: string,
    sandbox: Sandbox,
    secrets: Secret[],
  ) => Promise<void>;

  constructor(
    private readonly ctx: EngineContext,
    options: {
      statuses?: TaskStatusLookup;
      /** Called when a sandbox is released (its holder record is cleared). */
      onRelease?: (taskId: string, spec: SandboxSpec) => void;
      /**
       * Runs right before the driver releases a sandbox, after `onFinished`:
       * the MCP servers running in it are stopped first.
       */
      beforeRelease?: (sandbox: Sandbox) => Promise<void>;
      /**
       * Runs before the sandbox of a finished task is released (a final
       * snapshot), with the values the sandbox was started with.
       */
      onFinished?: (
        taskId: string,
        sandbox: Sandbox,
        secrets: Secret[],
      ) => Promise<void>;
    } = {},
  ) {
    this.statuses = options.statuses ?? dbStatuses(ctx);
    this.onRelease = options.onRelease;
    this.beforeRelease = options.beforeRelease;
    this.onFinished = options.onFinished;
  }

  /**
   * The values injected into every sandbox this worker holds. Any of them
   * can reach another task's output (on `local`, through a shared file), so
   * every redactor of this worker covers them while they are held.
   */
  heldSecrets(): Secret[] {
    return [...this.entries.values()].flatMap((entry) => injected(entry));
  }

  /** Tasks whose ephemeral sandbox this worker holds live. */
  heldEphemeral(): string[] {
    return [...this.entries]
      .filter(
        ([, entry]) => entry.sandbox && entry.spec.workspace === "ephemeral",
      )
      .map(([taskId]) => taskId);
  }

  /** True while this worker holds a live sandbox for the task. */
  holds(taskId: string): boolean {
    return this.entries.get(taskId)?.sandbox !== undefined;
  }

  /** True when this worker released the task's ephemeral workspace, which discarded its files. */
  wasDiscarded(taskId: string): boolean {
    return this.discarded.has(taskId);
  }

  /**
   * The task's sandbox, starting it on first use. `signal` (the run's) stops
   * waiting; when no run waits any more the driver's acquire is aborted too.
   * `secrets` is read only when this starts the sandbox: its values go to the
   * driver, which injects them into every command. A start is traced under
   * `trace` (the run's span) and timed by driver.
   */
  async acquire(
    taskId: string,
    sessionId: string,
    spec: SandboxSpec,
    signal?: AbortSignal,
    secrets?: () => Promise<Record<string, string>>,
    trace?: Context,
  ): Promise<SandboxHold> {
    signal?.throwIfAborted();
    let entry = this.entries.get(taskId);
    if (!entry) {
      const driver = this.ctx.drivers.get(spec.driver);
      if (!driver)
        throw new SandboxUnavailableError(
          `Sandbox driver "${spec.driver}" is not installed on this server.`,
        );
      const controller = new AbortController();
      const created: Entry = {
        spec,
        secrets: {},
        controller,
        refs: 0,
        idleSince: Date.now(),
        finishing: false,
        acquiring: (secrets ? secrets() : Promise.resolve({}))
          .then((values) => {
            created.secrets = values;
            return this.timed(
              driver.id,
              taskId,
              sessionId,
              controller,
              trace,
              () =>
                driver.acquire({
                  taskId,
                  sessionId,
                  spec,
                  workspaceKey: taskId,
                  signal: controller.signal,
                  ...(Object.keys(values).length > 0
                    ? { secrets: values }
                    : {}),
                }),
            );
          })
          .then(async (sandbox) => {
            created.sandbox = sandbox;
            if (spec.workspace === "task")
              await recordTaskWorkspace(this.ctx, taskId, driver.id);
            return sandbox;
          }),
      };
      entry = created;
      this.entries.set(taskId, entry);
      created.acquiring.catch(() => {
        if (this.entries.get(taskId) === created) this.entries.delete(taskId);
      });
    }
    entry.refs += 1;
    entry.finishing = false;
    // A new sandbox may take the worker over its cap: make room.
    this.enforceCap();
    let sandbox: Sandbox;
    try {
      sandbox = await abortable(entry.acquiring, signal);
    } catch (error) {
      entry.refs -= 1;
      if (entry.refs === 0 && !entry.sandbox) {
        // Nobody waits for it any more: stop the start (an image pull, say).
        entry.controller.abort(new Error("the run stopped"));
        if (this.entries.get(taskId) === entry) this.entries.delete(taskId);
        void entry.acquiring.then(
          (late) => late.release().catch(() => {}),
          () => {},
        );
      }
      if (signal?.aborted)
        throw new SandboxUnavailableError(
          "The run stopped while its sandbox was starting.",
        );
      throw new SandboxUnavailableError(
        `The sandbox could not start: ${errorMessage(error)}`,
      );
    }
    const held = entry;
    let released = false;
    return {
      sandbox,
      spec: held.spec,
      secrets: injected(held),
      done: () => {
        if (released) return;
        released = true;
        held.refs -= 1;
        held.idleSince = Date.now();
        if (held.refs === 0 && held.finishing)
          this.releaseEntry(taskId, held, true);
      },
    };
  }

  /**
   * A driver's start as a `jj.sandbox.acquire` span and a sample of
   * `jj_sandbox_acquire_duration_seconds`: `ok`, `error` (also counted in
   * `jj_sandbox_acquire_failures_total`) or `aborted` when no run waited.
   */
  private async timed(
    driver: string,
    taskId: string,
    sessionId: string,
    controller: AbortController,
    trace: Context | undefined,
    start: () => Promise<Sandbox>,
  ): Promise<Sandbox> {
    const startedAt = performance.now();
    const span = startSpan(
      this.ctx.tracer,
      SPANS.sandboxAcquire,
      {
        "jj.sandbox.driver": driver,
        "jj.task.id": taskId,
        "jj.session.id": sessionId,
      },
      trace,
    );
    const done = (outcome: string) => {
      this.ctx.metrics.sandboxAcquire(
        driver,
        outcome,
        (performance.now() - startedAt) / 1000,
      );
      endSpan(span, outcome, outcome === "error");
    };
    try {
      const sandbox = await start();
      done("ok");
      return sandbox;
    } catch (error) {
      done(controller.signal.aborted ? "aborted" : "error");
      throw error;
    }
  }

  /** The task finished: release its sandbox once no run uses it. */
  finish(taskId: string): void {
    const entry = this.entries.get(taskId);
    if (!entry) return;
    entry.finishing = true;
    if (entry.refs === 0) this.releaseEntry(taskId, entry, true);
  }

  /**
   * Releases unused sandboxes whose task has finished (on any worker) or is
   * gone, and those idle past their limit: `sandboxIdleMs` for a `task`
   * workspace, the much longer `ephemeralIdleMs` for an ephemeral one, so a
   * waiting task's next session still finds its files. Then holds the
   * worker to `maxHeldSandboxes`.
   */
  async sweep(now = Date.now()): Promise<void> {
    const unused = [...this.entries].filter(
      ([, entry]) => entry.refs === 0 && entry.sandbox,
    );
    if (unused.length === 0) return;
    const statuses = await this.statuses(unused.map(([taskId]) => taskId));
    for (const [taskId, entry] of unused) {
      if (entry.refs > 0 || this.entries.get(taskId) !== entry) continue;
      const status = statuses.get(taskId);
      const finished = status !== undefined && isFinishedStatus(status);
      const limit =
        entry.spec.workspace === "ephemeral"
          ? this.ctx.config.ephemeralIdleMs
          : this.ctx.config.sandboxIdleMs;
      if (finished || status === undefined || now - entry.idleSince >= limit)
        this.releaseEntry(taskId, entry, finished);
    }
    this.enforceCap();
  }

  /**
   * Over `maxHeldSandboxes`, releases idle sandboxes, least recently used
   * first, `task` workspaces (which keep their files) before ephemeral ones.
   * Sandboxes in use are never released, so the cap can be exceeded briefly.
   */
  private enforceCap(): void {
    const excess = this.entries.size - this.ctx.config.maxHeldSandboxes;
    if (excess <= 0) return;
    const idle = [...this.entries]
      .filter(([, entry]) => entry.refs === 0 && entry.sandbox)
      .sort(
        ([, a], [, b]) =>
          Number(a.spec.workspace === "ephemeral") -
            Number(b.spec.workspace === "ephemeral") ||
          a.idleSince - b.idleSince,
      );
    for (const [taskId, entry] of idle.slice(0, excess))
      this.releaseEntry(taskId, entry, false);
  }

  /** Releases everything, waiting for the drivers. */
  async releaseAll(): Promise<void> {
    for (const [taskId, entry] of this.entries) {
      if (!entry.sandbox) entry.controller.abort(new Error("worker stopping"));
      this.releaseEntry(taskId, entry, false);
    }
    await Promise.all([...this.releasing]);
  }

  /** `finished`: the task finished, so `onFinished` sees the sandbox first. */
  private releaseEntry(taskId: string, entry: Entry, finished: boolean): void {
    if (this.entries.get(taskId) === entry) this.entries.delete(taskId);
    if (entry.spec.workspace === "ephemeral") this.discarded.add(taskId);
    this.onRelease?.(taskId, entry.spec);
    const done = entry.acquiring
      .then(async (sandbox) => {
        if (finished && this.onFinished)
          await this.onFinished(taskId, sandbox, injected(entry)).catch(
            (error: unknown) =>
              this.ctx.logger.warn(
                `The final artifact snapshot of ${taskId} failed`,
                { error: errorMessage(error) },
              ),
          );
        await this.beforeRelease?.(sandbox).catch((error: unknown) =>
          this.ctx.logger.warn(
            `Stopping the MCP servers in the sandbox of ${taskId} failed`,
            { error: errorMessage(error) },
          ),
        );
        await sandbox.release();
      })
      .catch((error: unknown) => {
        if (entry.controller.signal.aborted) return;
        this.ctx.logger.warn(`Releasing the sandbox of ${taskId} failed`, {
          error: errorMessage(error),
        });
      });
    this.releasing.add(done);
    void done.finally(() => this.releasing.delete(done));
  }
}
