// How long a request may take to arrive. Node's own requestTimeout cuts
// every request at 300 s with a bare, non-JSON 408, an upload that is still
// arriving at a pace staging accepts included. The server turns it off and
// gives each request a deadline of its own instead: 300 s, or for an upload
// what its size needs at the slowest pace staging accepts
// (`engine.uploads.receiveMs`). A request still arriving at its deadline
// gets the API's JSON 408, written to the socket as Node writes its own,
// and its connection is closed. Node's headersTimeout still bounds the
// headers.
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { Logger } from "@jj/backend";
import type { ApiError } from "@jj/contracts";
import { type SecurityHeaderOptions, securityHeaderList } from "./headers";

/** Node's default cap on receiving a whole request, kept for every request but an upload. */
export const REQUEST_TIMEOUT_MS = 300_000;

/** `POST /api/uploads`, as the raw request names it. */
export const isUploadWrite = (request: IncomingMessage) =>
  request.method === "POST" &&
  (request.url ?? "").split("?", 1)[0] === "/api/uploads";

export interface DeadlineOptions {
  /** Every request's deadline, but an upload that needs longer. */
  requestTimeoutMs: number;
  /** How long an upload of this size may take, or null (`engine.uploads.receiveMs`). */
  uploadReceiveMs(sizeBytes: number): number | null;
  headers: SecurityHeaderOptions;
  logger: Logger;
}

/** How long this request may take to arrive whole. */
export function deadlineOf(
  request: IncomingMessage,
  options: Pick<DeadlineOptions, "requestTimeoutMs" | "uploadReceiveMs">,
): number {
  if (!isUploadWrite(request)) return options.requestTimeoutMs;
  const length = Number(request.headers["content-length"]);
  const upload =
    Number.isSafeInteger(length) && length >= 0
      ? options.uploadReceiveMs(length)
      : null;
  return Math.max(options.requestTimeoutMs, upload ?? 0);
}

/** Replaces Node's requestTimeout with a deadline per request. */
export function enforceDeadlines(server: Server, options: DeadlineOptions) {
  server.requestTimeout = 0;
  server.on("request", (request: IncomingMessage, response: ServerResponse) => {
    const ms = deadlineOf(request, options);
    const timer = setTimeout(() => {
      if (request.complete || request.socket.destroyed) return;
      timedOut(request, response, ms, options);
    }, ms);
    timer.unref();
    const clear = () => clearTimeout(timer);
    request.once("end", clear);
    // A response can finish before its request has all arrived (a refused
    // upload's body still coming): the deadline then still holds.
    response.once("close", () => {
      if (request.complete || request.socket.destroyed) clear();
    });
  });
}

function timedOut(
  request: IncomingMessage,
  response: ServerResponse,
  ms: number,
  options: DeadlineOptions,
) {
  const socket = request.socket;
  const what = `${request.method} ${(request.url ?? "").split("?", 1)[0]}`;
  options.logger.warn(
    `${what} did not arrive within ${seconds(ms)}: answered 408 and closed the connection`,
  );
  // Something of an answer is out already: only closing is left.
  if (!socket.writable || response.headersSent) {
    socket.destroy();
    return;
  }
  const message = isUploadWrite(request)
    ? `The file did not arrive within ${seconds(ms)}, the most a file of its size may take at the slowest pace the server accepts, so the server stopped receiving it. Try again on a faster connection.`
    : `The request did not arrive within ${seconds(ms)}, so the server stopped receiving it.`;
  const body = JSON.stringify({
    error: {
      code: "VALIDATION_FAILED",
      message,
      details: { timeoutMs: ms },
    },
  } satisfies ApiError);
  const head = [
    "HTTP/1.1 408 Request Timeout",
    "Content-Type: application/json",
    `Content-Length: ${Buffer.byteLength(body)}`,
    "Cache-Control: no-store",
    "Connection: close",
    ...securityHeaderList(options.headers).map(
      ([name, value]) => `${name}: ${value}`,
    ),
  ];
  socket.end(`${head.join("\r\n")}\r\n\r\n${body}`, () => socket.destroy());
}

const seconds = (ms: number) =>
  ms % 60_000 === 0 && ms >= 120_000
    ? `${ms / 60_000} minutes`
    : `${Math.round(ms / 100) / 10} s`;
