// Test helpers: the real wiring on in-memory PGlite, the `local` driver under
// a temporary root and the keyless scripted model, plus HTTP and SSE helpers.
// Not part of the app.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineConfigInput, Logger } from "@jj/backend";
import type { TaskView } from "@jj/contracts";
import { type AppConfig, createApp, type JJApp } from "./app";
import { openServices, type Services } from "./wiring";

export const OPEN_TIMEOUT = 60_000;

export const quietLogger: Logger & {
  lines: { level: string; message: string; details?: unknown }[];
} = {
  lines: [],
  info(message, details) {
    quietLogger.lines.push({ level: "info", message, details });
  },
  warn(message, details) {
    quietLogger.lines.push({ level: "warn", message, details });
  },
  error(message, details) {
    quietLogger.lines.push({ level: "error", message, details });
  },
};

export interface TestApp extends Services {
  app: JJApp;
  root: string;
  /** A JSON request through `app.request`; returns the status and parsed body. */
  call(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: any; headers: Headers }>;
  dispose(): Promise<void>;
}

export interface TestAppOptions {
  app?: Partial<AppConfig>;
  engine?: EngineConfigInput;
  /** Start the embedded worker (default true). */
  startWorker?: boolean;
}

export async function testApp(options: TestAppOptions = {}): Promise<TestApp> {
  const root = await mkdtemp(join(tmpdir(), "jj-api-test-"));
  const services = await openServices(
    {
      database: { mode: "pglite", path: "memory://" },
      drivers: ["local"],
      localRoot: root,
      dockerNamespace: "jj-sandbox",
      dockerAllowInsecureTcp: false,
      enableScripted: true,
      engine: {
        pollIntervalMs: 25,
        leaseMs: 5_000,
        streamPollMs: 200,
        persistence: false,
        ...options.engine,
      },
    },
    {},
    quietLogger,
  );
  const startWorker = options.startWorker !== false;
  if (startWorker) await services.engine.worker.start();
  const app = createApp({
    engine: services.engine,
    logger: quietLogger,
    config: { workerEmbedded: startWorker, ...options.app },
  });
  return {
    ...services,
    app,
    root,
    async call(method, path, body, headers = {}) {
      const response = await app.request(path, {
        method,
        headers: {
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
        body:
          body === undefined
            ? undefined
            : typeof body === "string"
              ? body
              : JSON.stringify(body),
      });
      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        // Not JSON: the raw text.
      }
      return {
        status: response.status,
        body: parsed,
        headers: response.headers,
      };
    },
    async dispose() {
      app.endStreams();
      await services.engine.worker.stop();
      await services.database.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/**
 * Counts bus subscriptions opened from now on and not yet closed. The engine
 * holds the same bus object, so every stream's subscription is counted.
 */
export function countSubscriptions(database: Services["database"]) {
  const bus = database.bus;
  const original = bus.subscribe.bind(bus);
  let open = 0;
  bus.subscribe = (async (channel, handler) => {
    const unsubscribe = await original(channel, handler);
    open += 1;
    let closed = false;
    return async () => {
      if (!closed) {
        closed = true;
        open -= 1;
      }
      await unsubscribe();
    };
  }) as typeof bus.subscribe;
  return {
    get open() {
      return open;
    },
  };
}

export const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Polls until `check` returns a truthy value. */
export async function until<T>(
  check: () => Promise<T | undefined | null | false> | T | undefined | null,
  { timeoutMs = 20_000, what = "a condition" } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(25);
  }
}

export async function untilTask(
  t: TestApp,
  taskId: string,
  check: (view: TaskView) => boolean,
  what = "the task",
): Promise<TaskView> {
  return until(
    async () => {
      const { body } = await t.call("GET", `/api/tasks/${taskId}`);
      return check(body as TaskView) ? (body as TaskView) : undefined;
    },
    { what },
  );
}

export interface SseFrame {
  id?: string;
  event?: string;
  data: string;
}

/** Reads a `text/event-stream` body frame by frame, keeping comments too. */
export class SseReader {
  readonly frames: SseFrame[] = [];
  readonly comments: string[] = [];
  raw = "";
  private buffer = "";
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private done = false;

  constructor(response: Response) {
    if (!response.body) throw new Error("The response has no body.");
    this.reader = response.body.getReader();
  }

  private parse() {
    for (;;) {
      const end = this.buffer.indexOf("\n\n");
      if (end < 0) return;
      const block = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end + 2);
      const frame: SseFrame = { data: "" };
      const data: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) {
          this.comments.push(line.slice(1).trim());
          continue;
        }
        const colon = line.indexOf(":");
        const field = line.slice(0, colon);
        const value = line.slice(colon + 1).replace(/^ /, "");
        if (field === "data") data.push(value);
        else if (field === "id") frame.id = value;
        else if (field === "event") frame.event = value;
      }
      if (data.length > 0) {
        frame.data = data.join("\n");
        this.frames.push(frame);
      }
    }
  }

  /** Reads until `check` holds for what has arrived. */
  async until(
    check: (reader: SseReader) => boolean,
    { timeoutMs = 20_000, what = "stream frames" } = {},
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check(this)) {
      if (this.done) throw new Error(`The stream ended before ${what}`);
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`Timed out waiting for ${what}`);
      let timer: NodeJS.Timeout | undefined;
      const result = await Promise.race([
        this.reader.read(),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), remaining);
        }),
      ]).finally(() => clearTimeout(timer));
      if (result === "timeout") continue;
      if (result.done) {
        this.done = true;
        continue;
      }
      const chunk = this.decoder.decode(result.value, { stream: true });
      this.raw += chunk;
      this.buffer += chunk;
      this.parse();
    }
  }

  /** Reads until the server ends the stream. */
  async ended({ timeoutMs = 10_000 } = {}): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.done) {
      if (Date.now() > deadline)
        throw new Error("Timed out waiting for the stream to end");
      const result = await this.reader.read();
      if (result.done) this.done = true;
      else this.raw += this.decoder.decode(result.value, { stream: true });
    }
  }

  get isDone() {
    return this.done;
  }

  async close() {
    await this.reader.cancel().catch(() => {});
  }

  /** Parsed `data` of frames with an id (task events). */
  events(): Array<{ sequence: number; type: string; [key: string]: unknown }> {
    return this.frames
      .filter((frame) => frame.id !== undefined)
      .map((frame) => JSON.parse(frame.data));
  }
}

/** Creates bots by name and returns their ids by name. */
export async function createBots(t: TestApp, names: string[]) {
  const ids: Record<string, string> = {};
  for (const name of names) {
    const { status, body } = await t.call("POST", "/api/bots", { name });
    if (status !== 201)
      throw new Error(`Creating ${name}: ${JSON.stringify(body)}`);
    ids[name] = body.bot.id;
  }
  return ids;
}
