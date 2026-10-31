// One sandbox per task, shared by all of the task's sessions in this worker.
// Acquired with the coordinator's profile and `workspaceKey = taskId`, held
// while runs use it, released when the task finishes or after it idles.
import type { Sandbox, SandboxSpec } from "@jj/sandbox/contract";
import type { EngineContext } from "../context";
import { errorMessage } from "../errors";

interface Entry {
  acquiring: Promise<Sandbox>;
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

export class TaskSandboxes {
  private readonly entries = new Map<string, Entry>();
  private readonly releasing = new Set<Promise<void>>();

  constructor(private readonly ctx: EngineContext) {}

  /** True while this worker holds a live sandbox for the task. */
  holds(taskId: string): boolean {
    return this.entries.get(taskId)?.sandbox !== undefined;
  }

  async acquire(
    taskId: string,
    sessionId: string,
    spec: SandboxSpec,
  ): Promise<SandboxHold> {
    let entry = this.entries.get(taskId);
    if (!entry) {
      const driver = this.ctx.drivers.get(spec.driver);
      if (!driver)
        throw new SandboxUnavailableError(
          `Sandbox driver "${spec.driver}" is not installed on this server.`,
        );
      const created: Entry = {
        spec,
        refs: 0,
        idleSince: Date.now(),
        finishing: false,
        acquiring: driver
          .acquire({ taskId, sessionId, spec, workspaceKey: taskId })
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
      sandbox = await entry.acquiring;
    } catch (error) {
      entry.refs -= 1;
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
        if (held.refs === 0 && held.finishing) this.releaseEntry(taskId, held);
      },
    };
  }

  /** The task finished: release its sandbox once no run uses it. */
  finish(taskId: string): void {
    const entry = this.entries.get(taskId);
    if (!entry) return;
    entry.finishing = true;
    if (entry.refs === 0) this.releaseEntry(taskId, entry);
  }

  /** Releases sandboxes idle longer than the configured time. Ephemeral workspaces are kept: releasing would discard them. */
  sweep(now = Date.now()): void {
    for (const [taskId, entry] of this.entries)
      if (
        entry.refs === 0 &&
        entry.sandbox &&
        entry.spec.workspace !== "ephemeral" &&
        now - entry.idleSince >= this.ctx.config.sandboxIdleMs
      )
        this.releaseEntry(taskId, entry);
  }

  /** Releases everything, waiting for the drivers. */
  async releaseAll(): Promise<void> {
    for (const [taskId, entry] of this.entries)
      this.releaseEntry(taskId, entry);
    await Promise.all([...this.releasing]);
  }

  private releaseEntry(taskId: string, entry: Entry): void {
    if (this.entries.get(taskId) === entry) this.entries.delete(taskId);
    const done = entry.acquiring
      .then((sandbox) => sandbox.release())
      .catch((error: unknown) => {
        this.ctx.logger.warn(`Releasing the sandbox of ${taskId} failed`, {
          error: errorMessage(error),
        });
      });
    this.releasing.add(done);
    void done.finally(() => this.releasing.delete(done));
  }
}
