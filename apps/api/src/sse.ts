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

export interface EventStreamOptions {
  registry: StreamRegistry;
  heartbeatMs: number;
  logger: Logger;
  /** What the stream is, for logs. */
  label: string;
  /**
   * Starts the source; resolves with its close. `write` fails with
   * STREAM_CLOSED once the client has gone.
   */
  start(write: EventWriter): Promise<() => Promise<void>>;
}

export type EventWriter = (frame: {
  id?: string;
  event: string;
  data: string;
}) => Promise<void>;

/**
 * A `text/event-stream` response that lives until the client disconnects or
 * the server shuts down. `Cache-Control: no-cache` and `X-Accel-Buffering: no`
 * keep proxies from buffering it.
 */
export function eventStream(c: Context, options: EventStreamOptions) {
  c.header("X-Accel-Buffering", "no");
  return streamSSE(c, async (stream: SSEStreamingApi) => {
    let end!: () => void;
    const ended = new Promise<void>((resolve) => {
      end = resolve;
    });
    stream.onAbort(end);
    const signal = c.req.raw.signal;
    if (signal.aborted) end();
    else signal.addEventListener("abort", end, { once: true });
    const unregister = options.registry.add(end);
    const gone = () => stream.aborted || stream.closed || signal.aborted;
    const write: EventWriter = async (frame) => {
      if (gone()) throw STREAM_CLOSED;
      await stream.writeSSE(frame);
    };
    const heartbeat = setInterval(() => {
      if (!gone()) void stream.write(": heartbeat\n\n");
    }, options.heartbeatMs);
    heartbeat.unref();
    let close: (() => Promise<void>) | undefined;
    try {
      // Sends the headers and a first byte, so clients see the stream open.
      await stream.write(": connected\n\n");
      close = await options.start(write);
      await ended;
    } catch (error) {
      if (error !== STREAM_CLOSED)
        options.logger.warn(`${options.label} failed`, {
          error: error instanceof Error ? error.message : String(error),
        });
    } finally {
      clearInterval(heartbeat);
      unregister();
      await close?.().catch((error: unknown) =>
        options.logger.warn(`Closing ${options.label} failed`, {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  });
}
