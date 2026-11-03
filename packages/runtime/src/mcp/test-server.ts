// A tiny scripted MCP server for tests: it answers initialize, tools/list
// (paged) and tools/call from a script, records what the client sent, and
// speaks either over pi-mcp's in-memory transport or as a fake sandbox
// process on newline-delimited stdin and stdout.
import type {
  CallToolResult,
  JsonRpcId,
  JsonRpcMessage,
  McpTransport,
  Tool,
} from "@earendil-works/pi-mcp";
import type { Interrupted } from "@jj/sandbox";
import type { McpProcessExit } from "./errors";
import type { SandboxProcessLike } from "./stdio";

export interface ScriptedCallContext {
  /** Aborted when the client sends `notifications/cancelled` for this call. */
  signal: AbortSignal;
  /** Sends `notifications/progress` when the client asked for progress. */
  progress(progress: number, total?: number): void;
}

export interface ScriptedTool extends Omit<Tool, "inputSchema"> {
  inputSchema?: Record<string, unknown>;
  /** Answers a call; the default echoes the arguments as text. */
  call?(
    args: Record<string, unknown>,
    context: ScriptedCallContext,
  ): CallToolResult | Promise<CallToolResult>;
}

export interface ScriptedServerOptions {
  /** The tools it lists now; a function lets a test change them between listings. */
  tools: ScriptedTool[] | (() => ScriptedTool[]);
  /** Tools per tools/list page; default all on one. */
  pageSize?: number;
  /** Answers tools/list itself, in place of the paged `tools`. */
  listPage?(cursor: string | undefined): unknown;
  /** Never answer initialize (a server that hangs at start). */
  silentStart?: boolean;
  protocolVersion?: string;
  serverInfo?: { name: string; version: string };
  instructions?: string;
}

type Send = (message: JsonRpcMessage) => void;

export class ScriptedMcpServer {
  /** Every message the client sent, in order. */
  readonly received: JsonRpcMessage[] = [];
  /** Calls as the server received them. */
  readonly calls: { name: string; args: Record<string, unknown> }[] = [];
  /** Request ids the client cancelled, with its reason. */
  readonly cancelled: { requestId: JsonRpcId; reason?: string }[] = [];
  private readonly running = new Map<JsonRpcId, AbortController>();

  constructor(private readonly options: ScriptedServerOptions) {}

  private tools(): ScriptedTool[] {
    return typeof this.options.tools === "function"
      ? this.options.tools()
      : this.options.tools;
  }

  /** The `initialize` request's params, once received. */
  get initializeParams(): Record<string, unknown> | undefined {
    const request = this.received.find(
      (message) => "method" in message && message.method === "initialize",
    );
    return request && "params" in request
      ? (request.params as Record<string, unknown>)
      : undefined;
  }

  handle(message: JsonRpcMessage, send: Send): void {
    this.received.push(message);
    if (!("method" in message)) return;
    const params = (
      "params" in message && message.params ? message.params : {}
    ) as Record<string, unknown>;
    if (!("id" in message)) {
      if (message.method === "notifications/cancelled") {
        const requestId = params.requestId as JsonRpcId;
        this.cancelled.push({
          requestId,
          ...(typeof params.reason === "string"
            ? { reason: params.reason }
            : {}),
        });
        this.running.get(requestId)?.abort();
      }
      return;
    }
    const { id } = message;
    const reply = (result: unknown) => send({ jsonrpc: "2.0", id, result });
    const fail = (code: number, text: string) =>
      send({ jsonrpc: "2.0", id, error: { code, message: text } });
    switch (message.method) {
      case "initialize":
        if (this.options.silentStart) return;
        reply({
          protocolVersion: this.options.protocolVersion ?? "2025-11-25",
          capabilities: { tools: { listChanged: true } },
          serverInfo: this.options.serverInfo ?? {
            name: "scripted",
            version: "1.0.0",
          },
          ...(this.options.instructions
            ? { instructions: this.options.instructions }
            : {}),
        });
        return;
      case "ping":
        reply({});
        return;
      case "tools/list": {
        if (this.options.listPage) {
          reply(
            this.options.listPage(
              typeof params.cursor === "string" ? params.cursor : undefined,
            ),
          );
          return;
        }
        const all = this.tools().map(({ call: _call, ...tool }) => ({
          inputSchema: { type: "object" },
          ...tool,
        }));
        const size = this.options.pageSize ?? all.length;
        const start =
          typeof params.cursor === "string" ? Number(params.cursor) : 0;
        const page = all.slice(start, start + size);
        const next =
          start + size < all.length ? String(start + size) : undefined;
        reply({ tools: page, ...(next ? { nextCursor: next } : {}) });
        return;
      }
      case "tools/call": {
        const name = String(params.name);
        const args = (params.arguments ?? {}) as Record<string, unknown>;
        this.calls.push({ name, args });
        const tool = this.tools().find((candidate) => candidate.name === name);
        if (!tool) {
          fail(-32602, `Unknown tool: ${name}`);
          return;
        }
        const controller = new AbortController();
        this.running.set(id, controller);
        const token = (
          params._meta as { progressToken?: JsonRpcId } | undefined
        )?.progressToken;
        const context: ScriptedCallContext = {
          signal: controller.signal,
          progress: (progress, total) => {
            if (token === undefined) return;
            send({
              jsonrpc: "2.0",
              method: "notifications/progress",
              params: {
                progressToken: token,
                progress,
                ...(total === undefined ? {} : { total }),
              },
            });
          },
        };
        Promise.resolve()
          .then(() =>
            tool.call
              ? tool.call(args, context)
              : { content: [{ type: "text", text: JSON.stringify(args) }] },
          )
          .then(
            (result) => {
              if (!controller.signal.aborted) reply(result);
            },
            (error: unknown) =>
              fail(
                -32603,
                error instanceof Error ? error.message : String(error),
              ),
          )
          .finally(() => this.running.delete(id));
        return;
      }
      default:
        fail(-32601, `Method not found: ${message.method}`);
    }
  }

  /** Serves the server end of pi-mcp's in-memory transport pair. */
  attach(transport: McpTransport): void {
    transport.onMessage((message) =>
      this.handle(message, (reply) => {
        void transport.send(reply).catch(() => {});
      }),
    );
    void transport.start();
  }
}

/**
 * A sandbox process in memory: stdin lines go to a scripted server (or a
 * handler), and the test writes stdout and stderr and decides when it exits.
 */
export class FakeSandboxProcess implements SandboxProcessLike {
  readonly stdin: string[] = [];
  inputEnded = false;
  killed = false;
  private readonly listeners = new Set<
    (chunk: Buffer, stream: "stdout" | "stderr") => void
  >();
  private buffered = "";
  private settle!: (exit: McpProcessExit) => void;
  private done = false;
  readonly exited: Promise<McpProcessExit>;

  constructor(
    private readonly server?: ScriptedMcpServer,
    private readonly options: { exitOnEndInput?: boolean } = {},
  ) {
    this.exited = new Promise((resolve) => {
      this.settle = resolve;
    });
  }

  async write(data: Buffer | string): Promise<void> {
    if (this.done) throw new Error("The process has exited.");
    this.buffered += data.toString();
    let newline = this.buffered.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);
      this.stdin.push(line);
      if (this.server && line.trim())
        this.server.handle(JSON.parse(line) as JsonRpcMessage, (reply) =>
          queueMicrotask(() => this.stdout(`${JSON.stringify(reply)}\n`)),
        );
      newline = this.buffered.indexOf("\n");
    }
  }

  endInput(): void {
    this.inputEnded = true;
    if (this.options.exitOnEndInput) this.exit(0);
  }

  onOutput(
    listener: (chunk: Buffer, stream: "stdout" | "stderr") => void,
  ): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async kill(): Promise<McpProcessExit> {
    this.killed = true;
    this.exit(null, "yes", "kill");
    return this.exited;
  }

  stdout(data: string | Buffer): void {
    if (this.done) return;
    const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
    for (const listener of this.listeners) listener(chunk, "stdout");
  }

  stderr(data: string): void {
    if (this.done) return;
    for (const listener of this.listeners)
      listener(Buffer.from(data), "stderr");
  }

  exit(
    exitCode: number | null,
    interrupted: Interrupted = "no",
    interruptReason?: string,
  ): void {
    if (this.done) return;
    this.done = true;
    this.settle({
      exitCode,
      interrupted,
      ...(interruptReason ? { interruptReason } : {}),
    });
  }
}
