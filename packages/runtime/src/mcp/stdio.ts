import {
  type JsonRpcMessage,
  McpConnectionClosedError,
  type McpTransport,
  type McpTransportCloseListener,
  type McpTransportErrorListener,
  type McpTransportMessageListener,
  parseJsonRpcMessage,
} from "@earendil-works/pi-mcp";
import {
  MCP_MAX_MESSAGE_BYTES,
  MCP_STDERR_RING_BYTES,
  McpMessageTooLargeError,
  type McpProcessExit,
  type McpTransportDiagnostics,
} from "./errors";

/**
 * A process a sandbox runs with streamed stdin, stdout and stderr: what this
 * transport uses of the sandbox contract's `SandboxProcess`
 * (`Sandbox.spawn`), which a stdio MCP server runs as, so a `SandboxProcess`
 * is one.
 */
export interface SandboxProcessLike {
  /** Writes to stdin; rejects once the process exited. */
  write(data: Buffer | string): Promise<void>;
  /** Closes stdin. */
  endInput(): void;
  onOutput(
    listener: (chunk: Buffer, stream: "stdout" | "stderr") => void,
  ): () => void;
  readonly exited: Promise<McpProcessExit>;
  /** Stops the process and what it started; resolves with how it ended. */
  kill(): Promise<McpProcessExit>;
}

export interface SandboxStdioTransportOptions {
  /**
   * Starts the server's process in the sandbox (`sandbox.spawn(argv, …)`).
   * `signal` is aborted when the transport closes before it started.
   */
  launch(signal: AbortSignal): Promise<SandboxProcessLike>;
  /** Largest message either way, in bytes of its line; default 4 MiB. */
  maxMessageBytes?: number;
  /** stderr bytes kept, the latest ones; default 16 KiB. */
  maxStderrBytes?: number;
  /** How long the server may take to exit on its own once stdin is closed, before it is killed; default 500 ms. */
  closeGraceMs?: number;
}

/**
 * MCP over newline-delimited JSON on a sandbox process's stdin and stdout,
 * as pi-mcp's `StdioTransport` speaks it, but with the process started by a
 * sandbox driver instead of on the host. stderr is kept only as a ring of
 * its latest bytes, shown (redacted) when the server fails. A line longer
 * than the message cap closes the connection and kills the process.
 */
export class SandboxStdioTransport
  implements McpTransport, McpTransportDiagnostics
{
  private readonly options: SandboxStdioTransportOptions;
  private readonly maxMessageBytes: number;
  private readonly maxStderrBytes: number;
  private readonly messageListeners = new Set<McpTransportMessageListener>();
  private readonly errorListeners = new Set<McpTransportErrorListener>();
  private readonly closeListeners = new Set<McpTransportCloseListener>();
  private readonly launching = new AbortController();
  private process: SandboxProcessLike | undefined;
  private unsubscribe: (() => void) | undefined;
  private started = false;
  private closed = false;
  private closeEmitted = false;
  /** stdout received since the last newline. */
  private pending: Buffer[] = [];
  private pendingBytes = 0;
  private stderr = Buffer.alloc(0);
  private stderrWrapped = false;
  private exitValue: McpProcessExit | undefined;
  private closeReasonValue: string | undefined;

  constructor(options: SandboxStdioTransportOptions) {
    this.options = options;
    this.maxMessageBytes = options.maxMessageBytes ?? MCP_MAX_MESSAGE_BYTES;
    this.maxStderrBytes = options.maxStderrBytes ?? MCP_STDERR_RING_BYTES;
  }

  get exit(): McpProcessExit | undefined {
    return this.exitValue;
  }

  get closeReason(): string | undefined {
    return this.closeReasonValue;
  }

  stderrTail(): { text: string; cut: boolean } {
    return { text: this.stderr.toString("utf8"), cut: this.stderrWrapped };
  }

  async start(): Promise<void> {
    if (this.started) throw new Error("MCP stdio transport already started");
    if (this.closed) throw new McpConnectionClosedError();
    this.started = true;
    const process = await this.options.launch(this.launching.signal);
    if (this.closed) {
      // Closed while it started: it never serves anything.
      process.endInput();
      await process.kill().catch(() => undefined);
      throw new McpConnectionClosedError();
    }
    this.process = process;
    this.unsubscribe = process.onOutput((chunk, stream) => {
      if (stream === "stdout") this.handleStdout(chunk);
      else this.handleStderr(chunk);
    });
    void process.exited.then(
      (exit) => this.handleExit(exit),
      () => this.handleExit({ exitCode: null, interrupted: "unknown" }),
    );
  }

  async send(message: JsonRpcMessage): Promise<void> {
    const process = this.process;
    if (!this.started || this.closed || !process || this.exitValue)
      throw new McpConnectionClosedError();
    const line = `${JSON.stringify(message)}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > this.maxMessageBytes)
      throw new McpMessageTooLargeError(bytes, this.maxMessageBytes, "out");
    await process.write(line);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.launching.abort(new Error("MCP transport closed"));
    const process = this.process;
    if (process && !this.exitValue) {
      // As the spec asks: close stdin, give it a moment to exit, then kill it.
      process.endInput();
      const grace = this.options.closeGraceMs ?? 500;
      let timer: NodeJS.Timeout | undefined;
      const exitedInTime = await Promise.race([
        process.exited.then(
          () => true,
          () => true,
        ),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), grace);
        }),
      ]);
      if (timer) clearTimeout(timer);
      if (!exitedInTime) await process.kill().catch(() => undefined);
    }
    this.unsubscribe?.();
    this.emitClose();
  }

  onMessage(listener: McpTransportMessageListener): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onError(listener: McpTransportErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  onClose(listener: McpTransportCloseListener): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  private emitError(error: unknown) {
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    for (const listener of this.errorListeners) listener(normalized);
  }

  private emitClose() {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    for (const listener of this.closeListeners) listener();
  }

  private handleExit(exit: McpProcessExit) {
    if (this.exitValue) return;
    this.exitValue = exit;
    if (this.pendingBytes > 0 && !this.closed)
      this.emitError(
        new Error("The MCP server exited in the middle of a JSON-RPC message."),
      );
    this.pending = [];
    this.pendingBytes = 0;
    this.closed = true;
    this.unsubscribe?.();
    this.emitClose();
  }

  /** A message over the cap: the connection is closed and the process killed. */
  private tooLarge(bytes: number) {
    const error = new McpMessageTooLargeError(
      bytes,
      this.maxMessageBytes,
      "in",
    );
    this.closeReasonValue = error.message;
    this.pending = [];
    this.pendingBytes = 0;
    this.emitError(error);
    void this.close();
  }

  private handleStdout(chunk: Buffer) {
    if (this.closed || this.closeReasonValue) return;
    let rest = chunk;
    for (;;) {
      const newline = rest.indexOf(0x0a);
      if (newline < 0) {
        if (rest.length > 0) {
          this.pending.push(rest);
          this.pendingBytes += rest.length;
        }
        if (this.pendingBytes > this.maxMessageBytes)
          this.tooLarge(this.pendingBytes);
        return;
      }
      const head = rest.subarray(0, newline);
      rest = rest.subarray(newline + 1);
      const bytes = this.pendingBytes + head.length;
      const line =
        this.pending.length === 0
          ? head
          : Buffer.concat([...this.pending, head], bytes);
      this.pending = [];
      this.pendingBytes = 0;
      if (bytes > this.maxMessageBytes) {
        this.tooLarge(bytes);
        return;
      }
      this.handleLine(line.toString("utf8").replace(/\r$/, ""));
      if (this.closed) return;
    }
  }

  private handleLine(text: string) {
    if (!text.trim()) return;
    let message: JsonRpcMessage;
    try {
      message = parseJsonRpcMessage(JSON.parse(text));
    } catch (error) {
      this.emitError(error);
      return;
    }
    for (const listener of this.messageListeners) listener(message);
  }

  private handleStderr(chunk: Buffer) {
    const joined = Buffer.concat([this.stderr, chunk]);
    if (joined.length > this.maxStderrBytes) {
      this.stderr = Buffer.from(joined.subarray(-this.maxStderrBytes));
      this.stderrWrapped = true;
    } else this.stderr = joined;
  }
}
