import { AsyncLocalStorage } from "node:async_hooks";
import { lookup as systemLookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import {
  type JsonRpcMessage,
  type McpFetch,
  type McpTransport,
  type McpTransportCloseListener,
  type McpTransportErrorListener,
  type McpTransportMessageListener,
  type McpTransportSendOptions,
  StreamableHttpTransport,
} from "@earendil-works/pi-mcp";
import { isPublicAddress } from "@jj/sandbox/addresses";
import { EnvHttpProxyAgent, fetch as undiciFetch } from "undici";
import { redactSecrets } from "../errors";
import {
  MCP_MAX_MESSAGE_BYTES,
  McpMessageTooLargeError,
  McpRemoteRefusedError,
  type McpTransportDiagnostics,
} from "./errors";

/**
 * Remote (Streamable HTTP) MCP servers, which the worker calls, never a
 * sandbox. Every request goes through a guard:
 *
 * - https only, to the configured origin only, and redirects are refused,
 *   so the credentials in `secretHeaders` go nowhere else;
 * - an IP address in the URL must be public (`isPublicAddress`, the egress
 *   proxy's check), and so must every address a name resolves to;
 * - a direct connection resolves the name when it connects, refuses it
 *   unless every address is public, and connects only to an address it
 *   checked (pinned: nothing resolves the name again);
 * - through an outbound proxy (`HTTPS_PROXY`, unless `NO_PROXY` matches the
 *   host) the proxy resolves the name and opens the connection, so it cannot
 *   be pinned. What holds there: the worker refuses the name when it
 *   resolves, from the worker, to an address that is not public; a name the
 *   worker cannot resolve goes to the proxy, which resolves it itself. A
 *   name that resolves differently for the proxy (DNS rebinding) is limited
 *   by TLS: the request is only sent once a certificate valid for the name
 *   is presented, so an internal address gets at most a TLS handshake. Not
 *   so through a proxy that intercepts TLS (its CA in NODE_EXTRA_CA_CERTS):
 *   the worker checks the proxy's certificate, and only the proxy checks the
 *   server's. What the proxy lets through is the operator's egress policy;
 * - a response stream that ends before its answer fails that request; it is
 *   never resumed;
 * - every response body is capped at 4 MiB (and so is every message sent);
 *   one over it closes the connection;
 * - `JJ_MCP_REMOTE=off` refuses every remote server.
 */

export type McpEnv = Readonly<Record<string, string | undefined>>;

export const MCP_REMOTE_DISABLED =
  "Remote MCP servers are turned off on this server (JJ_MCP_REMOTE=off).";

/** Whether remote servers may be called: `JJ_MCP_REMOTE` unset, empty or `on`; `off` turns them off. Any other value is a configuration error. */
export function remoteMcpEnabled(env: McpEnv = process.env): boolean {
  const value = env.JJ_MCP_REMOTE?.trim().toLowerCase() ?? "";
  if (value === "" || value === "on") return true;
  if (value === "off") return false;
  throw new Error(
    `JJ_MCP_REMOTE must be on or off, not ${JSON.stringify(env.JJ_MCP_REMOTE)}.`,
  );
}

export interface RemoteGuardOptions {
  /** Read for JJ_MCP_REMOTE and the proxy variables; default `process.env`. */
  env?: McpEnv;
  /** A host name's addresses; default the system resolver (`dns.lookup`). */
  resolve?: (hostname: string) => Promise<string[]>;
  /** Addresses that may be reached; default `isPublicAddress`. Tests widen it to reach a local server. */
  isAllowedAddress?: (address: string) => boolean;
  /** Trust for the server's certificate, beyond Node's (tests). `NODE_EXTRA_CA_CERTS` works as usual. */
  ca?: string | Buffer;
  /** Default 4 MiB. */
  maxMessageBytes?: number;
  /** Bounds each name resolution; default 10 s. */
  resolveTimeoutMs?: number;
}

export interface RemoteTransportOptions extends RemoteGuardOptions {
  /** The server's `url` (https). */
  url: string;
  /** Its non-secret `headers`. */
  headers?: Readonly<Record<string, string>>;
  /**
   * Its `secretHeaders`: each header is `prefix` and then `value`, the
   * stored secret the caller read. Sent to the configured origin only. The
   * values (without their prefixes) are kept out of every message: error
   * bodies are scrubbed of them before anything cuts them, and the
   * connection scrubs every text it reports (`McpTransportDiagnostics.secrets`).
   */
  secretHeaders?: Readonly<Record<string, { prefix?: string; value: string }>>;
}

const first = (...values: (string | undefined)[]) =>
  values.map((value) => value?.trim()).find((value) => value) ?? undefined;

/** How long a name's check is reused before it is resolved again. */
const CHECK_TTL_MS = 30_000;

const refused = (message: string) => new McpRemoteRefusedError(message);

/** The host of a URL without IPv6 brackets. */
const hostOf = (url: URL) => url.hostname.replace(/^\[(.*)\]$/, "$1");

/** Why the URL itself may not be called, if it may not. */
function urlProblem(
  url: URL,
  allow: (address: string) => boolean,
): string | undefined {
  if (url.protocol !== "https:")
    return `MCP servers are reached over https only, not ${url.protocol.replace(/:$/, "")}.`;
  if (url.username || url.password)
    return "An MCP server URL may not carry a user or password.";
  const host = hostOf(url);
  if (isIP(host) && !allow(host))
    return `${host} is not a public address; only public addresses are reached.`;
  return undefined;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string) {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () =>
          reject(
            Object.assign(new Error(`${what} timed out`), {
              code: "ETIMEDOUT",
            }),
          ),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/** The refusal a cause chain carries, if any: undici wraps connection errors in `TypeError("fetch failed")`. */
function refusalIn(error: unknown): McpRemoteRefusedError | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if (current instanceof McpRemoteRefusedError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

const NULL_BODY = new Set([101, 204, 205, 304]);

/**
 * The signal of the request being sent, for the fetch it makes: pi-mcp's
 * transport aborts it once the request is answered, cancelled or timed out,
 * but fetches with its own transport-wide signal.
 */
const requestSignal = new AsyncLocalStorage<AbortSignal | undefined>();

/**
 * A `fetch` for one server's transport that enforces the guard. `onTooLarge`
 * is called once a response body passes the cap, before the read fails.
 * The body of an error response is read whole (within the cap) and
 * `secrets` are replaced in it, so no later cut, such as pi-mcp's
 * 500-character excerpt in its error message, can leave part of one.
 */
export function createGuardedFetch(
  origin: URL,
  options: RemoteGuardOptions,
  onTooLarge: (error: McpMessageTooLargeError) => void,
  secrets: readonly string[] = [],
): { fetch: McpFetch; close(): Promise<void> } {
  const env = options.env ?? process.env;
  const allow = options.isAllowedAddress ?? isPublicAddress;
  const max = options.maxMessageBytes ?? MCP_MAX_MESSAGE_BYTES;
  const resolveTimeoutMs = options.resolveTimeoutMs ?? 10_000;
  const resolve =
    options.resolve ??
    (async (hostname: string) =>
      (await systemLookup(hostname, { all: true, verbatim: true })).map(
        (entry) => entry.address,
      ));

  /** Every address the name resolves to, if each is allowed; refused otherwise. */
  const checked = async (hostname: string): Promise<string[]> => {
    const addresses = await withTimeout(
      resolve(hostname),
      resolveTimeoutMs,
      `Resolving ${hostname}`,
    );
    if (addresses.length === 0)
      throw Object.assign(new Error(`${hostname} has no address`), {
        code: "ENOTFOUND",
      });
    if (!addresses.every((address) => allow(address)))
      throw refused(
        `${hostname} resolves to an address that is not public; only public addresses are reached.`,
      );
    return addresses;
  };

  // A direct connection: resolved, checked and pinned to a checked address.
  const lookup: LookupFunction = (hostname, lookupOptions, callback) => {
    checked(hostname).then(
      (addresses) => {
        const family =
          lookupOptions.family === 4 || lookupOptions.family === "IPv4"
            ? 4
            : lookupOptions.family === 6 || lookupOptions.family === "IPv6"
              ? 6
              : 0;
        const entries = addresses
          .map((address) => ({ address, family: isIP(address) }))
          .filter((entry) => family === 0 || entry.family === family);
        const [firstEntry] = entries;
        if (!firstEntry) {
          callback(
            Object.assign(
              new Error(`${hostname} has no IPv${family} address`),
              {
                code: "ENOTFOUND",
              },
            ),
            "",
          );
          return;
        }
        if (lookupOptions.all) callback(null, entries);
        else callback(null, firstEntry.address, firstEntry.family);
      },
      (error: NodeJS.ErrnoException) => callback(error, ""),
    );
  };

  const httpProxy = first(env.http_proxy, env.HTTP_PROXY);
  const httpsProxy = first(env.https_proxy, env.HTTPS_PROXY);
  const noProxy = first(env.no_proxy, env.NO_PROXY);
  // Empty strings, not undefined: undici would otherwise read process.env.
  const dispatcher = new EnvHttpProxyAgent({
    httpProxy: httpProxy ?? "",
    httpsProxy: httpsProxy ?? "",
    noProxy: noProxy ?? "",
    proxyTunnel: true,
    connect: { lookup, ...(options.ca ? { ca: options.ca } : {}) },
    ...(options.ca ? { requestTls: { ca: options.ca } } : {}),
  });

  /** Names checked recently: the worker's view of them, reused for CHECK_TTL_MS. */
  const recent = new Map<string, { at: number; refusal?: string }>();
  /**
   * The name's check before a request. Through a proxy it is the only one;
   * a direct connection checks again, authoritatively, as it connects. A
   * name the worker cannot resolve passes: a direct connection then fails,
   * and a proxy resolves it itself.
   */
  const precheck = async (hostname: string) => {
    // An address was checked with the URL.
    if (isIP(hostname)) return;
    const seen = recent.get(hostname);
    if (seen && Date.now() - seen.at < CHECK_TTL_MS) {
      if (seen.refusal) throw refused(seen.refusal);
      return;
    }
    let refusal: string | undefined;
    try {
      await checked(hostname);
    } catch (error) {
      if (error instanceof McpRemoteRefusedError) refusal = error.message;
    }
    recent.set(hostname, { at: Date.now(), ...(refusal ? { refusal } : {}) });
    if (refusal) throw refused(refusal);
  };

  const cap = (response: Response): Response => {
    const tooLarge = (bytes: number) => {
      const error = new McpMessageTooLargeError(bytes, max, "in");
      onTooLarge(error);
      return error;
    };
    const declared = Number(response.headers.get("content-length") ?? "");
    if (Number.isFinite(declared) && declared > max) {
      void response.body?.cancel().catch(() => {});
      throw tooLarge(declared);
    }
    const init = {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    };
    if (!response.body || NULL_BODY.has(response.status))
      return new Response(null, init);
    let seen = 0;
    const limited = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          seen += chunk.byteLength;
          if (seen > max) controller.error(tooLarge(seen));
          else controller.enqueue(chunk);
        },
      }),
    );
    return new Response(limited, init);
  };

  const fetch: McpFetch = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input.href);
    const problem = urlProblem(url, allow);
    if (problem) throw refused(problem);
    if (url.origin !== origin.origin)
      throw refused("Requests go only to the configured MCP server.");
    await precheck(hostOf(url));
    // pi-mcp fetches with the transport's signal; the request's own (the
    // call's timeout and abort) ends its response stream with the call.
    const own = requestSignal.getStore();
    const transportSignal = init?.signal ?? undefined;
    const signal =
      own && transportSignal
        ? AbortSignal.any([transportSignal, own])
        : (own ?? transportSignal);
    let response: Response;
    try {
      response = (await undiciFetch(url, {
        ...(init as Parameters<typeof undiciFetch>[1]),
        ...(signal ? { signal } : {}),
        redirect: "manual",
        dispatcher,
      })) as unknown as Response;
    } catch (error) {
      const refusal = refusalIn(error);
      if (refusal) throw refusal;
      // undici's "fetch failed" says nothing; its deepest cause says what
      // failed (a name that does not resolve, a proxy that refused the
      // tunnel). Still a TypeError, which pi-mcp treats as a network failure.
      const cause = (error as { cause?: unknown }).cause;
      let deepest: Error | undefined;
      for (
        let current: unknown = cause, depth = 0;
        current instanceof Error && depth < 5;
        current = (current as { cause?: unknown }).cause, depth++
      )
        deepest = current;
      if (error instanceof TypeError && deepest)
        throw new TypeError(`${error.message}: ${deepest.message}`, { cause });
      throw error;
    }
    if (
      response.type === "opaqueredirect" ||
      (response.status >= 300 && response.status < 400)
    ) {
      void response.body?.cancel().catch(() => {});
      throw refused(
        `The MCP server answered with a redirect (${response.status}); redirects are not followed.`,
      );
    }
    const capped = cap(response);
    const headers = new Headers(capped.headers);
    headers.delete("content-length");
    const rewrapped = {
      status: capped.status,
      statusText: capped.statusText,
      headers,
    };
    if (!capped.ok) {
      if (secrets.length === 0) return capped;
      // An error body is shown in messages: scrubbed whole, before any cut.
      const text = await capped.text().catch(() => "");
      return new Response(redactSecrets(text, secrets), rewrapped);
    }
    const type = capped.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (type !== "application/json") return capped;
    // Parsed here first: a parse error's message quotes the text around the
    // fault, which can be a secret the server echoed; this one quotes nothing.
    const text = await capped.text();
    try {
      JSON.parse(text);
    } catch {
      throw new Error(
        "The MCP server answered with a body that is not valid JSON.",
      );
    }
    return new Response(text, rewrapped);
  };

  return {
    fetch,
    close: async () => {
      await dispatcher.destroy().catch(() => {});
    },
  };
}

/**
 * pi-mcp's `StreamableHttpTransport` behind the guard. A message over the
 * cap closes it (`closeReason` says why); errors are redacted of the secret
 * header values. Refusals (`McpRemoteRefusedError`) happen at `start` for
 * what the URL alone shows, else at the request the guard stops. A response
 * stream that ends before its answer fails that request at once: it is
 * never resumed, since a server could keep a resume going without end.
 */
export class GuardedHttpTransport
  implements McpTransport, McpTransportDiagnostics
{
  private readonly url: URL;
  private readonly options: RemoteTransportOptions;
  private readonly inner: StreamableHttpTransport;
  private readonly guard: ReturnType<typeof createGuardedFetch>;
  private readonly max: number;
  /** The secret header values, without their prefixes. */
  readonly secrets: readonly string[];
  private readonly errorListeners = new Set<McpTransportErrorListener>();
  private closeReasonValue: string | undefined;
  private closingForSize: Promise<void> | undefined;

  constructor(options: RemoteTransportOptions) {
    this.options = options;
    this.url = new URL(options.url);
    this.max = options.maxMessageBytes ?? MCP_MAX_MESSAGE_BYTES;
    const secretHeaders = Object.entries(options.secretHeaders ?? {});
    this.secrets = secretHeaders
      .map(([, header]) => header.value)
      .filter((value) => value.length > 0);
    this.guard = createGuardedFetch(
      this.url,
      options,
      (error) => this.tooLarge(error),
      this.secrets,
    );
    this.inner = new StreamableHttpTransport({
      url: this.url,
      headers: {
        ...options.headers,
        ...Object.fromEntries(
          secretHeaders.map(([name, header]) => [
            name,
            `${header.prefix ?? ""}${header.value}`,
          ]),
        ),
      },
      fetch: this.guard.fetch,
      // Nothing is asked of the server outside a request: no standing stream.
      openGetStream: false,
      // A cut response stream is not resumed: one that keeps ending (with
      // `retry: 0`) would be re-opened without end, during and after its call.
      reconnect: { maxRetries: 0 },
      maxMessageBytes: this.max,
    });
  }

  get closeReason(): string | undefined {
    return this.closeReasonValue;
  }

  async start(): Promise<void> {
    if (!remoteMcpEnabled(this.options.env ?? process.env))
      throw refused(MCP_REMOTE_DISABLED);
    const problem = urlProblem(
      this.url,
      this.options.isAllowedAddress ?? isPublicAddress,
    );
    if (problem) throw refused(problem);
    await this.inner.start();
  }

  async send(
    message: JsonRpcMessage,
    options?: McpTransportSendOptions,
  ): Promise<void> {
    const bytes = Buffer.byteLength(JSON.stringify(message));
    if (bytes > this.max)
      throw new McpMessageTooLargeError(bytes, this.max, "out");
    try {
      // The request's own signal reaches its fetch: its response stream ends with it.
      await requestSignal.run(options?.signal, () =>
        this.inner.send(message, options),
      );
    } catch (error) {
      // A response over the cap: the request fails as the connection closes.
      if (this.closingForSize) await this.closingForSize;
      throw this.scrub(error);
    }
  }

  async close(): Promise<void> {
    await this.inner.close();
    await this.guard.close();
  }

  setProtocolVersion(version: string): void {
    this.inner.setProtocolVersion(version);
  }

  onMessage(listener: McpTransportMessageListener): () => void {
    return this.inner.onMessage(listener);
  }

  onError(listener: McpTransportErrorListener): () => void {
    const off = this.inner.onError((error) => listener(this.scrub(error)));
    this.errorListeners.add(listener);
    return () => {
      off();
      this.errorListeners.delete(listener);
    };
  }

  onClose(listener: McpTransportCloseListener): () => void {
    return this.inner.onClose(listener);
  }

  private tooLarge(error: McpMessageTooLargeError) {
    if (this.closeReasonValue) return;
    this.closeReasonValue = error.message;
    for (const listener of this.errorListeners) listener(error);
    this.closingForSize = this.close().catch(() => {});
  }

  /** The error with the secret header values taken out of its message. */
  private scrub(error: unknown): Error {
    const normalized =
      error instanceof Error ? error : new Error(String(error));
    if (this.secrets.some((secret) => normalized.message.includes(secret)))
      normalized.message = redactSecrets(normalized.message, this.secrets);
    // McpHttpError keeps the error body too.
    const body = (normalized as { body?: unknown }).body;
    if (typeof body === "string")
      Object.assign(normalized, { body: redactSecrets(body, this.secrets) });
    return normalized;
  }
}

/** A guarded transport for a remote server; see `GuardedHttpTransport`. */
export function createRemoteTransport(
  options: RemoteTransportOptions,
): GuardedHttpTransport {
  return new GuardedHttpTransport(options);
}
