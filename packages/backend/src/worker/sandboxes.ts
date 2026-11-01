// One sandbox per task, shared by all of the task's sessions in this worker.
// Acquired with the coordinator's profile and `workspaceKey = taskId`, held
// while runs use it, released when the task finishes (here or on another
// worker, after the `onFinished` hook's final look at it) or after it idles.
import { isFinishedStatus, type TaskStatus } from "@jj/contracts";
import { tasks } from "@jj/db";
import type { Sandbox, SandboxSpec } from "@jj/sandbox/contract";
import { inArray } from "drizzle-orm";
import type { EngineContext } from "../context";
import { errorMessage } from "../errors";

interface Entry {
  acquiring: Promise<Sandbox>;
  /** Aborts the driver's acquire (a slow image pull) once no run waits for it. */
  controller: AbortController;
  sandbox?: Sandbox;
  spec: SandboxSpec;
  refs: number;
  idleSince: number;
  /** Release once the last run lets go (the task finished). */
  finishing: boolean;
}

export interface SandboxHold {
  sandbox: Sandbox;
  spec: SandboxSpec;
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

export class TaskSandboxes {
  private readonly entries = new Map<string, Entry>();
  private readonly releasing = new Set<Promise<void>>();
  /** Tasks whose ephemeral workspace this worker released (and so discarded). */
  private readonly discarded = new Set<string>();
  private readonly statuses: TaskStatusLookup;

  private readonly onRelease?: (taskId: string, spec: SandboxSpec) => void;
  private readonly onFinished?: (
    taskId: string,
    sandbox: Sandbox,
  ) => Promise<void>;

  constructor(
    private readonly ctx: EngineContext,
    options: {
      statuses?: TaskStatusLookup;
      /** Called when a sandbox is released (its holder record is cleared). */
      onRelease?: (taskId: string, spec: SandboxSpec) => void;
      /** Runs before the sandbox of a finished task is released (a final snapshot). */
      onFinished?: (taskId: string, sandbox: Sandbox) => Promise<void>;
    } = {},
  ) {
    this.statuses = options.statuses ?? dbStatuses(ctx);
    this.onRelease = options.onRelease;
    this.onFinished = options.onFinished;
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
   */
  async acquire(
    taskId: string,
    sessionId: string,
    spec: SandboxSpec,
    signal?: AbortSignal,
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
        controller,
        refs: 0,
        idleSince: Date.now(),
        finishing: false,
        acquiring: driver
          .acquire({
            taskId,
            sessionId,
            spec,
            workspaceKey: taskId,
            signal: controller.signal,
          })
          .then((sandbox) => {
            created.sandbox = sandbox;
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

  /** The task finished: release its sandbox once no run uses it. */
  finish(taskId: string): void {
    const entry = this.entries.get(taskId);
    if (!entry) return;
    entry.finishing = true;
    if (entry.refs === 0) this.releaseEntry(taskId, entry, true);
  }

  /**
   * Releases unused sandboxes whose task has finished (on any worker) or that
   * sat idle for `sandboxIdleMs`, ephemeral ones included: an idle ephemeral
   * workspace is discarded, and a later session of its task fails visibly.
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
      if (
        finished ||
        status === undefined ||
        now - entry.idleSince >= this.ctx.config.sandboxIdleMs
      )
        this.releaseEntry(taskId, entry, finished);
    }
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
          await this.onFinished(taskId, sandbox).catch((error: unknown) =>
            this.ctx.logger.warn(
              `The final artifact snapshot of ${taskId} failed`,
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
