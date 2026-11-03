// The remote guard against a real local https server (a certificate for
// mcp.test made with openssl): what it refuses (http, private addresses,
// names that resolve to them, redirects, oversized messages, everything with
// JJ_MCP_REMOTE=off), a pinned direct connection, and the path through an
// outbound proxy.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer, type Server as HttpsServer } from "node:https";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TLSSocket } from "node:tls";
import type { JsonRpcMessage } from "@earendil-works/pi-mcp";
import { isPublicAddress } from "@jj/sandbox/addresses";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { McpConnection } from "./connector";
import { McpServerError } from "./errors";
import {
  createRemoteTransport,
  MCP_REMOTE_DISABLED,
  type RemoteTransportOptions,
  remoteMcpEnabled,
} from "./remote";
import { ScriptedMcpServer } from "./test-server";

const TOKEN = "secret-token-0123456789";
const SECRET = `Bearer ${TOKEN}`;
/** GET requests the server saw: pi-mcp resumes a cut event stream with GET. */
let gets = 0;
let dir: string;
let cert: string;
let key: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "jj-mcp-tls-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-subj",
      "/CN=mcp.test",
      "-addext",
      "subjectAltName=DNS:mcp.test,DNS:public.test",
      "-days",
      "2",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  cert = readFileSync(join(dir, "cert.pem"), "utf8");
  key = readFileSync(join(dir, "key.pem"), "utf8");
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Seen {
  method: string;
  url: string;
  host: string;
  servername: string | false;
  authorization: string;
  apiKey: string;
  rpc?: string;
}

/** A Streamable HTTP MCP endpoint on loopback, answering JSON, with misbehaving paths. */
function mcpServer() {
  const scripted = new ScriptedMcpServer({
    tools: [
      { name: "echo", description: "Echoes." },
      { name: "huge" },
      { name: "huge_stream" },
    ],
  });
  const seen: Seen[] = [];
  const server: HttpsServer = createServer({ cert, key }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      const message = body ? (JSON.parse(body) as JsonRpcMessage) : undefined;
      seen.push({
        method: req.method ?? "",
        url: req.url ?? "",
        host: req.headers.host ?? "",
        // The name the client sent in TLS SNI (Node sets it on server sockets).
        servername:
          (req.socket as TLSSocket & { servername?: string | false })
            .servername ?? false,
        authorization: String(req.headers.authorization ?? ""),
        apiKey: String(req.headers["x-api-key"] ?? ""),
        ...(message && "method" in message ? { rpc: message.method } : {}),
      });
      if (req.url === "/redirect") {
        res.writeHead(302, { location: "https://elsewhere.test/mcp" }).end();
        return;
      }
      if (req.url === "/forbidden") {
        res
          .writeHead(403, { "content-type": "text/plain" })
          .end(`refused credentials ${req.headers.authorization}`);
        return;
      }
      const apiKey = String(req.headers["x-api-key"] ?? "");
      if (req.url === "/bare") {
        // The token without the prefix its header carries.
        res
          .writeHead(403, { "content-type": "text/plain" })
          .end(
            `Invalid token: ${String(req.headers.authorization).replace(/^Bearer /, "")}`,
          );
        return;
      }
      if (req.url === "/cut") {
        // The key across the 500 characters pi-mcp keeps of an error body.
        res
          .writeHead(403, { "content-type": "text/plain" })
          .end(`${"x".repeat(499 - apiKey.length + 2)}${apiKey} trailing`);
        return;
      }
      if (req.method === "GET") {
        gets++;
        res
          .writeHead(200, { "content-type": "text/event-stream" })
          .end(
            `id: ${gets}\nretry: 0\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"x"}}\n\n`,
          );
        return;
      }
      if (req.method === "DELETE" || !message) {
        res.writeHead(200).end();
        return;
      }
      if (!("id" in message)) {
        scripted.handle(message, () => {});
        res.writeHead(202).end();
        return;
      }
      const name =
        "params" in message
          ? (message.params as { name?: string } | undefined)?.name
          : undefined;
      if (name === "stream_cut") {
        // An event stream that ends before the answer, with an event id: resumable.
        res
          .writeHead(200, { "content-type": "text/event-stream" })
          .end(
            `id: 0\nretry: 0\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"x"}}\n\n`,
          );
        return;
      }
      if (name === "denied" && "id" in message) {
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: {
              code: -32000,
              message: `denied for ${req.headers.authorization}`,
            },
          }),
        );
        return;
      }
      if (name === "huge" || name === "huge_stream") {
        const size = 5 * 1024 * 1024;
        res.writeHead(200, {
          "content-type": "application/json",
          ...(name === "huge" ? { "content-length": String(size) } : {}),
        });
        const chunk = Buffer.alloc(64 * 1024, " ");
        let sent = 0;
        const pump = () => {
          while (sent < size) {
            sent += chunk.length;
            if (!res.write(chunk)) {
              res.once("drain", pump);
              return;
            }
          }
          res.end();
        };
        res.on("error", () => {});
        pump();
        return;
      }
      scripted.handle(message, (reply) => {
        res
          .writeHead(200, {
            "content-type": "application/json",
            "mcp-session-id": "session-1",
          })
          .end(JSON.stringify(reply));
      });
    });
  });
  return { server, seen, scripted };
}

/** A CONNECT proxy that tunnels every target to `port` on loopback. */
function tunnelProxy(port: () => number) {
  const targets: string[] = [];
  const server: Server = createHttpServer((_req, res) =>
    res.writeHead(405).end(),
  );
  server.on("connect", (req, client: Socket, head) => {
    targets.push(req.url ?? "");
    const upstream = connect(port(), "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  return { server, targets };
}

const listen = (server: Server | HttpsServer) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    }),
  );

const shut = (server: Server | HttpsServer) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

let endpoint: ReturnType<typeof mcpServer>;
let port = 0;
const open: McpConnection[] = [];
const servers: (Server | HttpsServer)[] = [];

beforeAll(async () => {
  endpoint = mcpServer();
  port = await listen(endpoint.server);
  servers.push(endpoint.server);
});

afterEach(async () => {
  await Promise.all(open.splice(0).map((connection) => connection.close()));
  endpoint.seen.length = 0;
});

afterAll(async () => {
  await Promise.all(servers.map(shut));
});

/** Loopback stands in for a public address; everything else is judged as in production. */
const allowLoopback = (address: string) =>
  address === "127.0.0.1" || isPublicAddress(address);

function remote(url: string, options: Partial<RemoteTransportOptions> = {}) {
  const resolved: string[] = [];
  const transport = createRemoteTransport({
    url,
    secretHeaders: { Authorization: { prefix: "Bearer ", value: TOKEN } },
    env: {},
    ca: cert,
    isAllowedAddress: allowLoopback,
    resolve: async (host) => {
      resolved.push(host);
      if (host === "mcp.test") return ["127.0.0.1"];
      throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), {
        code: "ENOTFOUND",
      });
    },
    ...options,
  });
  const connection = new McpConnection({
    server: "docs",
    transport,
    startupTimeoutMs: 5_000,
    // The engine's redactor knows nothing of these secrets: the connector must scrub them itself.
    redact: (text) => text,
  });
  open.push(connection);
  return { connection, transport, resolved };
}

/** True when the text holds any 6 characters in a row of the secret. */
const leaks = (text: string, secret: string) => {
  for (let at = 0; at + 6 <= secret.length; at++)
    if (text.includes(secret.slice(at, at + 6))) return true;
  return false;
};

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof McpServerError) return error;
    throw error;
  }
  throw new Error("expected the promise to fail");
};

describe("remote MCP guard", () => {
  it("connects over https to the address it checked, sending credentials to that origin only", async () => {
    const { connection, resolved } = remote(`https://mcp.test:${port}/mcp`);
    await connection.start();
    const listed = await connection.listTools();
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "echo",
      "huge",
      "huge_stream",
    ]);
    const result = await connection.callTool(
      "echo",
      { text: "hi" },
      { timeoutMs: 5_000 },
    );
    expect(result.content).toEqual([{ type: "text", text: '{"text":"hi"}' }]);
    // mcp.test resolves nowhere but in the guard: the connection went where it checked.
    expect(resolved).toContain("mcp.test");
    expect(endpoint.seen.map((request) => request.rpc)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
    for (const request of endpoint.seen) {
      expect(request.host).toBe(`mcp.test:${port}`);
      expect(request.servername).toBe("mcp.test");
      expect(request.authorization).toBe(SECRET);
    }
  });

  it("refuses http, before resolving or connecting", async () => {
    const { connection, resolved } = remote(`http://mcp.test:${port}/mcp`);
    const error = await failure(connection.start());
    expect(error.kind).toBe("refused");
    expect(error.message).toBe(
      "MCP servers are reached over https only, not http.",
    );
    expect(resolved).toEqual([]);
    expect(endpoint.seen).toEqual([]);
  });

  it.each([
    ["127.0.0.1", `https://127.0.0.1:${0}/mcp`],
    ["10.0.0.1", "https://10.0.0.1/mcp"],
    ["169.254.169.254", "https://169.254.169.254/latest/meta-data"],
    ["::1", "https://[::1]/mcp"],
    ["127.0.0.1", "https://0x7f000001/mcp"],
  ])("refuses the private address %s in the URL", async (address, url) => {
    const { connection, resolved } = remote(url, {
      isAllowedAddress: isPublicAddress,
    });
    const error = await failure(connection.start());
    expect(error.kind).toBe("refused");
    expect(error.message).toBe(
      `${address} is not a public address; only public addresses are reached.`,
    );
    expect(resolved).toEqual([]);
  });

  it("refuses a name that resolves to a private address, even among public ones", async () => {
    for (const addresses of [["10.0.0.5"], ["93.184.215.14", "192.168.1.1"]]) {
      const { connection } = remote(`https://internal.test:${port}/mcp`, {
        resolve: async () => addresses,
      });
      const error = await failure(connection.start());
      expect(error.kind).toBe("refused");
      expect(error.message).toBe(
        "internal.test resolves to an address that is not public; only public addresses are reached.",
      );
    }
    expect(endpoint.seen).toEqual([]);
  });

  it("checks again as it connects, so a name that rebinds to a private address is refused", async () => {
    let calls = 0;
    const { connection } = remote(`https://mcp.test:${port}/mcp`, {
      isAllowedAddress: isPublicAddress,
      // Public for the check before the request, loopback when connecting.
      resolve: async () => (calls++ === 0 ? ["93.184.215.14"] : ["127.0.0.1"]),
    });
    const error = await failure(connection.start());
    expect(error.kind).toBe("refused");
    expect(error.message).toBe(
      "mcp.test resolves to an address that is not public; only public addresses are reached.",
    );
    expect(calls).toBe(2);
    expect(endpoint.seen).toEqual([]);
  });

  it("says why a name that resolves nowhere could not be reached", async () => {
    const { connection } = remote(`https://nowhere.test:${port}/mcp`);
    const error = await failure(connection.start());
    expect(error.kind).toBe("startup");
    expect(error.message).toBe(
      "MCP server docs could not start: fetch failed: getaddrinfo ENOTFOUND nowhere.test",
    );
  });

  it("refuses a redirect, never following it", async () => {
    const { connection } = remote(`https://mcp.test:${port}/redirect`);
    const error = await failure(connection.start());
    expect(error.kind).toBe("refused");
    expect(error.message).toBe(
      "The MCP server answered with a redirect (302); redirects are not followed.",
    );
    expect(endpoint.seen.map((request) => request.url)).toEqual(["/redirect"]);
  });

  it.each([
    ["with a content-length", "huge"],
    ["streamed without one", "huge_stream"],
  ])(
    "closes the connection on a response over 4 MiB, %s",
    async (_label, tool) => {
      const { connection } = remote(`https://mcp.test:${port}/mcp`);
      await connection.start();
      const ends: unknown[] = [];
      connection.onClose((end) => ends.push(end));
      const error = await failure(
        connection.callTool(tool, {}, { timeoutMs: 10_000 }),
      );
      expect(error.message).toContain(
        "The MCP server sent a message over 4194304 bytes; the connection was closed",
      );
      expect(connection.state).toBe("closed");
      expect(ends).toEqual([
        expect.objectContaining({
          reason: "closed",
          error:
            "The MCP server sent a message over 4194304 bytes; the connection was closed.",
        }),
      ]);
    },
  );

  it("fails a call whose answer stream ends early at once, never re-opening the stream", async () => {
    gets = 0;
    const { connection } = remote(`https://mcp.test:${port}/mcp`);
    await connection.start();
    const started = Date.now();
    const error = await failure(
      connection.callTool("stream_cut", {}, { timeoutMs: 2_000 }),
    );
    // Resuming with GET looped (retry: 0) until the call's timeout, and after it.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(error.kind).toBe("server");
    expect(error.message).toContain(
      "MCP response stream failed: stream ended without a response",
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(gets).toBe(0);
  });

  it("keeps a secret header's value out of an error that echoes it without its prefix", async () => {
    const { connection } = remote(`https://mcp.test:${port}/bare`);
    const error = await failure(connection.start());
    expect(error.message).toContain("status 403: Invalid token: [redacted]");
    expect(leaks(error.message, TOKEN)).toBe(false);
  });

  it("keeps a secret header's value out of an error body that pi-mcp cuts through it", async () => {
    const key = "zq9vH2kLm4Np7Rs1Tu3W";
    const { connection } = remote(`https://mcp.test:${port}/cut`, {
      secretHeaders: { "X-Api-Key": { value: key } },
    });
    const error = await failure(connection.start());
    expect(endpoint.seen[0]?.apiKey).toBe(key);
    expect(error.message).toContain("status 403");
    expect(leaks(error.message, key)).toBe(false);
  });

  it("keeps a secret header's value out of a JSON-RPC error the server answers with", async () => {
    const { connection } = remote(`https://mcp.test:${port}/mcp`);
    await connection.start();
    const error = await failure(
      connection.callTool("denied", {}, { timeoutMs: 5_000 }),
    );
    expect(error.kind).toBe("server");
    expect(error.message).toContain("denied for Bearer [redacted]");
    expect(leaks(error.message, TOKEN)).toBe(false);
  });

  it("keeps the secret header values out of errors", async () => {
    const { connection } = remote(`https://mcp.test:${port}/forbidden`);
    const error = await failure(connection.start());
    expect(error.message).toContain(
      "status 403: refused credentials Bearer [redacted]",
    );
    expect(error.message).not.toContain("secret-token");
  });

  it("refuses every remote server with JJ_MCP_REMOTE=off, and refuses a value it does not know", async () => {
    const { connection, resolved } = remote(`https://mcp.test:${port}/mcp`, {
      env: { JJ_MCP_REMOTE: "off" },
    });
    const error = await failure(connection.start());
    expect(error.kind).toBe("refused");
    expect(error.message).toBe(MCP_REMOTE_DISABLED);
    expect(resolved).toEqual([]);
    expect(endpoint.seen).toEqual([]);
    expect(remoteMcpEnabled({})).toBe(true);
    expect(remoteMcpEnabled({ JJ_MCP_REMOTE: "ON" })).toBe(true);
    expect(() => remoteMcpEnabled({ JJ_MCP_REMOTE: "false" })).toThrow(
      'JJ_MCP_REMOTE must be on or off, not "false".',
    );
  });
});

describe("remote MCP guard behind an outbound proxy", () => {
  let proxy: ReturnType<typeof tunnelProxy>;
  let proxyPort = 0;

  beforeAll(async () => {
    proxy = tunnelProxy(() => port);
    proxyPort = await listen(proxy.server);
    servers.push(proxy.server);
  });

  afterEach(() => {
    proxy.targets.length = 0;
  });

  it("lets the proxy resolve a name the worker cannot, tunnelling to it by name", async () => {
    const { connection, resolved } = remote(`https://public.test:${port}/mcp`, {
      env: { HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` },
    });
    await connection.start();
    await connection.listTools();
    expect(resolved).toContain("public.test");
    expect(proxy.targets[0]).toBe(`public.test:${port}`);
    expect(endpoint.seen[0]?.servername).toBe("public.test");
  });

  it("refuses a name the worker resolves to a private address, before the proxy sees it", async () => {
    const { connection } = remote(`https://internal.test:${port}/mcp`, {
      env: { HTTPS_PROXY: `http://127.0.0.1:${proxyPort}` },
      resolve: async () => ["10.1.2.3"],
    });
    const error = await failure(connection.start());
    expect(error.kind).toBe("refused");
    expect(proxy.targets).toEqual([]);
  });

  it("says so when the proxy refuses the tunnel", async () => {
    const refusing = createHttpServer((_req, res) => res.writeHead(405).end());
    refusing.on("connect", (_req, socket: Socket) =>
      socket.end("HTTP/1.1 403 Forbidden\r\ncontent-length: 0\r\n\r\n"),
    );
    const refusingPort = await listen(refusing);
    servers.push(refusing);
    const { connection } = remote(`https://public.test:${port}/mcp`, {
      env: { HTTPS_PROXY: `http://127.0.0.1:${refusingPort}` },
    });
    const error = await failure(connection.start());
    expect(error.kind).toBe("startup");
    expect(error.message).toMatch(
      /^MCP server docs could not start: fetch failed: .*\b403\b/,
    );
    expect(endpoint.seen).toEqual([]);
  });

  it("connects directly, pinned, to a host NO_PROXY names", async () => {
    const { connection } = remote(`https://mcp.test:${port}/mcp`, {
      env: {
        HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
        NO_PROXY: "mcp.test",
      },
    });
    await connection.start();
    expect(proxy.targets).toEqual([]);
    expect(endpoint.seen[0]?.servername).toBe("mcp.test");
  });
});
