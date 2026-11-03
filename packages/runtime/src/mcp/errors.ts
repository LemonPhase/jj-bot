import type { Interrupted } from "@jj/sandbox";

/** Largest MCP message either way, in bytes: a larger one closes the connection. */
export const MCP_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
/** stderr of a stdio server kept, its latest bytes. */
export const MCP_STDERR_RING_BYTES = 16 * 1024;
/** Longest stderr tail shown with a failure (the contract's `stderrTail` cap). */
export const MCP_STDERR_TAIL_CHARS = 2_000;

/** How a stdio server's process ended, as the sandbox reported it. */
export interface McpProcessExit {
  exitCode: number | null;
  interrupted: Interrupted;
  interruptReason?: string;
}

/** What a transport can tell about why its connection ended. */
export interface McpTransportDiagnostics {
  /** Set once the server's process exited (stdio). */
  readonly exit?: McpProcessExit;
  /** Why the transport closed the connection itself, such as a message over the cap. */
  readonly closeReason?: string;
  /** The latest stderr the server wrote (stdio); `cut` when older output was dropped. */
  stderrTail?(): { text: string; cut: boolean };
  /**
   * Secret values the transport sends (a remote server's header values,
   * without their prefixes): the connection replaces them in everything it
   * reports, before the server's own redactor runs.
   */
  readonly secrets?: readonly string[];
}

/** A message over MCP_MAX_MESSAGE_BYTES. Received, it closes the connection; to be sent, it is refused. */
export class McpMessageTooLargeError extends Error {
  constructor(
    readonly bytes: number,
    readonly limit: number,
    readonly direction: "in" | "out",
  ) {
    super(
      direction === "in"
        ? `The MCP server sent a message over ${limit} bytes; the connection was closed.`
        : `The MCP message would be ${bytes} bytes, over the ${limit}-byte limit; it was not sent.`,
    );
    this.name = "McpMessageTooLargeError";
  }
}

/** Why a remote server was not contacted: the guard refused the URL, an address or a response. */
export class McpRemoteRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpRemoteRefusedError";
  }
}

/**
 * What went wrong with a server or one of its calls.
 *
 * - `startup`: the server did not start or answer `initialize` in time.
 * - `timeout`: a call ran past its timeout; `notifications/cancelled` was sent.
 * - `aborted`: the run stopped (or reached its deadline) while the call ran;
 *   `notifications/cancelled` was sent. Before it was sent: `interrupted: "yes"`.
 * - `exited`: the server's process exited while the call ran.
 * - `closed`: the connection closed while the call ran (a message over the
 *   cap, a dropped connection, the server closing it).
 * - `server`: the server answered the request with a JSON-RPC error.
 * - `refused`: the remote guard refused the server or the connection.
 * - `protocol`: anything else.
 *
 * `interrupted` follows the sandbox's meaning: `unknown` when the request was
 * sent and its effects are not known, `no` when the server answered.
 */
export type McpErrorKind =
  | "startup"
  | "timeout"
  | "aborted"
  | "exited"
  | "closed"
  | "server"
  | "refused"
  | "protocol";

export class McpServerError extends Error {
  readonly kind: McpErrorKind;
  readonly interrupted: Interrupted;
  /** The server's latest stderr, redacted (stdio). */
  readonly stderrTail?: string;
  /** The process's exit code (stdio, `exited`). */
  readonly exitCode?: number | null;

  constructor(
    kind: McpErrorKind,
    message: string,
    details: {
      interrupted?: Interrupted;
      stderrTail?: string;
      exitCode?: number | null;
    } = {},
  ) {
    super(message);
    this.name = "McpServerError";
    this.kind = kind;
    this.interrupted = details.interrupted ?? "no";
    if (details.stderrTail !== undefined) this.stderrTail = details.stderrTail;
    if (details.exitCode !== undefined) this.exitCode = details.exitCode;
  }
}
