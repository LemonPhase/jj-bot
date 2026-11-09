import {
  type CallToolResult,
  type Implementation,
  McpAbortError,
  McpClient,
  McpConnectionClosedError,
  McpError,
  McpHttpError,
  McpTimeoutError,
  type McpTransport,
  type ProgressNotification,
  type Root,
  type Tool,
} from "@earendil-works/pi-mcp";
import { MAX_MCP_SNAPSHOT_TOOLS } from "@jj/contracts";
import { redactSecrets } from "../errors";
import type { CutEdges } from "../tools";
import {
  MCP_STDERR_TAIL_CHARS,
  McpMessageTooLargeError,
  type McpProcessExit,
  McpRemoteRefusedError,
  McpServerError,
  type McpTransportDiagnostics,
} from "./errors";

/** Most `tools/list` pages a listing reads. */
export const MCP_MAX_LIST_PAGES = 20;
/** Requests one connection has in flight at once; more wait their turn. */
export const MCP_MAX_IN_FLIGHT = 4;
/** Starts of one server allowed within MCP_START_WINDOW_MS. */
export const MCP_MAX_STARTS = 3;
export const MCP_START_WINDOW_MS = 10 * 60_000;

/** Replaces the server's secrets; `cut` names an edge where a cut may have gone through one. */
export type McpRedact = (text: string, cut?: CutEdges) => string;

export interface McpServerInfo {
  name: string;
  version: string;
  protocolVersion: string;
}

export interface McpListOptions {
  signal?: AbortSignal;
  /** Bounds each page's request. Default 30 s. */
  timeoutMs?: number;
  /** Default MCP_MAX_LIST_PAGES. */
  maxPages?: number;
  /** Most tools read, in listing order; default MAX_MCP_SNAPSHOT_TOOLS. */
  maxTools?: number;
}

export interface McpToolList {
  /** As the server listed them; sanitize before use (`sanitizeTools`). */
  tools: Tool[];
  /** Entries skipped and pages not read. */
  warnings: string[];
}

export interface McpCallOptions {
  /** Aborting cancels the call: `notifications/cancelled` is sent. */
  signal?: AbortSignal;
  /** Bounds the call; progress from the server renews it. */
  timeoutMs: number;
  onProgress?(progress: ProgressNotification): void;
}

/** How a connection ended. */
export interface McpConnectionEnd {
  /**
   * `exited`: the server's process exited. `closed`: the connection closed
   * without `close()` (the transport closed it, or the server did).
   * `requested`: `close()` was called.
   */
  reason: "exited" | "closed" | "requested";
  /** What happened, redacted. */
  error?: string;
  exitCode?: number | null;
  /** The server's latest stderr, redacted, at most 2000 characters. */
  stderrTail?: string;
}

/**
 * One connection to one MCP server: the port the engine uses. It starts,
 * lists tools, calls them, and closes; it never restarts itself
 * (`McpStartBudget` is the engine's to drive). Errors are `McpServerError`s
 * with redacted messages.
 */
export interface McpConnector {
  readonly state: "idle" | "starting" | "ready" | "closed";
  readonly serverInfo: McpServerInfo | undefined;
  /** Starts the transport and runs `initialize`, within the startup timeout. */
  start(signal?: AbortSignal): Promise<McpServerInfo>;
  /** `tools/list`, page by page. */
  listTools(options?: McpListOptions): Promise<McpToolList>;
  /** `tools/call`. */
  callTool(
    name: string,
    args: Record<string, unknown>,
    options: McpCallOptions,
  ): Promise<CallToolResult>;
  /** Closes the connection (a stdio server's process is stopped). Idempotent. */
  close(): Promise<void>;
  /** Called once, when the connection ends for any reason. */
  onClose(listener: (end: McpConnectionEnd) => void): () => void;
}

export interface McpConnectionOptions {
  /** The server's name in the profile, for messages. */
  server: string;
  /** A transport not yet started; one per connection. */
  transport: McpTransport & McpTransportDiagnostics;
  /** How long starting and `initialize` may take (`startupTimeoutSec`). */
  startupTimeoutMs: number;
  /** Offered to the server only when given (the workspace); otherwise no `roots` capability. */
  roots?: readonly Root[];
  /**
   * The server's secrets redactor, applied to every message and stderr tail
   * this connection reports, after the transport's own secrets (a remote
   * server's header values) are replaced.
   */
  redact: McpRedact;
  /** Default MCP_MAX_IN_FLIGHT. */
  maxInFlight?: number;
  clientInfo?: Implementation;
}

const CLIENT_INFO: Implementation = { name: "jj-bot", version: "1.0.0" };

/** How pi-mcp words the error it answers a request with when that request's response stream failed. */
const STREAM_FAILED = "MCP response stream failed: ";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`;

class StartTimeout extends Error {}
class StartAborted extends Error {}

/** A counting semaphore whose waiters leave when their signal aborts. */
class Slots {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly size: number) {}

  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.active < this.size) {
      this.active++;
      return this.releaser();
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const index = this.waiting.indexOf(go);
        if (index !== -1) this.waiting.splice(index, 1);
        reject(new McpAbortError());
      };
      const go = () => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      };
      this.waiting.push(go);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    return this.releaser();
  }

  private releaser() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.waiting.shift();
      // The slot passes straight to the next waiter.
      if (next) next();
      else this.active--;
    };
  }
}

/**
 * `McpConnector` on pi-mcp's `McpClient`. The client offers no sampling and
 * no elicitation, and `roots` only when given; it answers `ping`, and any
 * other request from the server with "method not found". The server's
 * instructions are never read, and `list_changed` is ignored.
 */
export class McpConnection implements McpConnector {
  private readonly options: McpConnectionOptions;
  private readonly redact: McpRedact;
  private readonly slots: Slots;
  private client: McpClient | undefined;
  private stateValue: McpConnector["state"] = "idle";
  private serverInfoValue: McpServerInfo | undefined;
  private closing = false;
  private closed: Promise<void> | undefined;
  private end: McpConnectionEnd | undefined;
  private readonly closeListeners = new Set<(end: McpConnectionEnd) => void>();

  constructor(options: McpConnectionOptions) {
    this.options = options;
    const secrets = options.transport.secrets ?? [];
    // The transport's own secrets first, whole, then the server's.
    this.redact = (text, cut) =>
      options.redact(
        secrets.length > 0 ? redactSecrets(text, secrets) : text,
        cut,
      );
    this.slots = new Slots(
      Math.max(1, options.maxInFlight ?? MCP_MAX_IN_FLIGHT),
    );
  }

  get state() {
    return this.stateValue;
  }

  get serverInfo() {
    return this.serverInfoValue;
  }

  async start(signal?: AbortSignal): Promise<McpServerInfo> {
    if (this.stateValue !== "idle")
      throw new Error(`This MCP connection is already ${this.stateValue}.`);
    this.stateValue = "starting";
    const { startupTimeoutMs } = this.options;
    const client = new McpClient({
      ...(this.options.clientInfo ?? CLIENT_INFO),
      capabilities: {},
      ...(this.options.roots ? { roots: this.options.roots } : {}),
      requestTimeoutMs: startupTimeoutMs,
    });
    this.client = client;
    client.onClose(() => this.handleClose());
    // Errors are reported where they matter: on the calls they fail.
    client.onError(() => {});
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    const limits = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StartTimeout()), startupTimeoutMs);
      onAbort = () => reject(new StartAborted());
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const result = await Promise.race([
        client.connect(this.options.transport),
        limits,
      ]);
      this.serverInfoValue = {
        name: result.serverInfo.name,
        version: result.serverInfo.version,
        protocolVersion: result.protocolVersion,
      };
      this.stateValue = "ready";
      return this.serverInfoValue;
    } catch (error) {
      // Explained before closing, so the closing does not become the cause.
      const failure = this.startError(error);
      this.closing = true;
      await client.close().catch(() => {});
      throw failure;
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  async listTools(options: McpListOptions = {}): Promise<McpToolList> {
    const client = this.ready();
    const maxPages = options.maxPages ?? MCP_MAX_LIST_PAGES;
    const maxTools = options.maxTools ?? MAX_MCP_SNAPSHOT_TOOLS;
    const tools: Tool[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    /** Entries that are not tools: counted, so a listing of junk keeps one warning. */
    let skipped = 0;
    const done = (why?: string): McpToolList => ({
      tools: tools.slice(0, maxTools),
      warnings: [
        ...(skipped > 0
          ? [
              `The server listed ${skipped} ${skipped === 1 ? "entry that is not a tool (it needs" : "entries that are not tools (each needs"} a name and an input schema); ${skipped === 1 ? "it was" : "they were"} skipped.`,
            ]
          : []),
        ...(why ? [why] : []),
      ],
    });
    for (let page = 0; page < maxPages; page++) {
      let result: unknown;
      try {
        result = await client.request(
          "tools/list",
          cursor === undefined ? undefined : { cursor },
          {
            ...(options.signal ? { signal: options.signal } : {}),
            timeoutMs: options.timeoutMs ?? 30_000,
          },
        );
      } catch (error) {
        throw this.requestError(error, "tools/list", options.timeoutMs);
      }
      if (!isObject(result) || !Array.isArray(result.tools))
        throw new McpServerError(
          "protocol",
          this.text(
            `MCP server ${this.options.server} sent an invalid tools/list result.`,
          ),
        );
      for (const item of result.tools) {
        if (
          isObject(item) &&
          typeof item.name === "string" &&
          isObject(item.inputSchema)
        )
          tools.push(item as unknown as Tool);
        else skipped++;
        if (tools.length > maxTools)
          return done(
            `The server lists more than ${maxTools} tools; only the first ${maxTools} listed were read.`,
          );
      }
      // Some servers end with `null` or `""` instead of leaving the cursor out.
      const next =
        result.nextCursor === null || result.nextCursor === ""
          ? undefined
          : result.nextCursor;
      if (next === undefined) return done();
      if (typeof next !== "string")
        throw new McpServerError(
          "protocol",
          this.text(
            `MCP server ${this.options.server} sent an invalid tools/list cursor.`,
          ),
        );
      if (cursors.has(next))
        return done(
          "The server repeated a tools/list page cursor; the listing stopped there.",
        );
      cursors.add(next);
      cursor = next;
    }
    return done(
      `The server lists more than ${maxPages} pages of tools; only the first ${maxPages} were read.`,
    );
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: McpCallOptions,
  ): Promise<CallToolResult> {
    const client = this.ready();
    const notSent = () =>
      new McpServerError(
        "aborted",
        `The run stopped before the MCP call ${name} was sent; it did not run.`,
        { interrupted: "yes" },
      );
    if (options.signal?.aborted) throw notSent();
    let release: () => void;
    try {
      release = await this.slots.acquire(options.signal);
    } catch {
      throw notSent();
    }
    // It waited for a slot while the connection ended: it was never sent.
    if (this.stateValue !== "ready") {
      release();
      throw new McpServerError(
        "closed",
        this.text(
          `${this.cause().text.replace(/\.$/, "")} before the MCP call ${name} was sent; it did not run.`,
        ),
        { interrupted: "yes" },
      );
    }
    try {
      return await client.callTool(name, args, {
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs: options.timeoutMs,
        ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      });
    } catch (error) {
      throw this.requestError(error, `the MCP call ${name}`, options.timeoutMs);
    } finally {
      release();
    }
  }

  /** Every call waits for the same close: none returns before the server is stopped. */
  close(): Promise<void> {
    this.closing = true;
    this.closed ??= (async () => {
      if (!this.client) {
        // Never started: nothing to stop, but its end is still reported.
        await this.options.transport.close().catch(() => {});
        this.handleClose();
        return;
      }
      await this.client.close();
    })();
    return this.closed;
  }

  onClose(listener: (end: McpConnectionEnd) => void): () => void {
    if (this.end) {
      listener(this.end);
      return () => {};
    }
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  private ready(): McpClient {
    if (this.stateValue !== "ready" || !this.client)
      throw new McpServerError(
        "closed",
        this.text(
          this.end?.error ??
            `The connection to MCP server ${this.options.server} is ${this.stateValue}.`,
        ),
        { interrupted: "yes" },
      );
    return this.client;
  }

  private text(text: string): string {
    return this.redact(text);
  }

  /** The server's latest stderr, redacted, at most 2000 characters; undefined when empty. */
  private tail(): string | undefined {
    const raw = this.options.transport.stderrTail?.();
    if (!raw?.text.trim()) return undefined;
    const redacted = this.redact(
      raw.text,
      raw.cut ? { start: true } : undefined,
    ).trimEnd();
    return redacted.length > MCP_STDERR_TAIL_CHARS
      ? redacted.slice(-MCP_STDERR_TAIL_CHARS)
      : redacted;
  }

  private withTail(message: string, tail: string | undefined) {
    return tail ? `${message} Its latest stderr:\n${tail}` : message;
  }

  /**
   * Why the connection ended, as one sentence: the transport closed it (a
   * message over the cap), `close()` was called (a process stopped then is
   * our doing), the process exited, or the server closed it.
   */
  private cause(): {
    kind: "closed" | "requested" | "exited";
    text: string;
    exit?: McpProcessExit;
  } {
    const { transport, server } = this.options;
    if (transport.closeReason)
      return { kind: "closed", text: transport.closeReason };
    if (this.closing)
      return {
        kind: "requested",
        text: `The connection to MCP server ${server} was closed.`,
      };
    const exit = transport.exit;
    if (exit)
      return {
        kind: "exited",
        exit,
        text:
          exit.exitCode === null
            ? `MCP server ${server} exited${exit.interruptReason ? ` (${exit.interruptReason})` : ""} without an exit code.`
            : `MCP server ${server} exited with code ${exit.exitCode}.`,
      };
    return {
      kind: "closed",
      text: `MCP server ${server} closed the connection.`,
    };
  }

  private startError(error: unknown): McpServerError {
    const { server, startupTimeoutMs } = this.options;
    const tail = this.tail();
    const details = {
      ...(tail ? { stderrTail: tail } : {}),
      ...(this.options.transport.exit
        ? { exitCode: this.options.transport.exit.exitCode }
        : {}),
    };
    if (error instanceof StartAborted)
      return new McpServerError(
        "aborted",
        `The run stopped while MCP server ${server} started.`,
        { ...details, interrupted: "yes" },
      );
    if (error instanceof StartTimeout || error instanceof McpTimeoutError)
      return new McpServerError(
        "startup",
        this.text(
          this.withTail(
            `MCP server ${server} did not answer initialize within ${seconds(startupTimeoutMs)}; it was stopped.`,
            tail,
          ),
        ),
        details,
      );
    if (error instanceof McpRemoteRefusedError)
      return new McpServerError("refused", this.text(error.message), details);
    const cause = this.cause();
    const reason =
      error instanceof McpConnectionClosedError && cause.kind !== "requested"
        ? `${cause.text.replace(/\.$/, "")} while it started.`
        : `MCP server ${server} could not start: ${error instanceof Error ? error.message : String(error)}`;
    return new McpServerError(
      "startup",
      this.text(this.withTail(reason, tail)),
      details,
    );
  }

  private requestError(
    error: unknown,
    what: string,
    timeoutMs: number | undefined,
  ): McpServerError {
    const { server } = this.options;
    if (error instanceof McpServerError) return error;
    if (error instanceof McpTimeoutError)
      return new McpServerError(
        "timeout",
        this.text(
          `${what} ran past its ${seconds(timeoutMs ?? error.timeoutMs)} timeout and was cancelled; whether it took effect is unknown.`,
        ),
        { interrupted: "unknown" },
      );
    if (error instanceof McpAbortError)
      return new McpServerError(
        "aborted",
        `The run stopped while ${what} ran, so it was cancelled; whether it took effect is unknown.`,
        { interrupted: "unknown" },
      );
    if (error instanceof McpConnectionClosedError) {
      const cause = this.cause();
      const tail = cause.kind === "requested" ? undefined : this.tail();
      return new McpServerError(
        cause.kind === "exited" ? "exited" : "closed",
        this.text(
          this.withTail(
            `${cause.text.replace(/\.$/, "")} while ${what} ran; whether it took effect is unknown.`,
            tail,
          ),
        ),
        {
          interrupted: "unknown",
          ...(tail ? { stderrTail: tail } : {}),
          ...(cause.exit ? { exitCode: cause.exit.exitCode } : {}),
        },
      );
    }
    // pi-mcp answers a request whose response stream ended or broke before
    // its answer itself, as JSON-RPC -32603: the server never said how the
    // call went. A server sending these words itself only makes its own
    // call's outcome unknown, which is the cautious reading.
    if (
      error instanceof McpError &&
      error.code === -32603 &&
      error.message.startsWith(STREAM_FAILED)
    )
      return new McpServerError(
        "closed",
        this.text(
          `The answer to ${what} was cut off (${error.message.slice(STREAM_FAILED.length)}); whether it took effect is unknown.`,
        ),
        { interrupted: "unknown" },
      );
    if (error instanceof McpError)
      return new McpServerError(
        "server",
        this.text(
          `MCP server ${server} answered ${what} with error ${error.code}: ${error.message}`,
        ),
      );
    if (error instanceof McpRemoteRefusedError)
      return new McpServerError("refused", this.text(error.message));
    if (error instanceof McpMessageTooLargeError && error.direction === "out")
      return new McpServerError("refused", this.text(error.message), {
        interrupted: "yes",
      });
    if (error instanceof McpHttpError)
      return new McpServerError(
        "server",
        this.text(`MCP server ${server}: ${error.message}`),
      );
    return new McpServerError(
      "protocol",
      this.text(
        `${what} failed: ${error instanceof Error ? error.message : String(error)}; whether it took effect is unknown.`,
      ),
      { interrupted: "unknown" },
    );
  }

  private handleClose() {
    if (this.end) return;
    this.stateValue = "closed";
    const cause = this.cause();
    const tail = cause.kind === "requested" ? undefined : this.tail();
    this.end =
      cause.kind === "requested"
        ? { reason: "requested" }
        : {
            reason: cause.kind,
            error: this.text(cause.text),
            ...(cause.exit ? { exitCode: cause.exit.exitCode } : {}),
            ...(tail ? { stderrTail: tail } : {}),
          };
    const end = this.end;
    for (const listener of [...this.closeListeners]) {
      try {
        listener(end);
      } catch {
        // A listener's failure is its own.
      }
    }
    this.closeListeners.clear();
  }
}

/**
 * The restart policy: at most MCP_MAX_STARTS starts of a server within
 * MCP_START_WINDOW_MS. The engine takes one before each start; once it is
 * spent, calls fail at once with the last error until the window passes.
 */
export class McpStartBudget {
  /** Starts allowed within `windowMs`. */
  readonly maxStarts: number;
  readonly windowMs: number;
  private readonly now: () => number;
  private starts: number[] = [];

  constructor(
    options: { maxStarts?: number; windowMs?: number; now?: () => number } = {},
  ) {
    this.maxStarts = options.maxStarts ?? MCP_MAX_STARTS;
    this.windowMs = options.windowMs ?? MCP_START_WINDOW_MS;
    this.now = options.now ?? Date.now;
  }

  /** Takes one start: `ok` when the budget allows it, else when the next one will be allowed (ms since the epoch). */
  take(): { ok: true } | { ok: false; retryAt: number } {
    const now = this.now();
    this.starts = this.starts.filter((at) => at > now - this.windowMs);
    if (this.starts.length >= this.maxStarts)
      return {
        ok: false,
        retryAt: (this.starts[0] ?? now) + this.windowMs,
      };
    this.starts.push(now);
    return { ok: true };
  }
}
