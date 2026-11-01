// @ts-check
/**
 * Egress proxy of the docker driver's `allowlist` network mode.
 *
 * This file is the whole program. The driver runs its exact source in the
 * proxy container (`node --input-type=module --eval <this file + start call>`,
 * see `egress.ts`), and the tests import this same file, so the functions they
 * check are the ones that run. It uses Node built-ins only and must stay
 * self-contained: nothing else is in the container.
 *
 * It accepts `CONNECT host:port` (any TLS or other stream) and absolute-form
 * plain HTTP requests. A target is allowed only when its host matches an entry
 * and the port is permitted (80 and 443 for a bare entry, the given port for
 * `host:port`). The proxy then resolves the name itself and refuses it when
 * any resolved address is not public, and connects to an address it checked,
 * never resolving again. Everything else is refused with a one-line reason.
 * Anything unexpected fails closed: a refused request, a dropped connection,
 * or a proxy that exits, which leaves the sandbox without network.
 */
import { lookup } from "node:dns/promises";
import { createServer, request as httpRequest } from "node:http";
import { connect as netConnect } from "node:net";
import { networkInterfaces } from "node:os";

/** The variable that carries the proxy's configuration (JSON) into the container. */
export const CONFIG_VAR = "JJ_EGRESS_CONFIG";

export const LIMITS = Object.freeze({
  /** Client connections at once; more are dropped. */
  maxConnections: 256,
  /** Time to send request headers. */
  headersTimeoutMs: 10_000,
  /** Silence on a tunnel or request, either side, before it is closed. */
  idleTimeoutMs: 300_000,
  /** Name resolution. */
  resolveTimeoutMs: 10_000,
  /** Connecting upstream, over every resolved address. */
  connectTimeoutMs: 15_000,
});

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST_NAME = new RegExp(`^(?:${LABEL}\\.)*${LABEL}$`);

/**
 * @typedef {{ host: string, wildcard: boolean, ports: readonly number[] }} AllowRule
 * @typedef {{ ok: true, host: string, addresses: string[] }} Allowed
 * @typedef {{ ok: false, status: number, reason: string }} Refused
 * @typedef {(host: string) => Promise<string[]>} Resolve
 * @typedef {(address: string, port: number) => import("node:net").Socket} Connect
 */

/**
 * `host` is a lowercase host name: labels of letters, digits and inner hyphens.
 * @param {unknown} host
 * @returns {host is string}
 */
export function isHostName(host) {
  return typeof host === "string" && host.length <= 253 && HOST_NAME.test(host);
}

/**
 * Parses one allowlist entry, as the contract's `networkHostSchema` accepts it
 * (lowercase): `host`, `*.host` (subdomains only, at least two labels after
 * the star) or either with `:port`. Returns null for anything else.
 * @param {unknown} entry
 * @returns {AllowRule | null}
 */
export function parseAllowEntry(entry) {
  if (typeof entry !== "string" || entry.length > 260) return null;
  const match = /^(\*\.)?([^:]+)(?::(\d{1,5}))?$/.exec(entry);
  if (!match) return null;
  const [, star, host = "", portText] = match;
  if (!isHostName(host)) return null;
  // A wildcard names subdomains of a host name: never part of an IP address.
  const labels = host.split(".");
  if (star && (labels.length < 2 || NUMERIC_LABEL.test(labels.at(-1) ?? "")))
    return null;
  let ports = [80, 443];
  if (portText !== undefined) {
    const port = Number(portText);
    if (port < 1 || port > 65_535) return null;
    ports = [port];
  }
  return { host, wildcard: Boolean(star), ports };
}

/**
 * The rules for a list of entries. Throws on any invalid entry or an empty
 * list, so a proxy with a configuration it does not understand never starts.
 * @param {unknown} entries
 * @returns {AllowRule[]}
 */
export function compileAllowlist(entries) {
  if (!Array.isArray(entries) || entries.length === 0)
    throw new Error("The allowlist must be a non-empty array of host entries");
  return entries.map((entry) => {
    const rule = parseAllowEntry(entry);
    if (!rule)
      throw new Error(`Invalid allowlist entry ${JSON.stringify(entry)}`);
    return rule;
  });
}

/**
 * Whether `host` is named by some rule, ignoring ports.
 * @param {readonly AllowRule[]} rules
 * @param {string} host
 */
export function hostListed(rules, host) {
  return rules.some((rule) => names(rule, host));
}

/**
 * Whether `host:port` is allowed: some rule names the host and permits the port.
 * @param {readonly AllowRule[]} rules
 * @param {string} host lowercase
 * @param {number} port
 */
export function isAllowed(rules, host, port) {
  return rules.some((rule) => names(rule, host) && rule.ports.includes(port));
}

/**
 * Whether a rule names `host`: the same name, or for a wildcard a subdomain
 * of it. A wildcard never matches an IP address, whatever its rule says.
 * @param {AllowRule} rule
 * @param {string} host
 */
function names(rule, host) {
  if (!rule.wildcard) return host === rule.host;
  return (
    isHostName(host) && !isIPLiteral(host) && host.endsWith(`.${rule.host}`)
  );
}

/** A label resolvers read as a number (`inet_aton`): decimal, octal or hex. */
const NUMERIC_LABEL = /^(?:\d+|0x[0-9a-f]*)$/i;

/**
 * Whether `host` is an IP address in any form a resolver accepts: IPv6, or
 * one to four numeric labels (`8.8.8.8`, `134744072`, `0x8.0x8.0x8.0x8`).
 * @param {string} host
 */
export function isIPLiteral(host) {
  if (parseIPv6(host)) return true;
  const labels = host.split(".");
  return (
    labels.length <= 4 && labels.every((label) => NUMERIC_LABEL.test(label))
  );
}

// --- Addresses ------------------------------------------------------------

/**
 * Strict dotted-decimal IPv4 (no leading zeros, as resolvers return it).
 * @param {string} text
 * @returns {number[] | null}
 */
export function parseIPv4(text) {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const bytes = [];
  for (const part of parts) {
    if (!/^(?:0|[1-9]\d{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    bytes.push(value);
  }
  return bytes;
}

/**
 * IPv6 as eight 16-bit groups, including `::` and a dotted IPv4 tail. A zone
 * id (`%eth0`) is refused: it only ever scopes link-local addresses.
 * @param {string} text
 * @returns {number[] | null}
 */
export function parseIPv6(text) {
  let rest = text.toLowerCase();
  if (!/^[0-9a-f:.]+$/.test(rest)) return null;
  /** @type {number[] | null} */
  let tail = null;
  if (rest.includes(".")) {
    const colon = rest.lastIndexOf(":");
    const v4 = colon === -1 ? null : parseIPv4(rest.slice(colon + 1));
    if (!v4) return null;
    tail = [
      ((v4[0] ?? 0) << 8) | (v4[1] ?? 0),
      ((v4[2] ?? 0) << 8) | (v4[3] ?? 0),
    ];
    rest = `${rest.slice(0, colon + 1)}0:0`;
  }
  const halves = rest.split("::");
  if (halves.length > 2) return null;
  const split = (/** @type {string} */ part) =>
    part === "" ? [] : part.split(":");
  const left = split(halves[0] ?? "");
  const right = halves.length === 2 ? split(halves[1] ?? "") : [];
  if (![...left, ...right].every((group) => /^[0-9a-f]{1,4}$/.test(group)))
    return null;
  const missing = 8 - left.length - right.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [
    ...left,
    ...Array(halves.length === 2 ? missing : 0).fill("0"),
    ...right,
  ].map((group) => Number.parseInt(group, 16));
  if (tail) groups.splice(6, 2, ...tail);
  return groups;
}

/** IPv4 ranges that are not globally reachable unicast. */
const NON_PUBLIC_V4 = /** @type {Array<[number[], number]>} */ ([
  [[0, 0, 0, 0], 8], // "this network"
  [[10, 0, 0, 0], 8], // private
  [[100, 64, 0, 0], 10], // carrier-grade NAT
  [[127, 0, 0, 0], 8], // loopback
  [[169, 254, 0, 0], 16], // link-local, cloud metadata
  [[172, 16, 0, 0], 12], // private, Docker's default pools
  [[192, 0, 0, 0], 24], // IETF protocol assignments
  [[192, 0, 2, 0], 24], // documentation
  [[192, 88, 99, 0], 24], // 6to4 relay anycast
  [[192, 168, 0, 0], 16], // private
  [[198, 18, 0, 0], 15], // benchmarking
  [[198, 51, 100, 0], 24], // documentation
  [[203, 0, 113, 0], 24], // documentation
  [[224, 0, 0, 0], 4], // multicast
  [[240, 0, 0, 0], 4], // reserved, broadcast
]);

const toUint32 = (/** @type {number[]} */ bytes) =>
  (((bytes[0] ?? 0) << 24) |
    ((bytes[1] ?? 0) << 16) |
    ((bytes[2] ?? 0) << 8) |
    (bytes[3] ?? 0)) >>>
  0;

/**
 * Whether an IPv4 address lies in `base/prefix`.
 * @param {number[]} bytes
 * @param {number[]} base
 * @param {number} prefix
 */
export function inIPv4Range(bytes, base, prefix) {
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (toUint32(bytes) & mask) >>> 0 === (toUint32(base) & mask) >>> 0;
}

/**
 * Whether an address (IPv4, or IPv6 as resolvers return it) is public: global
 * unicast outside every special-purpose range. IPv4-mapped IPv6 is judged as
 * the IPv4 address it carries. Anything unparseable is not public.
 * @param {string} address
 */
export function isPublicAddress(address) {
  const v4 = parseIPv4(address);
  if (v4)
    return !NON_PUBLIC_V4.some(([base, prefix]) =>
      inIPv4Range(v4, base, prefix),
    );
  const v6 = parseIPv6(address);
  if (!v6) return false;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = v6;
  // ::ffff:a.b.c.d
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0xffff)
    return isPublicAddress(`${g6 >> 8}.${g6 & 255}.${g7 >> 8}.${g7 & 255}`);
  // Only 2000::/3 is global unicast: this excludes ::, ::1, other IPv4
  // embeddings (NAT64 64:ff9b::/96, IPv4-compatible), fc00::/7, fe80::/10
  // and ff00::/8.
  if ((g0 & 0xe000) !== 0x2000) return false;
  if (g0 === 0x2001 && g1 < 0x0200) return false; // IETF protocol assignments, Teredo
  if (g0 === 0x2001 && g1 === 0x0db8) return false; // documentation
  if (g0 === 0x2002) return false; // 6to4, which embeds IPv4
  if (g0 === 0x3fff && g1 < 0x1000) return false; // documentation (3fff::/20)
  return true;
}

/**
 * An IPv4 `a.b.c.d/n` subnet.
 * @param {unknown} cidr
 * @returns {{ base: number[], prefix: number } | null}
 */
export function parseSubnet(cidr) {
  if (typeof cidr !== "string") return null;
  const [address = "", prefixText = "", extra] = cidr.split("/");
  const base = parseIPv4(address);
  if (!base || extra !== undefined || !/^\d{1,2}$/.test(prefixText))
    return null;
  const prefix = Number(prefixText);
  return prefix >= 1 && prefix <= 32 ? { base, prefix } : null;
}

// --- Targets --------------------------------------------------------------

/**
 * A CONNECT request target, `host:port` or `[ipv6]:port`.
 * @param {string | undefined} authority
 * @returns {{ host: string, port: number } | null}
 */
export function parseAuthority(authority) {
  if (typeof authority !== "string") return null;
  const match = /^(?:\[([0-9a-fA-F:.]+)\]|([^:[\]/@\s]+)):(\d{1,5})$/.exec(
    authority,
  );
  if (!match) return null;
  const port = Number(match[3]);
  if (port < 1 || port > 65_535) return null;
  return { host: (match[1] ?? match[2] ?? "").toLowerCase(), port };
}

/**
 * Decides whether a target may be reached and, if so, which addresses: the
 * host must be allowed for the port, and every address it resolves to must be
 * public. The caller connects only to the returned addresses.
 * @param {readonly AllowRule[]} rules
 * @param {string} host lowercase host name or IP address
 * @param {number} port
 * @param {Resolve} resolve
 * @returns {Promise<Allowed | Refused>}
 */
export async function authorize(rules, host, port, resolve) {
  if (!isHostName(host) && !parseIPv6(host))
    return { ok: false, status: 400, reason: "the target is not a valid host" };
  if (!isAllowed(rules, host, port))
    return {
      ok: false,
      status: 403,
      reason: hostListed(rules, host)
        ? `port ${port} of ${host} is not in this runtime profile's network allowlist`
        : `${host} is not in this runtime profile's network allowlist`,
    };
  let addresses;
  try {
    addresses = await withTimeout(
      resolve(host),
      LIMITS.resolveTimeoutMs,
      "resolving",
    );
  } catch (error) {
    return {
      ok: false,
      status: 502,
      reason: `${host} could not be resolved (${errorCode(error)})`,
    };
  }
  if (addresses.length === 0)
    return { ok: false, status: 502, reason: `${host} could not be resolved` };
  if (!addresses.every(isPublicAddress))
    return {
      ok: false,
      status: 403,
      reason:
        addresses.length === 1 && addresses[0] === host
          ? `${host} is a private address; only public destinations are reachable`
          : `${host} resolves to a private address; only public destinations are reachable`,
    };
  return { ok: true, host, addresses };
}

/**
 * Connects to the first address that answers, IPv4 first, within one overall
 * timeout. Only addresses `authorize` returned are ever used.
 * @param {readonly string[]} addresses
 * @param {number} port
 * @param {Connect} connect
 * @returns {Promise<import("node:net").Socket>}
 */
export async function openUpstream(addresses, port, connect) {
  const ordered = [
    ...addresses.filter((address) => parseIPv4(address)),
    ...addresses.filter((address) => !parseIPv4(address)),
  ];
  const deadline = Date.now() + LIMITS.connectTimeoutMs;
  let last = /** @type {unknown} */ (new Error("no address"));
  for (const address of ordered) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    try {
      return await new Promise((resolve, reject) => {
        const socket = connect(address, port);
        const fail = (/** @type {unknown} */ error) => {
          socket.destroy();
          reject(error);
        };
        const timer = setTimeout(
          () =>
            fail(Object.assign(new Error("timed out"), { code: "ETIMEDOUT" })),
          remaining,
        );
        socket.once("error", fail);
        socket.once("connect", () => {
          clearTimeout(timer);
          socket.off("error", fail);
          resolve(socket);
        });
      });
    } catch (error) {
      last = error;
    }
  }
  throw last;
}

// --- Server ---------------------------------------------------------------

/** Headers that belong to one connection and are never forwarded. */
const HOP_BY_HOP = new Set([
  "connection",
  "expect",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/**
 * Raw headers without hop-by-hop ones (including any the Connection header
 * names) and without the names in `drop`.
 * @param {string[]} raw
 * @param {ReadonlySet<string>} [drop]
 * @returns {string[]}
 */
export function endToEndHeaders(raw, drop = new Set()) {
  const named = new Set();
  for (let index = 0; index < raw.length; index += 2)
    if ((raw[index] ?? "").toLowerCase() === "connection")
      for (const token of (raw[index + 1] ?? "").split(","))
        named.add(token.trim().toLowerCase());
  const kept = [];
  for (let index = 0; index < raw.length; index += 2) {
    const name = (raw[index] ?? "").toLowerCase();
    if (HOP_BY_HOP.has(name) || named.has(name) || drop.has(name)) continue;
    kept.push(raw[index] ?? "", raw[index + 1] ?? "");
  }
  return kept;
}

/** The text an agent sees, as the body and the status line. */
export function refusalMessage(/** @type {string} */ reason) {
  return `JJ Bot egress: ${reason}`;
}

/** Printable ASCII only, so a reason can sit in a status line. */
const statusText = (/** @type {string} */ text) =>
  text.replace(/[^\x20-\x7e]/g, "?").slice(0, 300);

/**
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} what
 * @returns {Promise<T>}
 * @template T
 */
function withTimeout(promise, ms, what) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          Object.assign(new Error(`${what} timed out`), { code: "ETIMEDOUT" }),
        ),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const errorCode = (/** @type {unknown} */ error) =>
  (error &&
    typeof error === "object" &&
    "code" in error &&
    String(error.code)) ||
  (error instanceof Error ? error.message : String(error));

/** @type {Resolve} */
async function systemResolve(host) {
  const results = await lookup(host, { all: true, verbatim: true });
  return results.map((result) => result.address);
}

/** @type {Connect} */
const systemConnect = (address, port) => netConnect({ host: address, port });

/**
 * The proxy server, not yet listening. `resolve` and `connect` default to the
 * system resolver and TCP; tests pass their own.
 * @param {{ hosts: unknown }} config
 * @param {{ resolve?: Resolve, connect?: Connect }} [io]
 */
export function createEgressProxy(config, io = {}) {
  const rules = compileAllowlist(config.hosts);
  const resolve = io.resolve ?? systemResolve;
  const connect = io.connect ?? systemConnect;

  const server = createServer({ requestTimeout: 0 }, (request, response) => {
    forward(request, response).catch(() => response.destroy());
  });
  server.maxConnections = LIMITS.maxConnections;
  server.headersTimeout = LIMITS.headersTimeoutMs;
  server.keepAliveTimeout = 5_000;
  server.on("connection", (socket) => {
    socket.setTimeout(LIMITS.idleTimeoutMs, () => socket.destroy());
    socket.on("error", () => socket.destroy());
  });
  server.on("clientError", (_error, socket) => {
    if (socket.writable && !socket.destroyed)
      socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
    else socket.destroy();
  });

  /**
   * @param {import("node:http").IncomingMessage} request
   * @param {import("node:http").ServerResponse} response
   */
  async function forward(request, response) {
    const refuse = (
      /** @type {number} */ status,
      /** @type {string} */ reason,
    ) => {
      const message = refusalMessage(reason);
      response.writeHead(status, statusText(message), {
        "content-type": "text/plain; charset=utf-8",
        "content-length": Buffer.byteLength(`${message}\n`),
        connection: "close",
        "x-jj-egress": "refused",
      });
      response.end(`${message}\n`);
      request.resume();
    };
    let url;
    try {
      url = new URL(request.url ?? "");
    } catch {
      return refuse(
        400,
        "send absolute-form requests such as GET http://host/path through this proxy",
      );
    }
    if (url.protocol !== "http:" || url.username || url.password)
      return refuse(
        400,
        url.protocol === "https:"
          ? "use CONNECT for https:// (set HTTPS_PROXY, not only HTTP_PROXY)"
          : "only plain http:// requests and CONNECT are forwarded",
      );
    // The body is forwarded with the framing it arrived with, decoded and
    // re-encoded by Node, so its bytes can never pass upstream as another
    // request. Node's parser already refuses Content-Length together with
    // Transfer-Encoding; any coding but plain chunked is refused here.
    const coding = request.headers["transfer-encoding"];
    if (coding !== undefined && coding.trim().toLowerCase() !== "chunked")
      return refuse(
        501,
        `transfer-encoding "${coding}" is not forwarded; send chunked or Content-Length bodies`,
      );
    const length = request.headers["content-length"];
    const host = url.hostname.replace(/^\[(.*)\]$/, "$1").toLowerCase();
    const port = url.port ? Number(url.port) : 80;
    const verdict = await authorize(rules, host, port, resolve);
    if (!verdict.ok) return refuse(verdict.status, verdict.reason);
    let socket;
    try {
      socket = await openUpstream(verdict.addresses, port, connect);
    } catch (error) {
      return refuse(
        502,
        `could not reach ${host}:${port} (${errorCode(error)})`,
      );
    }
    if (request.destroyed) return socket.destroy();
    // RFC 9112 §3.2.2: a proxy replaces Host with the request target's.
    const headers = [
      ...endToEndHeaders(
        request.rawHeaders,
        new Set(["host", "content-length"]),
      ),
      "Host",
      url.host,
      "Connection",
      "close",
      ...(coding !== undefined
        ? ["Transfer-Encoding", "chunked"]
        : length !== undefined
          ? ["Content-Length", length]
          : []),
    ];
    const upstream = httpRequest({
      createConnection: () => socket,
      method: request.method,
      path: `${url.pathname}${url.search}`,
      headers,
      setHost: false,
    });
    upstream.setTimeout(LIMITS.idleTimeoutMs, () => upstream.destroy());
    upstream.on("response", (answer) => {
      response.writeHead(
        answer.statusCode ?? 502,
        answer.statusMessage,
        endToEndHeaders(answer.rawHeaders),
      );
      answer.pipe(response);
      answer.on("error", () => response.destroy());
    });
    upstream.on("error", (error) => {
      if (!response.headersSent)
        refuse(502, `could not reach ${host}:${port} (${errorCode(error)})`);
      else response.destroy();
    });
    response.on("close", () => upstream.destroy());
    request.pipe(upstream);
  }

  server.on("connect", (request, duplex, head) => {
    // A net.Socket for a server on TCP, which this always is.
    const client = /** @type {import("node:net").Socket} */ (duplex);
    client.setTimeout(LIMITS.idleTimeoutMs, () => client.destroy());
    client.on("error", () => client.destroy());
    const refuse = (
      /** @type {number} */ status,
      /** @type {string} */ reason,
    ) => {
      const message = `${refusalMessage(reason)}\n`;
      if (!client.destroyed)
        client.end(
          `HTTP/1.1 ${status} ${statusText(refusalMessage(reason))}\r\n` +
            "Content-Type: text/plain; charset=utf-8\r\n" +
            `Content-Length: ${Buffer.byteLength(message)}\r\n` +
            "X-JJ-Egress: refused\r\nConnection: close\r\n\r\n" +
            message,
        );
    };
    const target = parseAuthority(request.url);
    if (!target) return refuse(400, "CONNECT needs a host:port target");
    tunnel(target.host, target.port).catch(() => client.destroy());

    /**
     * @param {string} host
     * @param {number} port
     */
    async function tunnel(host, port) {
      const verdict = await authorize(rules, host, port, resolve);
      if (!verdict.ok) return refuse(verdict.status, verdict.reason);
      let upstream;
      try {
        upstream = await openUpstream(verdict.addresses, port, connect);
      } catch (error) {
        return refuse(
          502,
          `could not reach ${host}:${port} (${errorCode(error)})`,
        );
      }
      if (client.destroyed) return upstream.destroy();
      upstream.setTimeout(LIMITS.idleTimeoutMs, () => upstream.destroy());
      // An orderly end travels through the pipes (and flushes); a reset on
      // either side ends both.
      upstream.on("error", () => client.destroy());
      upstream.on("close", () => {
        if (!client.writableEnded) client.destroy();
      });
      client.on("close", () => upstream.destroy());
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    }
  });

  return server;
}

/**
 * The configuration the driver passes in `JJ_EGRESS_CONFIG`.
 * @param {string | undefined} text
 * @returns {{ hosts: string[], port: number, subnet: { base: number[], prefix: number } }}
 */
export function parseConfig(text) {
  const config = JSON.parse(text ?? "null");
  if (!config || typeof config !== "object")
    throw new Error(`${CONFIG_VAR} must be a JSON object`);
  compileAllowlist(config.hosts);
  const port = config.port;
  if (!Number.isInteger(port) || port < 1 || port > 65_535)
    throw new Error(`Invalid proxy port ${JSON.stringify(port)}`);
  const subnet = parseSubnet(config.subnet);
  if (!subnet)
    throw new Error(`Invalid subnet ${JSON.stringify(config.subnet)}`);
  return { hosts: config.hosts, port, subnet };
}

/**
 * This container's IPv4 address inside `subnet`: the internal network, the
 * only one the proxy listens on, so containers on its other network cannot
 * use it.
 * @param {{ base: number[], prefix: number }} subnet
 * @param {ReturnType<typeof networkInterfaces>} interfaces
 */
export function listenAddress(subnet, interfaces) {
  for (const entries of Object.values(interfaces))
    for (const entry of entries ?? []) {
      const bytes = parseIPv4(entry.address);
      if (bytes && inIPv4Range(bytes, subnet.base, subnet.prefix))
        return entry.address;
    }
  return undefined;
}

/** Starts the proxy from `JJ_EGRESS_CONFIG`; rejects (and the process exits) on any bad setting. */
export async function startFromEnvironment(env = process.env) {
  const config = parseConfig(env[CONFIG_VAR]);
  const address = listenAddress(config.subnet, networkInterfaces());
  if (!address)
    throw new Error(
      "No interface on the sandbox's internal network to listen on",
    );
  const server = createEgressProxy(config);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, address, () => resolve(undefined));
  });
  return server;
}
