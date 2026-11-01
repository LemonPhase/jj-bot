/**
 * Server-sent event transports for the live API.
 *
 * - `eventSourceConnect` uses the browser's EventSource. It reconnects by
 *   itself after a dropped connection and sends `Last-Event-ID`.
 * - `fetchSseConnect` reads the stream with fetch, for when requests must
 *   carry an `Authorization` header (EventSource cannot set headers). It
 *   never reconnects by itself; the caller reopens it.
 */

export interface SseFrame {
  /** The frame's `id:` (the task event sequence), or "" when absent. */
  id: string;
  /** The frame's `event:`, or "message". */
  event: string;
  data: string;
}

export interface SseHandlers {
  onOpen(): void;
  onFrame(frame: SseFrame): void;
  /** `retrying`: the transport is reconnecting by itself. */
  onError(retrying: boolean): void;
}

export interface SseRequest {
  url: string;
  /** Sent as the `Last-Event-ID` header where the transport can. */
  lastEventId?: string;
  /** Named `event:` types to listen for, besides unnamed "message" frames. */
  eventTypes: readonly string[];
}

export type SseConnect = (
  request: SseRequest,
  handlers: SseHandlers,
) => () => void;

/** The part of `EventSource` the client uses, so tests can provide their own. */
export interface EventSourceLike {
  readonly readyState: number;
  // The client ignores the event argument. `never` lets both the DOM's
  // EventSource and Node's (whose error event is an ErrorEvent) fit.
  onopen: ((event: never) => unknown) | null;
  onerror: ((event: never) => unknown) | null;
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

/** `EventSource.CLOSED`: the browser gave up and will not reconnect. */
const CLOSED = 2;

export function eventSourceConnect(create: EventSourceFactory): SseConnect {
  return ({ url, eventTypes }, handlers) => {
    const source = create(url);
    const forward = (event: MessageEvent) =>
      handlers.onFrame({
        id: event.lastEventId ?? "",
        event: event.type,
        data: typeof event.data === "string" ? event.data : "",
      });
    source.onopen = () => handlers.onOpen();
    source.onerror = () => handlers.onError(source.readyState !== CLOSED);
    source.addEventListener("message", forward);
    for (const type of eventTypes)
      if (type !== "message") source.addEventListener(type, forward);
    return () => source.close();
  };
}

/** Incremental parser for the `text/event-stream` format. */
export class SseParser {
  private buffer = "";
  private data: string[] = [];
  private event = "";
  private id = "";
  private lastId = "";

  constructor(private readonly onFrame: (frame: SseFrame) => void) {}

  push(chunk: string) {
    this.buffer += chunk;
    for (;;) {
      const match = /\r\n|\r|\n/.exec(this.buffer);
      if (!match) return;
      // A lone "\r" at the end may be the first half of "\r\n".
      if (match[0] === "\r" && match.index === this.buffer.length - 1) return;
      const line = this.buffer.slice(0, match.index);
      this.buffer = this.buffer.slice(match.index + match[0].length);
      this.line(line);
    }
  }

  private line(line: string) {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") this.data.push(value);
    else if (field === "event") this.event = value;
    else if (field === "id" && !value.includes("\0")) this.id = value;
  }

  private dispatch() {
    this.lastId = this.id;
    const event = this.event || "message";
    this.event = "";
    if (this.data.length === 0) return;
    const data = this.data.join("\n");
    this.data = [];
    this.onFrame({ id: this.lastId, event, data });
  }
}

export function fetchSseConnect(
  fetchImpl: typeof fetch,
  headers: Record<string, string>,
): SseConnect {
  return ({ url, lastEventId }, handlers) => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetchImpl(url, {
          headers: {
            ...headers,
            Accept: "text/event-stream",
            ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}),
          },
          cache: "no-store",
          signal: controller.signal,
        });
        const type = response.headers.get("Content-Type") ?? "";
        if (
          !response.ok ||
          !type.includes("text/event-stream") ||
          !response.body
        ) {
          if (!controller.signal.aborted) handlers.onError(false);
          return;
        }
        handlers.onOpen();
        const parser = new SseParser((frame) => {
          if (!controller.signal.aborted) handlers.onFrame(frame);
        });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.push(decoder.decode(value, { stream: true }));
        }
        if (!controller.signal.aborted) handlers.onError(false);
      } catch {
        if (!controller.signal.aborted) handlers.onError(false);
      }
    })();
    return () => controller.abort();
  };
}
