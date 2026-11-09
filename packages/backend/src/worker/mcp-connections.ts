// The MCP connections a worker holds for sessions. One per (task sandbox or
// worker, profile, server, configHash): a stdio server runs in its task's
// sandbox, a remote one is called by the worker. A connection starts at the
// first call that needs it, is shared by the task's sessions (a remote one
// by every task of the worker that uses the same configuration), restarts
// at a later call after it ended, within its start budget, and ends when its
// sandbox is released, its configuration changes, a remote one has been
// idle for `mcpIdleMs`, or the worker stops. Each change of state is an
// `mcp.server` event in the tasks that use it.
import type { McpServer, McpServerEvent, McpTool } from "@jj/contracts";
import type { Sandbox } from "@jj/sandbox/contract";
import type { EngineContext } from "../context";
import { errorMessage } from "../errors";
import { emit } from "../events";
import type { McpConnectionEnd, McpConnector, McpStartBudget } from "../ports";
import type { Redactor } from "../redact";
import { secretHeaderValues } from "../services/secrets";

/** How long the drift listing may take once a server is ready. */
export const MCP_DRIFT_LIST_MS = 5_000;
/** The contract's caps on an `mcp.server` event's `error`. */
const ERROR_LIMIT = 500;
/** How long an entry with no connection keeps its start budget once unused (the budget's window). */
const FORGET_AFTER_MS = 10 * 60_000;

/** What an `mcp.server` event says, without the profile and server its connection names. */
export type McpServerReport = Omit<McpServerEvent, "profileId" | "server">;

/** One call's way to its server's connection, resolved against the profile as it is now. */
export interface McpTarget {
  /** The configuration the profile holds now. */
  server: McpServer;
  profileId: string;
  /** `mcpConfigHash` of `server` in the profile's sandbox. */
  configHash: string;
  /** The task's sandbox, where a stdio server runs. */
  sandbox: Sandbox;
  taskId: string;
  /** The tools of the snapshot the profile pins for `server`, for drift. */
  snapshotTools: readonly McpTool[];
  /** The calling run's redactor; the connection reports through the newest one. */
  redact: Redactor;
  /** Records an event for the calling run (fenced, attributed to it). */
  report(event: McpServerReport): Promise<void>;
}

/** Why the worker ended a connection. */
type EndReason = "config" | "idle" | "release" | "stop";

const ENDED: Record<EndReason, string> = {
  config: "its configuration changed",
  idle: "it was idle",
  release: "its sandbox was released",
  stop: "the worker stopped",
};

interface Entry {
  key: string;
  /** `sandbox:<id>` for a stdio server, `worker` for a remote one. */
  holder: string;
  profileId: string;
  server: string;
  budget: McpStartBudget;
  /** The connection while it is ready; cleared when it ends. */
  connector?: McpConnector;
  starting?: Promise<McpConnector>;
  /** Stops the start under way when the entry is ended. */
  startAbort?: AbortController;
  /** Set once the worker ended the entry: no call reaches it any more. */
  ended?: EndReason;
  /** A remote connection of an old configuration, ended once its calls in flight are answered. */
  draining?: boolean;
  /** Why the last start or connection failed, redacted: what a call refused by the budget is told. */
  lastError?: string;
  redact: Redactor;
  /** Tasks whose calls used it: where its unexpected end is reported. */
  tasks: Set<string>;
  inFlight: number;
  lastUsedAt: number;
}

const clip = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;

/** Waits for `promise`, rejecting with `onAbort()` once `signal` aborts. */
function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  onAbort: () => Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(onAbort());
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/** A call that never reached its server: its error result says why. */
export class McpCallNotSent extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpCallNotSent";
  }
}

/** A connection that counts its calls in flight, so none is ended under a call by an idle sweep or a drain. */
class CountingConnector implements McpConnector {
  constructor(
    private readonly inner: McpConnector,
    private readonly entry: Entry,
    private readonly answered: () => void,
  ) {}

  get state() {
    return this.inner.state;
  }

  start(signal?: AbortSignal) {
    return this.inner.start(signal);
  }

  async callTool(...args: Parameters<McpConnector["callTool"]>) {
    this.entry.inFlight += 1;
    try {
      return await this.inner.callTool(...args);
    } finally {
      this.entry.inFlight -= 1;
      this.entry.lastUsedAt = Date.now();
      this.answered();
    }
  }

  close() {
    return this.inner.close();
  }

  onClose(listener: (end: McpConnectionEnd) => void) {
    return this.inner.onClose(listener);
  }
}

export class McpConnections {
  private readonly entries = new Map<string, Entry>();
  /** Connections reported `ready`: only their end is reported as `exited`. */
  private readonly announced = new WeakSet<McpConnector>();
  private stopped = false;

  constructor(private readonly ctx: EngineContext) {}

  /** Connections and entries this worker holds (tests). */
  get size(): number {
    return this.entries.size;
  }

  /**
   * The connection for `target`, ready: the running one, the one starting,
   * or a new start, which takes one from the key's budget. A configuration
   * change first ends the connection of the old one: a stdio server's is
   * stopped before the new one starts; a remote one's takes no new call and
   * ends once its calls in flight are answered. `signal` (the call's) stops
   * waiting for a start, which goes on for the calls that share it.
   */
  async acquire(target: McpTarget, signal: AbortSignal): Promise<McpConnector> {
    const name = target.server.name;
    const notSent = (why: string) =>
      new McpCallNotSent(`${why}; the call did not run.`);
    if (this.stopped)
      throw notSent(
        `The worker is stopping, so MCP server ${name} was not started`,
      );
    if (signal.aborted)
      throw notSent(`The run stopped before MCP server ${name} was reached`);
    const holder =
      target.server.transport === "stdio"
        ? `sandbox:${target.sandbox.id}`
        : "worker";
    const key = [holder, target.profileId, name, target.configHash].join("\0");
    const stopping: Promise<void>[] = [];
    for (const other of [...this.entries.values()])
      if (
        other.key !== key &&
        other.holder === holder &&
        other.profileId === target.profileId &&
        other.server === name
      )
        stopping.push(this.retire(other));
    await Promise.all(stopping);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        key,
        holder,
        profileId: target.profileId,
        server: name,
        budget: this.mcp().startBudget(),
        redact: target.redact,
        tasks: new Set(),
        inFlight: 0,
        lastUsedAt: Date.now(),
      };
      this.entries.set(key, entry);
    }
    const current = entry;
    current.redact = target.redact;
    current.tasks.add(target.taskId);
    current.lastUsedAt = Date.now();
    let connector = current.connector;
    if (connector?.state !== "ready") {
      if (!current.starting) {
        const starting = this.start(current, target).finally(() => {
          if (current.starting === starting) current.starting = undefined;
        });
        // Whoever waits for it may be gone by the time it fails.
        starting.catch(() => {});
        current.starting = starting;
      }
      connector = await abortable(current.starting, signal, () =>
        notSent(`The run stopped while MCP server ${name} started`),
      );
    }
    return new CountingConnector(connector, current, () => {
      if (current.draining && current.inFlight === 0)
        void this.end(current, "config");
    });
  }

  /** Ends the connections of stdio servers in this sandbox: it is being released. */
  async releaseSandbox(sandboxId: string): Promise<void> {
    await Promise.all(
      [...this.entries.values()]
        .filter((entry) => entry.holder === `sandbox:${sandboxId}`)
        .map((entry) => this.end(entry, "release")),
    );
  }

  /** Ends remote connections idle for `mcpIdleMs`, and forgets entries long unused. */
  sweep(now = Date.now()): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.inFlight > 0 || entry.starting) continue;
      const idle = now - entry.lastUsedAt;
      if (
        entry.connector &&
        entry.holder === "worker" &&
        idle >= this.ctx.config.mcpIdleMs
      )
        void this.end(entry, "idle");
      else if (!entry.connector && idle >= FORGET_AFTER_MS)
        this.entries.delete(entry.key);
    }
  }

  /** The worker starts (again): connections may start. */
  resume(): void {
    this.stopped = false;
  }

  /** The worker stops: every connection ends, and none starts until it resumes. */
  async stop(): Promise<void> {
    this.stopped = true;
    await Promise.all(
      [...this.entries.values()].map((entry) => this.end(entry, "stop")),
    );
  }

  private mcp() {
    const mcp = this.ctx.mcp;
    if (!mcp) throw new Error("This server has no MCP client.");
    return mcp;
  }

  /**
   * An old configuration's connection: a remote one with calls in flight
   * takes no new call and ends once they are answered (no process of it
   * can clash with the new one's); any other ends now.
   */
  private retire(entry: Entry): Promise<void> {
    if (entry.holder === "worker" && entry.inFlight > 0 && entry.connector) {
      if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
      entry.draining = true;
      return Promise.resolve();
    }
    return this.end(entry, "config");
  }

  /**
   * Ends an entry, ours to close: no call reaches it any more, a start under
   * way is stopped, and its connection is closed. An end for idleness or a
   * new configuration is reported as `exited` in the tasks that used it; a
   * release or a stop is not (the sandbox or the worker goes with it).
   */
  private async end(entry: Entry, why: EndReason): Promise<void> {
    if (this.entries.get(entry.key) === entry) this.entries.delete(entry.key);
    entry.ended ??= why;
    entry.startAbort?.abort();
    const connector = entry.connector;
    entry.connector = undefined;
    if (connector) {
      if ((why === "config" || why === "idle") && this.announced.has(connector))
        this.reportAll(entry, { state: "exited" });
      await connector.close().catch(() => {});
    }
    await entry.starting?.catch(() => {});
  }

  /**
   * Starts the entry's server: one start of its budget, `initialize`, then
   * the drift listing. Each outcome is an event for the calling run: `ready`,
   * or `failed`, also when the entry was ended as it started (unless the
   * worker stopped, which writes nothing).
   */
  private async start(entry: Entry, target: McpTarget): Promise<McpConnector> {
    const { server } = target;
    const budget = entry.budget.take();
    if (!budget.ok) {
      const { maxStarts, windowMs } = entry.budget;
      const minutes = Math.round(windowMs / 60_000);
      throw new McpCallNotSent(
        entry.redact(
          `MCP server ${server.name} was started ${maxStarts} times in ${minutes} minute${minutes === 1 ? "" : "s"}, so it is not started again before ${new Date(budget.retryAt).toISOString()} and the call did not run.${entry.lastError ? ` Its last error: ${entry.lastError}` : ""}`,
        ),
      );
    }
    await this.report(target, { state: "starting" });
    const startedAt = Date.now();
    const abort = new AbortController();
    entry.startAbort = abort;
    const stoppedAsItStarted = () =>
      new McpCallNotSent(
        `MCP server ${server.name} was stopped as it started, since ${ENDED[entry.ended ?? "stop"]}; the call did not run.`,
      );
    let connector: McpConnector | undefined;
    try {
      const secretHeaders =
        server.transport === "http"
          ? await secretHeaderValues(this.ctx, server)
          : undefined;
      if (entry.ended) throw stoppedAsItStarted();
      connector = await this.mcp().connect({
        server,
        ...(server.transport === "stdio" ? { sandbox: target.sandbox } : {}),
        ...(secretHeaders ? { secretHeaders } : {}),
        redact: (text, cut) => entry.redact(text, cut),
      });
      await connector.start(abort.signal);
      if (entry.ended) throw stoppedAsItStarted();
    } catch (failure) {
      entry.startAbort = undefined;
      await connector?.close().catch(() => {});
      const error = entry.ended ? stoppedAsItStarted() : failure;
      const message = entry.redact(errorMessage(error));
      const stderr = entry.ended
        ? undefined
        : (failure as { stderrTail?: unknown }).stderrTail;
      if (!entry.ended) entry.lastError = message;
      if (entry.ended !== "stop")
        await this.report(target, {
          state: "failed",
          durationMs: Date.now() - startedAt,
          error: clip(
            typeof stderr === "string"
              ? message.replace(/ Its latest stderr:\n[\s\S]*$/, "")
              : message,
            ERROR_LIMIT,
          ),
          ...(typeof stderr === "string" && stderr.trim()
            ? { stderrTail: clip(entry.redact(stderr), 2000) }
            : {}),
        });
      throw error;
    }
    const ready = connector;
    entry.connector = ready;
    ready.onClose((end) => this.ended(entry, ready, end));
    let drift: string[] = [];
    try {
      drift = await this.mcp().drift(ready, {
        server: server.name,
        tools: target.snapshotTools,
        redact: (text) => entry.redact(text),
        timeoutMs: MCP_DRIFT_LIST_MS,
        signal: abort.signal,
      });
    } catch (error) {
      if (!entry.ended)
        this.ctx.logger.warn(
          `Listing the tools of MCP server ${server.name} for drift failed`,
          { error: entry.redact(errorMessage(error)) },
        );
    } finally {
      entry.startAbort = undefined;
    }
    // Ended during the listing, by the worker or by the server: it never
    // became ready.
    if (entry.ended || ready.state !== "ready") {
      const error = entry.ended
        ? stoppedAsItStarted()
        : new McpCallNotSent(
            `${entry.lastError ?? `MCP server ${server.name} closed the connection as it started.`} The call did not run.`,
          );
      if (entry.ended !== "stop")
        await this.report(target, {
          state: "failed",
          durationMs: Date.now() - startedAt,
          error: clip(entry.redact(error.message), ERROR_LIMIT),
        });
      throw error;
    }
    this.announced.add(ready);
    await this.report(target, {
      state: "ready",
      durationMs: Date.now() - startedAt,
      ...(drift.length > 0 ? { drift } : {}),
    });
    return ready;
  }

  /** A connection ended. Unless it was closed here, its process exited or it dropped: reported in every task that used it. */
  private ended(
    entry: Entry,
    connector: McpConnector,
    end: McpConnectionEnd,
  ): void {
    if (entry.connector === connector) entry.connector = undefined;
    if (end.reason === "requested" || this.stopped) return;
    if (end.error) entry.lastError = end.error;
    // One that never became ready is reported by its start, as `failed`.
    if (!this.announced.has(connector)) return;
    this.reportAll(entry, {
      state: "exited",
      ...(end.error ? { error: clip(end.error, ERROR_LIMIT) } : {}),
      ...(end.stderrTail ? { stderrTail: clip(end.stderrTail, 2000) } : {}),
    });
    // The next connection reports to the tasks that use it.
    entry.tasks.clear();
  }

  /**
   * An event for the calling run. One that can no longer write (it ended,
   * or lost its lease) leaves it to the task, unattributed: the connection
   * outlives the run that started it. A stopping worker writes nothing.
   */
  private async report(target: McpTarget, event: McpServerReport) {
    await target.report(event).catch(async () => {
      if (this.stopped) return;
      await this.ctx.db
        .transaction((tx) =>
          emit(tx, this.ctx, target.taskId, {
            type: "mcp.server",
            payload: {
              profileId: target.profileId,
              server: target.server.name,
              ...event,
            },
          }),
        )
        .catch((error: unknown) =>
          this.ctx.logger.warn("Recording an mcp.server event failed", {
            taskId: target.taskId,
            error: errorMessage(error),
          }),
        );
    });
  }

  /** An event in every task that used the entry, outside any run. */
  private reportAll(entry: Entry, event: McpServerReport) {
    const { ctx } = this;
    for (const taskId of entry.tasks)
      void ctx.db
        .transaction((tx) =>
          emit(tx, ctx, taskId, {
            type: "mcp.server",
            payload: {
              profileId: entry.profileId,
              server: entry.server,
              ...event,
            },
          }),
        )
        .catch((error: unknown) =>
          ctx.logger.warn("Recording an mcp.server event failed", {
            taskId,
            error: errorMessage(error),
          }),
        );
  }
}
