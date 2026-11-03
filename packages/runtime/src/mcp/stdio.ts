import {
  type JsonRpcMessage,
  McpAbortError,
  McpConnectionClosedError,
  type McpTransport,
  type McpTransportCloseListener,
  type McpTransportErrorListener,
  type McpTransportMessageListener,
  type McpTransportSendOptions,
  parseJsonRpcMessage,
} from "@earendil-works/pi-mcp";
import type { SandboxProcess } from "@jj/sandbox";
import {
  MCP_MAX_MESSAGE_BYTES,
  MCP_STDERR_RING_BYTES,
  McpMessageTooLargeError,
  type McpProcessExit,
  type McpTransportDiagnostics,
} from "./errors";

export interface SandboxStdioTransportOptions {
  /**
   * Starts the server's process in the sandbox:
   * `sandbox.spawn(argv, { cwd, env, signal })`. `signal` is aborted when
   * the transport closes before it started.
   */
  launch(signal: AbortSignal): Promise<SandboxProcess>;
  /** Largest message either way, in bytes of its line; default 4 MiB. */
  maxMessageBytes?: number;
  /** stderr bytes kept, the latest ones; default 16 KiB. */
  maxStderrBytes?: number;
  /** How long the server may take to exit on its own once stdin is closed, before it is killed; default 500 ms. */
  closeGraceMs?: number;
  /**
   * How long one write may wait for the process to take it, default 30 s.
   * A process that stops reading its stdin is broken: the connection is
   * closed and the process stopped.
   */
  writeTimeoutMs?: number;
}

/** stderr chunks the ring holds at most before it joins them, so it holds bytes, not a buffer per chunk. */
const MAX_STDERR_CHUNKS = 64;

const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`;

/**
 * MCP over newline-delimited JSON on a sandbox process's stdin and stdout,
 * as pi-mcp's `StdioTransport` speaks it, but with the process started by a
 * sandbox driver instead of on the host. stderr is kept only as a ring of
 * its latest bytes, shown (redacted) when the server fails. A line longer
 * than the message cap closes the connection and kills the process. Every
 * write is bounded: by its request's signal (a request that timed out or
 * was cancelled stops waiting), and by `writeTimeoutMs`, after which the
 * process is taken to have stopped reading and the connection is closed.
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
  private process: SandboxProcess | undefined;
  private unsubscribe: (() => void) | undefined;
  private started = false;
  private closed = false;
  private closeEmitted = false;
  /** stdout received since the last newline: the first `lineBytes` of `line`. */
  private line = Buffer.alloc(0);
  private lineBytes = 0;
  /** The latest stderr chunks, at most `maxStderrBytes` beyond the first. */
  private stderr: Buffer[] = [];
  private stderrBytes = 0;
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
    const joined = Buffer.concat(this.stderr, this.stderrBytes);
    const kept =
      joined.length > this.maxStderrBytes
        ? joined.subarray(-this.maxStderrBytes)
        : joined;
    return {
      text: kept.toString("utf8"),
      cut: this.stderrWrapped || kept.length < joined.length,
    };
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

  async send(
    message: JsonRpcMessage,
    options: McpTransportSendOptions = {},
  ): Promise<void> {
    const process = this.process;
    if (!this.started || this.closed || !process || this.exitValue)
      throw new McpConnectionClosedError();
    const line = `${JSON.stringify(message)}\n`;
    const bytes = Buffer.byteLength(line);
    if (bytes > this.maxMessageBytes)
      throw new McpMessageTooLargeError(bytes, this.maxMessageBytes, "out");
    const { signal } = options;
    if (signal?.aborted) throw new McpAbortError();
    const timeoutMs = this.options.writeTimeoutMs ?? 30_000;
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    try {
      await Promise.race([
        process.write(line),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(new McpAbortError());
          signal?.addEventListener("abort", onAbort, { once: true });
          timer = setTimeout(() => {
            // It stopped reading its input: the connection is broken, and
            // the write fails once it is closed and the process stopped.
            this.closeReasonValue ??= `The MCP server stopped reading its input for ${seconds(timeoutMs)}; the connection was closed.`;
            const reason = this.closeReasonValue;
            void this.close()
              .catch(() => {})
              .finally(() => reject(new McpConnectionClosedError(reason)));
          }, timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    // Only a launch still under way: aborting a spawn's signal later kills
    // the process, and a running server is first given its stdin's end.
    if (!this.process) this.launching.abort(new Error("MCP transport closed"));
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
    if (this.lineBytes > 0 && !this.closed)
      this.emitError(
        new Error("The MCP server exited in the middle of a JSON-RPC message."),
      );
    this.dropLine();
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
    this.dropLine();
    this.emitError(error);
    void this.close();
  }

  /** Forgets the line being received, and a large buffer it grew. */
  private dropLine() {
    this.lineBytes = 0;
    if (this.line.length > 64 * 1024) this.line = Buffer.alloc(0);
  }

  /**
   * Adds bytes to the line being received. The buffer doubles as it fills,
   * so a line sent a byte at a time costs its bytes, copied a constant
   * number of times each, never a buffer object per chunk.
   */
  private appendLine(bytes: Buffer) {
    const needed = this.lineBytes + bytes.length;
    if (needed > this.line.length) {
      const grown = Buffer.allocUnsafe(
        Math.max(needed, this.line.length * 2, 1024),
      );
      this.line.copy(grown, 0, 0, this.lineBytes);
      this.line = grown;
    }
    bytes.copy(this.line, this.lineBytes);
    this.lineBytes = needed;
  }

  private handleStdout(chunk: Buffer) {
    if (this.closed || this.closeReasonValue) return;
    let rest = chunk;
    for (;;) {
      const newline = rest.indexOf(0x0a);
      const head = newline < 0 ? rest : rest.subarray(0, newline);
      // Counted as it arrives: nothing past the cap is ever held.
      if (this.lineBytes + head.length > this.maxMessageBytes) {
        this.tooLarge(this.lineBytes + head.length);
        return;
      }
      if (newline < 0) {
        if (head.length > 0) this.appendLine(head);
        return;
      }
      let line = head;
      if (this.lineBytes > 0) {
        this.appendLine(head);
        line = this.line.subarray(0, this.lineBytes);
      }
      // Decoded before the buffer is reused for the next line.
      const text = line.toString("utf8").replace(/\r$/, "");
      this.dropLine();
      rest = rest.subarray(newline + 1);
      this.handleLine(text);
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

  /**
   * Keeps the chunk, dropping whole chunks the ring no longer needs, so most
   * chunks cost no copy; many small ones, or one far over the ring, are
   * joined into the ring's latest bytes.
   */
  private handleStderr(chunk: Buffer) {
    const max = this.maxStderrBytes;
    this.stderr.push(chunk);
    this.stderrBytes += chunk.length;
    while (
      this.stderr.length > 1 &&
      this.stderrBytes - (this.stderr[0]?.length ?? 0) >= max
    ) {
      this.stderrBytes -= this.stderr.shift()?.length ?? 0;
      this.stderrWrapped = true;
    }
    if (this.stderr.length > MAX_STDERR_CHUNKS || this.stderrBytes > max * 2) {
      const joined = Buffer.concat(this.stderr, this.stderrBytes);
      const kept = Buffer.from(joined.subarray(-max));
      if (kept.length < joined.length) this.stderrWrapped = true;
      this.stderr = [kept];
      this.stderrBytes = kept.length;
    }
  }
}
