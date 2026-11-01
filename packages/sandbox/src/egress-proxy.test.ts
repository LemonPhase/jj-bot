import { type ChildProcess, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  createServer as createHttpServer,
  request as httpRequest,
  type IncomingHttpHeaders,
} from "node:http";
import {
  type AddressInfo,
  createServer as createNetServer,
  connect as netConnect,
  type Server,
  type Socket,
} from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { networkHostSchema } from "./contract";
import {
  EGRESS_CONFIG_VAR,
  egressProxyCommand,
  egressProxyScript,
  sandboxProxyEnv,
} from "./drivers/egress";
import {
  authorize,
  CONFIG_VAR,
  compileAllowlist,
  createEgressProxy,
  endToEndHeaders,
  hostListed,
  isAllowed,
  isIPLiteral,
  isPublicAddress,
  listenAddress,
  parseAllowEntry,
  parseAuthority,
  parseConfig,
  parseIPv6,
  parseSubnet,
} from "./drivers/egress-proxy.mjs";

/**
 * The egress proxy of the docker driver's allowlist mode. Everything here
 * imports `drivers/egress-proxy.mjs`, the file the driver passes verbatim to
 * `node --eval` in the proxy container, and the last suite runs it exactly as
 * the container does (`egressProxyCommand()`), so these tests check the code
 * that enforces the allowlist, not a copy of it. Daemon-backed checks of the
 * whole path are in docker.test.ts and the conformance suite.
 */

const rules = (...entries: string[]) => compileAllowlist(entries);

describe("allowlist entries", () => {
  it("parses hosts, wildcards and ports", () => {
    expect(parseAllowEntry("registry.npmjs.org")).toEqual({
      host: "registry.npmjs.org",
      wildcard: false,
      ports: [80, 443],
    });
    expect(parseAllowEntry("*.pythonhosted.org:8443")).toEqual({
      host: "pythonhosted.org",
      wildcard: true,
      ports: [8443],
    });
    expect(parseAllowEntry("93.184.215.14:80")).toEqual({
      host: "93.184.215.14",
      wildcard: false,
      ports: [80],
    });
    expect(parseAllowEntry("localhost")).toMatchObject({ host: "localhost" });
  });

  it("refuses anything else, and a configuration with any bad entry", () => {
    for (const entry of [
      "",
      "*",
      "*.",
      "*.org",
      "*.8.8",
      "*.8.8.8",
      "*.0x8.0x8",
      "*.example.123",
      "*.example.0x1",
      "**.example.com",
      "a.*.example.com",
      "https://example.com",
      "example.com/path",
      "example.com:",
      ":443",
      "example.com:0",
      "example.com:65536",
      "example.com:443:80",
      "Example.com",
      "under_score.com",
      "-leading.com",
      "trailing-.com",
      "a..b",
      ".example.com",
      "example.com.",
      " example.com",
      "[::1]",
      "::1",
      `${"a".repeat(64)}.com`,
      null,
      42,
    ])
      expect(parseAllowEntry(entry), String(entry)).toBeNull();
    expect(() => compileAllowlist(["example.com", "https://x.com"])).toThrow(
      /Invalid allowlist entry/,
    );
    expect(() => compileAllowlist([])).toThrow(/non-empty/);
    expect(() => compileAllowlist("example.com")).toThrow(/non-empty/);
  });

  it("accepts exactly what the contract accepts, after its normalisation", () => {
    const label63 = "a".repeat(63);
    const corpus = [
      "example.com",
      "EXAMPLE.com",
      " example.com ",
      "*.example.com",
      "*.com",
      "*.co.uk",
      "*.8.8",
      "*.8.8.8:53",
      "*.0x8.0x8",
      "*.example.123",
      "*.123.example.com",
      "*.0x1.example.com",
      "8.8.8.8",
      "x.y.z.example.com:65535",
      "example.com:65536",
      "example.com:00080",
      "1.2.3.4",
      "999.1.1.1",
      "a-b.c-d.e",
      "a_b.com",
      "-a.com",
      "a-.com",
      "a..com",
      "a.com/",
      "http://a.com",
      "*",
      "*.",
      "::1",
      `${label63}.com`,
      `${label63}a.com`,
      [label63, label63, label63, "a".repeat(61)].join("."),
      [label63, label63, label63, "a".repeat(62)].join("."),
      `*.${[label63, label63, label63, "a".repeat(61)].join(".")}`,
    ];
    for (const candidate of corpus) {
      const contract = networkHostSchema.safeParse(candidate);
      const proxy = parseAllowEntry(candidate.trim().toLowerCase());
      expect(proxy !== null, candidate).toBe(contract.success);
    }
  });
});

describe("matching", () => {
  it("allows a bare host on ports 80 and 443 only, and never its subdomains", () => {
    const list = rules("example.com");
    expect(isAllowed(list, "example.com", 443)).toBe(true);
    expect(isAllowed(list, "example.com", 80)).toBe(true);
    expect(isAllowed(list, "example.com", 8080)).toBe(false);
    expect(isAllowed(list, "www.example.com", 443)).toBe(false);
    expect(isAllowed(list, "example.com.evil.net", 443)).toBe(false);
    expect(isAllowed(list, "badexample.com", 443)).toBe(false);
  });

  it("allows every subdomain for a wildcard, but not the name itself", () => {
    const list = rules("*.example.com");
    expect(isAllowed(list, "a.example.com", 443)).toBe(true);
    expect(isAllowed(list, "a.b.example.com", 80)).toBe(true);
    expect(isAllowed(list, "example.com", 443)).toBe(false);
    expect(isAllowed(list, "badexample.com", 443)).toBe(false);
    expect(isAllowed(list, "a.example.com.evil.net", 443)).toBe(false);
  });

  it("never lets a wildcard match an IP address, in any form", () => {
    // Such rules cannot be configured (see above); built by hand, they still
    // never match an address.
    const handmade = [
      { host: "8.8", wildcard: true, ports: [80, 443] },
      { host: "0x8.0x8", wildcard: true, ports: [80, 443] },
    ];
    for (const host of ["8.8.8.8", "0x8.0x8.0x8.0x8", "1.8.8", "10.8.8"])
      expect(isAllowed(handmade, host, 443), host).toBe(false);
    for (const host of [
      "8.8.8.8",
      "134744072",
      "0x8.0x8.0x8.0x8",
      "1.2.3",
      "::1",
      "::ffff:8.8.8.8",
    ])
      expect(isIPLiteral(host), host).toBe(true);
    for (const host of ["a.8.8.8", "example.com", "8.8.8.8.8", "8.example"])
      expect(isIPLiteral(host), host).toBe(false);
    // An exact entry for an address still works.
    expect(isAllowed(rules("8.8.8.8:53"), "8.8.8.8", 53)).toBe(true);
  });

  it("allows only the given port for host:port, and unions entries", () => {
    const list = rules("example.com:8443", "*.example.com:22", "example.com");
    expect(isAllowed(list, "example.com", 8443)).toBe(true);
    expect(isAllowed(list, "example.com", 443)).toBe(true);
    expect(isAllowed(list, "example.com", 22)).toBe(false);
    expect(isAllowed(list, "git.example.com", 22)).toBe(true);
    expect(isAllowed(list, "git.example.com", 443)).toBe(false);
    expect(hostListed(list, "git.example.com")).toBe(true);
    expect(hostListed(list, "example.org")).toBe(false);
  });
});

describe("addresses", () => {
  it("refuses every non-public address, IPv4-mapped forms included", () => {
    for (const address of [
      "0.0.0.0",
      "0.1.2.3",
      "10.0.0.1",
      "100.64.0.1",
      "100.127.255.255",
      "127.0.0.1",
      "127.255.255.254",
      "169.254.169.254",
      "172.16.0.1",
      "172.17.0.1",
      "172.31.255.255",
      "192.0.0.8",
      "192.0.2.1",
      "192.88.99.1",
      "192.168.1.1",
      "198.18.0.1",
      "198.19.255.255",
      "198.51.100.7",
      "203.0.113.9",
      "224.0.0.1",
      "239.255.255.250",
      "240.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "::127.0.0.1",
      "::ffff:127.0.0.1",
      "::ffff:7f00:1",
      "::FFFF:10.0.0.1",
      "::ffff:169.254.169.254",
      "64:ff9b::7f00:1",
      "64:ff9b::808:808",
      "fc00::1",
      "fd12:3456:789a::1",
      "fe80::1",
      "fe80::1%eth0",
      "ff02::1",
      "2001::1",
      "2001:db8::1",
      "2002:7f00:1::1",
      "3fff::1",
      "not-an-ip",
      "",
      "1.2.3",
      "1.2.3.4.5",
      "01.2.3.4",
      "256.1.1.1",
    ])
      expect(isPublicAddress(address), address).toBe(false);
  });

  it("allows public unicast addresses", () => {
    for (const address of [
      "1.1.1.1",
      "8.8.8.8",
      "93.184.215.14",
      "100.63.255.255",
      "100.128.0.1",
      "172.15.255.255",
      "172.32.0.1",
      "192.169.0.1",
      "198.20.0.1",
      "::ffff:8.8.8.8",
      "2001:4860:4860::8888",
      "2606:4700:4700::1111",
      "2a00:1450:4001:82a::200e",
    ])
      expect(isPublicAddress(address), address).toBe(true);
  });

  it("parses IPv6 strictly", () => {
    expect(parseIPv6("1::")).toEqual([1, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseIPv6("::ffff:1.2.3.4")).toEqual([
      0, 0, 0, 0, 0, 0xffff, 0x0102, 0x0304,
    ]);
    expect(parseIPv6("1:2:3:4:5:6:7:8")).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    for (const bad of [
      ":1",
      "1:",
      "1:::2",
      "1::2::3",
      "1:2:3:4:5:6:7:8:9",
      "1:2:3:4:5:6:7",
      "12345::",
      "::1.2.3",
      "1.2.3.4",
      "g::1",
    ])
      expect(parseIPv6(bad), bad).toBeNull();
  });

  it("parses subnets and finds the address to listen on", () => {
    const subnet = parseSubnet("172.20.0.0/16");
    expect(subnet).toEqual({ base: [172, 20, 0, 0], prefix: 16 });
    for (const bad of ["172.20.0.0", "172.20.0.0/33", "x/16", "fd00::/8", 7])
      expect(parseSubnet(bad), String(bad)).toBeNull();
    if (!subnet) throw new Error("subnet");
    const entry = (address: string) => ({
      address,
      netmask: "",
      family: "IPv4" as const,
      mac: "",
      internal: false,
      cidr: null,
    });
    expect(
      listenAddress(subnet, {
        eth0: [entry("172.17.0.3")],
        eth1: [entry("172.20.0.2")],
      }),
    ).toBe("172.20.0.2");
    expect(listenAddress(subnet, { eth0: [entry("172.17.0.3")] })).toBe(
      undefined,
    );
  });
});

describe("authorize", () => {
  const list = rules("example.com", "*.example.org", "172.17.0.1:3001");
  const resolver = (answers: Record<string, string[]>) => {
    const asked: string[] = [];
    const resolve = async (host: string) => {
      asked.push(host);
      const found = answers[host];
      if (found) return found;
      throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    };
    return { asked, resolve };
  };

  it("refuses unlisted hosts and ports without resolving them", async () => {
    const { asked, resolve } = resolver({});
    expect(await authorize(list, "example.net", 443, resolve)).toEqual({
      ok: false,
      status: 403,
      reason: "example.net is not in this runtime profile's network allowlist",
    });
    expect(await authorize(list, "example.com", 8080, resolve)).toEqual({
      ok: false,
      status: 403,
      reason:
        "port 8080 of example.com is not in this runtime profile's network allowlist",
    });
    expect(await authorize(list, "a..example.org", 443, resolve)).toMatchObject(
      { ok: false, status: 400 },
    );
    expect(asked).toEqual([]);
  });

  it("returns the checked addresses of a listed public host", async () => {
    const { asked, resolve } = resolver({
      "example.com": [
        "93.184.215.14",
        "2606:2800:21f:cb07:6820:80da:af6b:8b2c",
      ],
    });
    expect(await authorize(list, "example.com", 443, resolve)).toEqual({
      ok: true,
      host: "example.com",
      addresses: ["93.184.215.14", "2606:2800:21f:cb07:6820:80da:af6b:8b2c"],
    });
    expect(asked).toEqual(["example.com"]);
  });

  it("refuses a listed host when any address it resolves to is private", async () => {
    const { resolve } = resolver({
      "a.example.org": ["93.184.215.14", "10.0.0.7"],
      "b.example.org": ["::ffff:127.0.0.1"],
      "172.17.0.1": ["172.17.0.1"],
    });
    expect(await authorize(list, "a.example.org", 443, resolve)).toEqual({
      ok: false,
      status: 403,
      reason:
        "a.example.org resolves to a private address; only public destinations are reachable",
    });
    expect(await authorize(list, "b.example.org", 80, resolve)).toMatchObject({
      ok: false,
      status: 403,
    });
    expect(await authorize(list, "172.17.0.1", 3001, resolve)).toEqual({
      ok: false,
      status: 403,
      reason:
        "172.17.0.1 is a private address; only public destinations are reachable",
    });
  });

  it("reports a name that does not resolve", async () => {
    const { resolve } = resolver({});
    expect(await authorize(list, "x.example.org", 443, resolve)).toEqual({
      ok: false,
      status: 502,
      reason: "x.example.org could not be resolved (ENOTFOUND)",
    });
    expect(
      await authorize(list, "y.example.org", 443, async () => []),
    ).toMatchObject({ ok: false, status: 502 });
  });

  it("parses CONNECT targets", () => {
    expect(parseAuthority("Example.COM:443")).toEqual({
      host: "example.com",
      port: 443,
    });
    expect(parseAuthority("[::1]:80")).toEqual({ host: "::1", port: 80 });
    for (const bad of [
      "example.com",
      "example.com:0",
      "example.com:70000",
      "user@example.com:443",
      "example.com:443/x",
      "",
      undefined,
    ])
      expect(parseAuthority(bad), String(bad)).toBeNull();
  });

  it("drops hop-by-hop headers and the ones Connection names", () => {
    expect(
      endToEndHeaders(
        [
          "Host",
          "a",
          "Connection",
          "keep-alive, X-Secret-Hop",
          "X-Secret-Hop",
          "1",
          "Proxy-Authorization",
          "Basic x",
          "Proxy-Connection",
          "keep-alive",
          "Accept",
          "*/*",
        ],
        new Set(["host"]),
      ),
    ).toEqual(["Accept", "*/*"]);
  });
});

// --- The server, over real sockets ------------------------------------------

const listen = async (server: Server): Promise<number> => {
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return (server.address() as AddressInfo).port;
};

/** Sends raw bytes and collects everything until the peer closes or `untilText` arrives. */
function exchange(
  port: number,
  send: string,
  untilText?: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = netConnect(port, "127.0.0.1", () => socket.write(send));
    let received = "";
    socket.on("data", (chunk) => {
      received += chunk.toString("latin1");
      if (untilText && received.includes(untilText)) socket.end();
    });
    socket.on("close", () => resolve(received));
    socket.on("error", reject);
    socket.setTimeout(5_000, () => socket.destroy());
  });
}

describe("the proxy server", () => {
  const PUBLIC_TUNNEL = "93.184.215.14";
  const PUBLIC_WEB = "93.184.215.15";
  const PUBLIC_RAW = "93.184.215.17";
  let tunnelPort = 0;
  let webPort = 0;
  let rawPort = 0;
  let proxyPort = 0;
  const sockets = new Set<Socket>();
  const servers: Server[] = [];
  const connects: string[] = [];
  const resolves: string[] = [];
  /** Every byte each connection to the raw upstream carried. */
  const rawReceived: string[] = [];
  let seen: { url?: string; headers: IncomingHttpHeaders } | undefined;

  beforeAll(async () => {
    const tunnel = createNetServer((socket) => {
      sockets.add(socket);
      socket.on("data", (chunk) => socket.write(`UPSTREAM:${chunk}`));
    });
    // Records what arrives, then answers once the client falls quiet.
    const raw = createNetServer((socket) => {
      sockets.add(socket);
      const index = rawReceived.push("") - 1;
      let quiet: NodeJS.Timeout | undefined;
      socket.on("data", (chunk) => {
        rawReceived[index] += chunk.toString("latin1");
        clearTimeout(quiet);
        quiet = setTimeout(
          () =>
            socket.end(
              "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok",
            ),
          150,
        );
      });
      socket.on("error", () => {});
    });
    servers.push(raw);
    rawPort = await listen(raw);
    const web = createHttpServer((request, response) => {
      seen = { url: request.url, headers: request.headers };
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("from upstream");
    });
    servers.push(tunnel, web);
    tunnelPort = await listen(tunnel);
    webPort = await listen(web);
    const answers: Record<string, string[]> = {
      "tunnel.example.com": [PUBLIC_TUNNEL],
      "web.example.com": [PUBLIC_WEB],
      "raw.example.com": [PUBLIC_RAW],
      "down.example.com": ["93.184.215.16"],
      "private.example.com": ["10.1.2.3"],
    };
    const proxy = createEgressProxy(
      { hosts: ["*.example.com", "web.example.com:8080"] },
      {
        resolve: async (host) => {
          resolves.push(host);
          const found = answers[host];
          if (!found)
            throw Object.assign(new Error("nx"), { code: "ENOTFOUND" });
          return found;
        },
        // Stands in for the network: the checked public addresses lead to
        // the local test servers, anything else nowhere.
        connect: (address, port) => {
          connects.push(`${address}:${port}`);
          const local =
            address === PUBLIC_TUNNEL
              ? tunnelPort
              : address === PUBLIC_WEB
                ? webPort
                : address === PUBLIC_RAW
                  ? rawPort
                  : 1;
          return netConnect(local, "127.0.0.1");
        },
      },
    );
    servers.push(proxy);
    proxyPort = await listen(proxy);
  });

  afterEach(() => {
    connects.length = 0;
    resolves.length = 0;
    rawReceived.length = 0;
    seen = undefined;
  });

  /** What the raw upstream received for one request, split into head and body. */
  const upstreamRequest = (index = 0) => {
    const received = rawReceived[index] ?? "";
    const end = received.indexOf("\r\n\r\n");
    return {
      head: received.slice(0, end).toLowerCase(),
      body: received.slice(end + 4),
    };
  };

  it("frames a chunked body as chunked, so it can never pass as another request", async () => {
    // A GET whose chunked body is itself a request. Sent upstream without
    // framing, the upstream would read GET /smuggled with Host: internal.
    const smuggled = "GET /smuggled HTTP/1.1\r\nHost: internal\r\n\r\n";
    const answer = await exchange(
      proxyPort,
      "GET http://raw.example.com/ HTTP/1.1\r\nHost: raw.example.com\r\nTransfer-Encoding: chunked\r\n\r\n" +
        `${smuggled.length.toString(16)}\r\n${smuggled}\r\n0\r\n\r\n`,
      "ok",
    );
    expect(answer).toMatch(/^HTTP\/1\.1 200 OK/);
    expect(rawReceived).toHaveLength(1);
    const { head, body } = upstreamRequest();
    expect(head).toMatch(/^get \/ http\/1\.1\r\n/);
    expect(head).toContain("\r\ntransfer-encoding: chunked");
    expect(head).not.toContain("content-length");
    // The smuggled text arrives inside a chunk, as the body it was.
    expect(body).toBe(
      `${smuggled.length.toString(16)}\r\n${smuggled}\r\n0\r\n\r\n`,
    );
  });

  it("forwards a Content-Length body with its length, for any method", async () => {
    for (const method of ["POST", "GET", "DELETE"]) {
      rawReceived.length = 0;
      await exchange(
        proxyPort,
        `${method} http://raw.example.com/upload HTTP/1.1\r\nHost: raw.example.com\r\nContent-Length: 5\r\n\r\nhello`,
        "ok",
      );
      const { head, body } = upstreamRequest();
      expect(head, method).toContain("\r\ncontent-length: 5");
      expect(head, method).not.toContain("transfer-encoding");
      expect(body, method).toBe("hello");
    }
  });

  it("refuses transfer codings it would have to pass through", async () => {
    const refused = await exchange(
      proxyPort,
      "POST http://raw.example.com/ HTTP/1.1\r\nHost: raw.example.com\r\nTransfer-Encoding: gzip, chunked\r\n\r\n0\r\n\r\n",
      "Content-Length",
    );
    expect(refused).toMatch(/^HTTP\/1\.1 501 JJ Bot egress: transfer-encoding/);
    // Content-Length together with Transfer-Encoding never gets through.
    const both = await exchange(
      proxyPort,
      "POST http://raw.example.com/ HTTP/1.1\r\nHost: raw.example.com\r\nContent-Length: 4\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n",
    );
    expect(both).toMatch(/^HTTP\/1\.1 400 /);
    expect(rawReceived).toEqual([]);
  });

  afterAll(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(
      servers.map(
        (server) => new Promise((done) => server.close(() => done(undefined))),
      ),
    );
  });

  it("tunnels CONNECT to a listed host through the address it checked", async () => {
    const received = await exchange(
      proxyPort,
      "CONNECT tunnel.example.com:443 HTTP/1.1\r\nHost: tunnel.example.com:443\r\n\r\nhello",
      "UPSTREAM:hello",
    );
    expect(received).toMatch(/^HTTP\/1\.1 200 Connection Established\r\n\r\n/);
    expect(received).toContain("UPSTREAM:hello");
    expect(resolves).toEqual(["tunnel.example.com"]);
    expect(connects).toEqual([`${PUBLIC_TUNNEL}:443`]);
  });

  it("refuses CONNECT to an unlisted or private target, with the reason in the status line", async () => {
    const unlisted = await exchange(
      proxyPort,
      "CONNECT example.org:443 HTTP/1.1\r\n\r\n",
    );
    expect(unlisted.split("\r\n")[0]).toBe(
      "HTTP/1.1 403 JJ Bot egress: example.org is not in this runtime profile's network allowlist",
    );
    expect(unlisted).toContain("X-JJ-Egress: refused");
    const apex = await exchange(
      proxyPort,
      "CONNECT example.com:443 HTTP/1.1\r\n\r\n",
    );
    expect(apex).toMatch(/^HTTP\/1\.1 403 /);
    const privateTarget = await exchange(
      proxyPort,
      "CONNECT private.example.com:443 HTTP/1.1\r\n\r\n",
    );
    expect(privateTarget.split("\r\n")[0]).toBe(
      "HTTP/1.1 403 JJ Bot egress: private.example.com resolves to a private address; only public destinations are reachable",
    );
    const literal = await exchange(
      proxyPort,
      "CONNECT 127.0.0.1:443 HTTP/1.1\r\n\r\n",
    );
    expect(literal).toMatch(/^HTTP\/1\.1 403 /);
    expect(connects).toEqual([]);
  });

  it("reports an upstream that cannot be reached", async () => {
    const received = await exchange(
      proxyPort,
      "CONNECT down.example.com:443 HTTP/1.1\r\n\r\n",
    );
    expect(received).toMatch(
      /^HTTP\/1\.1 502 JJ Bot egress: could not reach down\.example\.com:443/,
    );
  });

  it("forwards plain HTTP with the target's Host and without proxy headers", async () => {
    const answer = await new Promise<{ status?: number; body: string }>(
      (resolve, reject) => {
        const request = httpRequest(
          {
            host: "127.0.0.1",
            port: proxyPort,
            path: "http://web.example.com:8080/path?q=1",
            headers: {
              Host: "elsewhere.example.net",
              "Proxy-Authorization": "Basic c2VjcmV0",
              "Proxy-Connection": "keep-alive",
              "X-Kept": "yes",
            },
          },
          (response) => {
            let body = "";
            response.on("data", (chunk) => {
              body += chunk;
            });
            response.on("end", () =>
              resolve({ status: response.statusCode, body }),
            );
          },
        );
        request.on("error", reject);
        request.end();
      },
    );
    expect(answer).toEqual({ status: 200, body: "from upstream" });
    expect(seen?.url).toBe("/path?q=1");
    expect(seen?.headers.host).toBe("web.example.com:8080");
    expect(seen?.headers["x-kept"]).toBe("yes");
    expect(seen?.headers["proxy-authorization"]).toBeUndefined();
    expect(seen?.headers["proxy-connection"]).toBeUndefined();
    expect(connects).toEqual([`${PUBLIC_WEB}:8080`]);
  });

  it("refuses plain HTTP it does not forward, with a readable body", async () => {
    const refused = await exchange(
      proxyPort,
      "GET http://example.org/ HTTP/1.1\r\nHost: example.org\r\n\r\n",
      "allowlist\n",
    );
    expect(refused).toMatch(
      /^HTTP\/1\.1 403 JJ Bot egress: example\.org is not/,
    );
    expect(refused).toMatch(
      /\r\n\r\nJJ Bot egress: example\.org is not in this runtime profile's network allowlist\n$/,
    );
    const https = await exchange(
      proxyPort,
      "GET https://web.example.com/ HTTP/1.1\r\nHost: web.example.com\r\n\r\n",
      "\n\n",
    );
    expect(https).toMatch(/^HTTP\/1\.1 400 JJ Bot egress: use CONNECT/);
    const origin = await exchange(
      proxyPort,
      "GET / HTTP/1.1\r\nHost: web.example.com\r\n\r\n",
      "path\n",
    );
    expect(origin).toMatch(/^HTTP\/1\.1 400 JJ Bot egress: send absolute-form/);
    expect(connects).toEqual([]);
  });
});

// --- The program as the container runs it ------------------------------------

describe("the proxy program", () => {
  const children: ChildProcess[] = [];

  afterEach(() => {
    for (const child of children.splice(0)) child.kill("SIGKILL");
  });

  const freePort = async () => {
    const server = createNetServer();
    const port = await listen(server);
    await new Promise((done) => server.close(done));
    return port;
  };

  /** Runs `egressProxyCommand()` as the container does, with this Node binary. */
  function run(config: unknown) {
    const [, ...args] = egressProxyCommand();
    const child = spawn(process.execPath, args, {
      env: { [EGRESS_CONFIG_VAR]: JSON.stringify(config) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    children.push(child);
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    const exited = new Promise<number | null>((done) =>
      child.on("exit", (code) => done(code)),
    );
    return { child, exited, stderr: () => stderr };
  }

  it("is egress-proxy.mjs verbatim plus the call that starts it", () => {
    const file = readFileSync(
      new URL("./drivers/egress-proxy.mjs", import.meta.url),
      "utf8",
    );
    expect(egressProxyScript()).toBe(
      `${file}\nawait startFromEnvironment();\n`,
    );
    expect(EGRESS_CONFIG_VAR).toBe(CONFIG_VAR);
    expect(egressProxyCommand().slice(0, -1)).toEqual([
      "node",
      "--max-old-space-size=64",
      "--input-type=module",
      "--eval",
    ]);
  });

  it("starts from its configuration and refuses unlisted hosts", async () => {
    const port = await freePort();
    const proxy = run({ hosts: ["example.com"], port, subnet: "127.0.0.0/8" });
    let received = "";
    for (let attempt = 0; attempt < 100 && !received; attempt++) {
      received = await exchange(
        port,
        "CONNECT example.org:443 HTTP/1.1\r\n\r\n",
      ).catch(() => "");
      if (!received) await new Promise((done) => setTimeout(done, 50));
    }
    expect(received.split("\r\n")[0], proxy.stderr()).toBe(
      "HTTP/1.1 403 JJ Bot egress: example.org is not in this runtime profile's network allowlist",
    );
  });

  it("exits instead of starting with a configuration it does not accept", async () => {
    const port = await freePort();
    for (const config of [
      { hosts: ["https://example.com"], port, subnet: "127.0.0.0/8" },
      { hosts: [], port, subnet: "127.0.0.0/8" },
      { hosts: ["example.com"], port: 0, subnet: "127.0.0.0/8" },
      // No interface of this machine is in it: nothing to listen on.
      { hosts: ["example.com"], port, subnet: "198.51.100.0/24" },
      "not an object",
    ]) {
      const proxy = run(config);
      expect(await proxy.exited, JSON.stringify(config)).not.toBe(0);
    }
    expect(() => parseConfig(undefined)).toThrow();
  });

  it("gives the sandbox every spelling of the proxy variables", () => {
    expect(sandboxProxyEnv("172.20.0.2")).toEqual([
      "HTTP_PROXY=http://172.20.0.2:3128",
      "HTTPS_PROXY=http://172.20.0.2:3128",
      "http_proxy=http://172.20.0.2:3128",
      "https_proxy=http://172.20.0.2:3128",
      "NO_PROXY=localhost,127.0.0.1",
      "no_proxy=localhost,127.0.0.1",
      "NODE_USE_ENV_PROXY=1",
    ]);
  });
});
