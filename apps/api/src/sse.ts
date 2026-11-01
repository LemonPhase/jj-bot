// Server-sent event responses: a comment heartbeat, the source closed when the
// client goes away, and every open stream ended on shutdown so the HTTP
// server can drain.
import type { Logger } from "@jj/backend";
import type { Context } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";

/** Thrown into a source's write when the client has gone; never logged. */
export const STREAM_CLOSED = new Error("The event stream closed.");

/** Open streams, so shutdown can end them. */
export class StreamRegistry {
  private readonly open = new Set<() => void>();

  add(end: () => void): () => void {
    this.open.add(end);
    return () => this.open.delete(end);
  }

  get size(): number {
    return this.open.size;
  }

  /** Ends every open stream; their sources close as they unwind. */
  endAll(): void {
    for (const end of [...this.open]) end();
  }
}

export type EventFrame = { id?: string; event: string; data: string };

export type EventWriter = (frame: EventFrame) => Promise<void>;

export interface EventStreamOptions {
  registry: StreamRegistry;
  heartbeatMs: number;
  logger: Logger;
  /** What the stream is, for logs. */
  label: string;
  /**
   * A source that can replay (the task stream): started inside the stream,
   * resolving with its close. `write` is awaited for backpressure and fails
   * with STREAM_CLOSED once the client has gone or the stream ended.
   */
  start?(write: EventWriter): Promise<() => Promise<void>>;
  /**
   * A source that cannot replay (workspace hints): subscribed before the
   * response exists, so nothing it reports falls before the client sees the
   * stream open. What it sends meanwhile is queued; sends are not awaited.
   */
  listen?(send: (frame: EventFrame) => void): Promise<() => Promise<void>>;
}

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "X-Accel-Buffering": "no",
};

const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * A `text/event-stream` response that lives until the client disconnects or
 * the server shuts down. `Cache-Control: no-cache` and `X-Accel-Buffering: no`
 * keep proxies from buffering it. HEAD gets the headers and starts nothing.
 */
export async function eventStream(
  c: Context,
  options: EventStreamOptions,
): Promise<Response> {
  // Hono runs GET handlers for HEAD and drops the body without cancelling
  // it, so a stream started here would never end.
  if (c.req.method === "HEAD") return c.body(null, 200, SSE_HEADERS);

  const early: EventFrame[] = [];
  let deliver: ((frame: EventFrame) => void) | undefined;
  const stopListening = options.listen
    ? await options.listen((frame) =>
        deliver ? deliver(frame) : early.push(frame),
      )
    : undefined;

  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream: SSEStreamingApi) => {
    let end!: () => void;
    const ended = new Promise<void>((resolve) => {
      end = resolve;
    });
    // Every write races this, so a client that stopped reading cannot hold
    // the stream (or shutdown) open.
    const closed = ended.then(() => {
      throw STREAM_CLOSED;
    });
    closed.catch(() => {});
    stream.onAbort(end);
    const signal = c.req.raw.signal;
    if (signal.aborted) end();
    else signal.addEventListener("abort", end, { once: true });
    const unregister = options.registry.add(end);
    let isEnded = false;
    void ended.then(() => {
      isEnded = true;
    });
    const gone = () =>
      isEnded || stream.aborted || stream.closed || signal.aborted;
    const send = async (chunk: string | EventFrame) => {
      if (gone()) throw STREAM_CLOSED;
      await Promise.race([
        typeof chunk === "string"
          ? stream.write(chunk)
          : stream.writeSSE(chunk),
        closed,
      ]);
    };
    const heartbeat = setInterval(() => {
      if (!gone()) send(": heartbeat\n\n").catch(() => {});
    }, options.heartbeatMs);
    heartbeat.unref();
    let queue = Promise.resolve();
    let stopSource: (() => Promise<void>) | undefined;
    try {
      if (stopListening) {
        deliver = (frame) => {
          queue = queue.then(() => send(frame)).catch(() => {});
        };
        for (const frame of early.splice(0)) deliver(frame);
      }
      if (options.start) stopSource = await options.start(send);
      // A first byte once the source is live, so clients see the stream open.
      await send(": connected\n\n");
      await ended;
    } catch (error) {
      if (error !== STREAM_CLOSED)
        options.logger.warn(`${options.label} failed`, {
          error: message(error),
        });
    } finally {
      end();
      clearInterval(heartbeat);
      unregister();
      for (const stop of [stopListening, stopSource])
        await stop?.().catch((error: unknown) =>
          options.logger.warn(`Closing ${options.label} failed`, {
            error: message(error),
          }),
        );
      await queue;
      // Discards writes a stalled client never read, so the response ends.
      if (!stream.aborted) stream.abort();
    }
  });
}
