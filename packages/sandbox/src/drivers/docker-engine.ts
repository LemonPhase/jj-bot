import {
  Agent,
  type ClientRequest,
  request as httpRequest,
  type IncomingMessage,
  type RequestOptions,
} from "node:http";
import type { Socket } from "node:net";

/**
 * Minimal Docker Engine API client over Node's `http`: JSON calls, streamed
 * pulls, and exec attach streams (hijacked connections, demultiplexed). No
 * third-party dependency, so a filtering socket proxy in front of the daemon
 * only ever sees plain Engine API requests.
 */

/** Where the Engine API listens: a Unix socket or a plain-HTTP TCP address. */
export type DockerEndpoint =
  | { kind: "unix"; socketPath: string }
  | { kind: "tcp"; host: string; port: number };

export const DEFAULT_DOCKER_SOCKET = "/var/run/docker.sock";

/** Oldest and newest Engine API versions this client speaks; the daemon's own version is used when it lies between. */
const MIN_API_VERSION = "1.41";
const MAX_API_VERSION = "1.47";
const REQUEST_TIMEOUT_MS = 60_000;

/**
 * Parses a `DOCKER_HOST` value: `unix:///path/to.sock` or `tcp://host[:port]`
 * (plain HTTP, default port 2375). Unset means the default socket. TLS
 * (`DOCKER_TLS_VERIFY`) is not supported: a TLS daemon is reached through a
 * local proxy instead of being silently spoken to in clear text.
 */
export function parseDockerHost(
  value: string | undefined,
  tlsVerify: string | undefined = undefined,
): DockerEndpoint {
  if (tlsVerify !== undefined && tlsVerify !== "" && tlsVerify !== "0")
    throw new Error(
      "DOCKER_TLS_VERIFY is set, but the docker sandbox driver speaks plain HTTP only; reach a TLS daemon through a local proxy on a unix:// or tcp:// address",
    );
  if (value === undefined || value.trim() === "")
    return { kind: "unix", socketPath: DEFAULT_DOCKER_SOCKET };
  const host = value.trim();
  if (host.startsWith("unix://")) {
    const socketPath = host.slice("unix://".length);
    if (!socketPath.startsWith("/"))
      throw new Error(`DOCKER_HOST ${host}: expected an absolute socket path`);
    return { kind: "unix", socketPath };
  }
  if (host.startsWith("tcp://")) {
    let url: URL;
    try {
      url = new URL(`http://${host.slice("tcp://".length)}`);
    } catch {
      throw new Error(`DOCKER_HOST ${host}: not a valid tcp:// address`);
    }
    if (url.pathname !== "/" || url.search || url.username)
      throw new Error(`DOCKER_HOST ${host}: expected tcp://host[:port]`);
    return {
      kind: "tcp",
      host: url.hostname.replace(/^\[(.*)\]$/, "$1"),
      port: url.port ? Number(url.port) : 2375,
    };
  }
  throw new Error(
    `DOCKER_HOST ${host}: unsupported scheme; use unix:// or tcp://`,
  );
}

export function describeEndpoint(endpoint: DockerEndpoint): string {
  return endpoint.kind === "unix"
    ? `unix://${endpoint.socketPath}`
    : `tcp://${endpoint.host}:${endpoint.port}`;
}

/** A non-2xx answer from the Engine API. */
export class DockerApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "DockerApiError";
  }
}

export const isNotFound = (error: unknown) =>
  error instanceof DockerApiError && error.status === 404;

type Query = Record<string, string | number | boolean | undefined>;

export interface RequestInit {
  query?: Query;
  /** JSON-encoded unless it is a Buffer. */
  body?: unknown;
  contentType?: string;
  signal?: AbortSignal;
  /** Default 60 s; 0 disables it. */
  timeoutMs?: number;
  /** Unversioned path, for `/_ping` and `/version`. */
  unversioned?: boolean;
}

function compareVersions(a: string, b: string): number {
  const [aMajor = 0, aMinor = 0] = a.split(".").map(Number);
  const [bMajor = 0, bMinor = 0] = b.split(".").map(Number);
  return aMajor - bMajor || aMinor - bMinor;
}

function buildPath(path: string, query?: Query): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) params.set(key, String(value));
  const encoded = params.toString();
  return encoded ? `${path}?${encoded}` : path;
}

async function readBody(response: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of response) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function apiError(status: number, body: Buffer): DockerApiError {
  const text = body.toString("utf8").trim();
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    if (typeof parsed.message === "string")
      return new DockerApiError(status, parsed.message);
  } catch {
    // Not JSON.
  }
  return new DockerApiError(status, text || `HTTP ${status}`);
}

/**
 * Splits Docker's multiplexed attach stream (8-byte header: stream type, three
 * zero bytes, big-endian payload length) and forwards payloads as they arrive,
 * without buffering whole frames.
 */
export class StreamDemuxer {
  private readonly header = Buffer.alloc(8);
  private headerFill = 0;
  private stream = 0;
  private remaining = 0;

  constructor(private readonly emit: (stream: number, chunk: Buffer) => void) {}

  push(chunk: Buffer): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.remaining === 0) {
        const take = Math.min(8 - this.headerFill, chunk.length - offset);
        chunk.copy(this.header, this.headerFill, offset, offset + take);
        this.headerFill += take;
        offset += take;
        if (this.headerFill < 8) return;
        this.headerFill = 0;
        this.stream = this.header[0] ?? 0;
        this.remaining = this.header.readUInt32BE(4);
        continue;
      }
      const take = Math.min(this.remaining, chunk.length - offset);
      this.emit(this.stream, chunk.subarray(offset, offset + take));
      this.remaining -= take;
      offset += take;
    }
  }
}

export interface ExecConfig {
  Cmd: string[];
  Env: string[];
  User: string;
  WorkingDir?: string;
  AttachStdin?: boolean;
}

export interface ExecInspect {
  Running: boolean;
  ExitCode: number | null;
}

/** A started exec. `ended` resolves once the attach stream closes. */
export interface AttachedExec {
  ended: Promise<void>;
  /** Drops the connection; the command itself keeps running. */
  destroy(): void;
}

export interface ExecOutput {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
}

export class DockerEngine {
  private readonly agent: Agent;
  private versionPrefix?: Promise<string>;

  constructor(readonly endpoint: DockerEndpoint) {
    this.agent = new Agent({ keepAlive: true, maxSockets: 64 });
  }

  private target(): RequestOptions {
    return this.endpoint.kind === "unix"
      ? { socketPath: this.endpoint.socketPath }
      : { host: this.endpoint.host, port: this.endpoint.port };
  }

  /** The `/vX.Y` prefix, negotiated once with the daemon. */
  apiVersion(): Promise<string> {
    this.versionPrefix ??= (async () => {
      const version = (await this.json("GET", "/version", {
        unversioned: true,
        timeoutMs: 10_000,
      })) as { ApiVersion?: string; MinAPIVersion?: string };
      const server = version.ApiVersion ?? MIN_API_VERSION;
      if (compareVersions(server, MIN_API_VERSION) < 0)
        throw new Error(
          `Docker Engine API ${server} is older than the ${MIN_API_VERSION} the docker sandbox driver needs`,
        );
      if (compareVersions(server, MAX_API_VERSION) <= 0) return server;
      // Prefer the newest version this client knows, unless the daemon has dropped it.
      const oldest = version.MinAPIVersion;
      return oldest && compareVersions(oldest, MAX_API_VERSION) > 0
        ? oldest
        : MAX_API_VERSION;
    })();
    this.versionPrefix.catch(() => {
      this.versionPrefix = undefined;
    });
    return this.versionPrefix;
  }

  private async path(path: string, init: RequestInit): Promise<string> {
    const full = buildPath(path, init.query);
    return init.unversioned ? full : `/v${await this.apiVersion()}${full}`;
  }

  /** Sends a request and resolves with the response, whatever its status. */
  async send(
    method: string,
    path: string,
    init: RequestInit = {},
  ): Promise<IncomingMessage> {
    const fullPath = await this.path(path, init);
    const payload =
      init.body === undefined
        ? undefined
        : Buffer.isBuffer(init.body)
          ? init.body
          : Buffer.from(JSON.stringify(init.body));
    const headers: Record<string, string | number> = {};
    if (payload) {
      headers["Content-Type"] = init.contentType ?? "application/json";
      headers["Content-Length"] = payload.length;
    }
    return new Promise((resolve, reject) => {
      const req: ClientRequest = httpRequest({
        ...this.target(),
        agent: this.agent,
        method,
        path: fullPath,
        headers,
        signal: init.signal,
      });
      const timeoutMs = init.timeoutMs ?? REQUEST_TIMEOUT_MS;
      if (timeoutMs > 0)
        req.setTimeout(timeoutMs, () =>
          req.destroy(
            new Error(
              `Docker API ${method} ${path} timed out after ${timeoutMs} ms`,
            ),
          ),
        );
      req.once("error", (error) =>
        reject(this.connectionError(error, method, path)),
      );
      req.once("response", (response) => {
        req.setTimeout(0);
        resolve(response);
      });
      req.end(payload);
    });
  }

  private connectionError(error: Error, method: string, path: string): Error {
    if (error.name === "AbortError") return error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ECONNREFUSED" || code === "EACCES")
      return new Error(
        `Docker Engine unreachable at ${describeEndpoint(this.endpoint)} (${code})`,
      );
    return new Error(`Docker API ${method} ${path} failed: ${error.message}`);
  }

  /** JSON request; throws `DockerApiError` on a non-2xx status. */
  async json<T = unknown>(
    method: string,
    path: string,
    init: RequestInit = {},
  ): Promise<T> {
    const response = await this.send(method, path, init);
    const body = await readBody(response);
    const status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) throw apiError(status, body);
    if (body.length === 0) return undefined as T;
    const type = response.headers["content-type"] ?? "";
    if (!type.includes("json")) return body.toString("utf8") as T;
    return JSON.parse(body.toString("utf8")) as T;
  }

  ping(timeoutMs = 3_000): Promise<string> {
    return this.json<string>("GET", "/_ping", { unversioned: true, timeoutMs });
  }

  /**
   * Pulls an image, reading the progress stream to the end. A pull can fail
   * inside a 200 response, reported as an `error` line.
   */
  async pull(image: string, signal?: AbortSignal): Promise<void> {
    const { repository, tag } = splitReference(image);
    const response = await this.send("POST", "/images/create", {
      query: { fromImage: repository, tag },
      signal,
      timeoutMs: 0,
    });
    const body = await readBody(response);
    const status = response.statusCode ?? 0;
    if (status < 200 || status >= 300) throw apiError(status, body);
    for (const line of body.toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as { error?: string };
        if (event.error) throw new DockerApiError(500, event.error);
      } catch (error) {
        if (error instanceof DockerApiError) throw error;
      }
    }
  }

  async createExec(container: string, config: ExecConfig): Promise<string> {
    const created = await this.json<{ Id: string }>(
      "POST",
      `/containers/${encodeURIComponent(container)}/exec`,
      {
        body: {
          ...config,
          AttachStdin: config.AttachStdin ?? false,
          AttachStdout: true,
          AttachStderr: true,
          Tty: false,
        },
      },
    );
    return created.Id;
  }

  /**
   * Starts an exec on a hijacked connection. Output is demultiplexed into
   * `onOutput` as it arrives. `stdin`, when given, is written and then
   * half-closed so the command sees end-of-file.
   */
  async startExec(
    execId: string,
    onOutput: (stream: "stdout" | "stderr", chunk: Buffer) => void,
    stdin?: Buffer,
  ): Promise<AttachedExec> {
    const fullPath = await this.path(
      `/exec/${encodeURIComponent(execId)}/start`,
      {},
    );
    const payload = Buffer.from(JSON.stringify({ Detach: false, Tty: false }));
    const demuxer = new StreamDemuxer((stream, chunk) => {
      if (stream === 1) onOutput("stdout", chunk);
      else if (stream === 2 || stream === 3) onOutput("stderr", chunk);
    });
    return new Promise((resolve, reject) => {
      const req = httpRequest({
        ...this.target(),
        agent: false,
        method: "POST",
        path: fullPath,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": payload.length,
          Connection: "Upgrade",
          Upgrade: "tcp",
        },
      });
      req.setTimeout(REQUEST_TIMEOUT_MS, () =>
        req.destroy(new Error("Docker API exec start timed out")),
      );
      const attach = (stream: Socket | IncomingMessage, head?: Buffer) => {
        // A command may stay silent for longer than any request timeout.
        req.setTimeout(0);
        const socket = "socket" in stream ? stream.socket : stream;
        socket?.setTimeout(0);
        if (head && head.length > 0) demuxer.push(head);
        const ended = new Promise<void>((done) => {
          stream.on("data", (chunk: Buffer) => demuxer.push(chunk));
          stream.once("end", done);
          stream.once("close", done);
          stream.once("error", () => done());
        });
        resolve({ ended, destroy: () => stream.destroy() });
      };
      req.once("upgrade", (_response, socket, head) => {
        attach(socket, head);
        if (stdin === undefined) return;
        // Half-close: the daemon closes the command's stdin on end-of-file.
        if (stdin.length > 0) socket.write(stdin);
        socket.end();
      });
      req.once("response", (response) => {
        const status = response.statusCode ?? 0;
        if (status >= 200 && status < 300 && !stdin) return attach(response);
        readBody(response).then(
          (body) =>
            reject(
              status >= 200 && status < 300
                ? new Error("Docker daemon did not upgrade the exec connection")
                : apiError(status, body),
            ),
          reject,
        );
      });
      req.once("error", (error) =>
        reject(this.connectionError(error, "POST", "/exec/start")),
      );
      req.end(payload);
    });
  }

  inspectExec(execId: string): Promise<ExecInspect> {
    return this.json<ExecInspect>(
      "GET",
      `/exec/${encodeURIComponent(execId)}/json`,
    );
  }

  /** Runs a command to completion and collects its output (for driver helpers, not agent commands). */
  async run(
    container: string,
    config: ExecConfig,
    stdin?: Buffer,
  ): Promise<ExecOutput> {
    const execId = await this.createExec(container, {
      ...config,
      AttachStdin: stdin !== undefined,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const attached = await this.startExec(
      execId,
      (stream, chunk) => (stream === "stdout" ? stdout : stderr).push(chunk),
      stdin,
    );
    await attached.ended;
    const { ExitCode: exitCode } = await this.waitExec(execId);
    return {
      exitCode,
      stdout: Buffer.concat(stdout),
      stderr: Buffer.concat(stderr),
    };
  }

  /**
   * Waits until the exec's process has exited. Its output stream can close
   * first, when the command closes stdout and stderr but keeps running.
   */
  async waitExec(
    execId: string,
    shouldStop: () => boolean = () => false,
  ): Promise<ExecInspect> {
    for (let pause = 5; ; pause = Math.min(pause * 2, 250)) {
      const state = await this.inspectExec(execId);
      if (!state.Running || shouldStop()) return state;
      await new Promise((done) => setTimeout(done, pause));
    }
  }

  close(): void {
    this.agent.destroy();
  }
}

/** Splits an image reference into the `fromImage` and `tag` the pull endpoint takes. */
export function splitReference(image: string): {
  repository: string;
  tag: string;
} {
  const at = image.indexOf("@");
  if (at >= 0)
    return { repository: image.slice(0, at), tag: image.slice(at + 1) };
  const slash = image.lastIndexOf("/");
  const colon = image.lastIndexOf(":");
  if (colon > slash)
    return { repository: image.slice(0, colon), tag: image.slice(colon + 1) };
  return { repository: image, tag: "latest" };
}

/** A tar archive holding one directory entry, `name/` (no leading slash). */
export function directoryTar(name: string, mode = 0o755): Buffer {
  const header = Buffer.alloc(512);
  const entry = `${name.replace(/\/+$/, "")}/`;
  if (Buffer.byteLength(entry) > 100)
    throw new Error(`Directory name too long for a tar header: ${name}`);
  const octal = (value: number, width: number) =>
    `${value.toString(8).padStart(width - 1, "0")}\0`;
  header.write(entry, 0, "utf8");
  header.write(octal(mode, 8), 100, "ascii");
  header.write(octal(0, 8), 108, "ascii");
  header.write(octal(0, 8), 116, "ascii");
  header.write(octal(0, 12), 124, "ascii");
  header.write(octal(Math.floor(Date.now() / 1000), 12), 136, "ascii");
  header.write("        ", 148, "ascii");
  header.write("5", 156, "ascii");
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
  return Buffer.concat([header, Buffer.alloc(1024)]);
}
