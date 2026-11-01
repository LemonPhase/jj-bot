/**
 * Dev-server proxy helpers for `vite.config.ts`, kept free of Node types so
 * they can be unit tested with plain fakes.
 */

/** The part of a Node stream these helpers listen to. */
export interface StreamEvents {
  on(event: string, listener: () => void): unknown;
}

/** The browser-facing response of a proxied request. */
export interface ClientResponse extends StreamEvents {
  readonly writableEnded: boolean;
  readonly destroyed: boolean;
  destroy(): void;
}

/**
 * Ties the browser's end of a proxied event stream to the API's. When the
 * upstream stream ends abnormally (the API restarted, crashed or dropped the
 * connection), the client response is destroyed, so the browser sees the
 * stream fail and reconnects instead of waiting on a silent socket forever. A
 * clean upstream end is piped through as a normal end.
 */
export function closeClientWithUpstream(
  upstream: StreamEvents,
  client: ClientResponse,
): void {
  const destroy = () => {
    if (!client.destroyed) client.destroy();
  };
  upstream.on("aborted", destroy);
  upstream.on("error", destroy);
  // After a clean end the pipe has already ended the client response.
  upstream.on("close", () => {
    if (!client.writableEnded) destroy();
  });
}
