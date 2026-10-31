import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import type { Api, Model } from "@earendil-works/pi-ai";
import { getGlobalDispatcher } from "undici";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelRegistry } from "./models";
import { configureOutboundProxy, type OutboundProxy } from "./proxy";

const listen = (server: Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    }),
  );
const close = (server: Server) =>
  new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });

/** A fake provider that answers every call with 401, recording what reached it. */
function fakeProvider() {
  const requests: { method: string; path: string; auth: string }[] = [];
  const server = createServer((req, res) => {
    requests.push({
      method: req.method ?? "",
      path: req.url ?? "",
      auth: String(
        req.headers.authorization ??
          req.headers["x-api-key"] ??
          req.headers["x-goog-api-key"] ??
          "",
      ),
    });
    req.resume();
    res.writeHead(401, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message: "reached the fake provider",
          type: "authentication_error",
          code: 401,
        },
      }),
    );
  });
  return { server, requests };
}

/** A CONNECT proxy that tunnels every target to `upstreamPort` on loopback. */
function tunnelProxy(upstreamPort: () => number) {
  const log: { target: string; authorization: string }[] = [];
  const server = createServer((req, res) => {
    log.push({ target: `${req.method} ${req.url}`, authorization: "" });
    res.writeHead(502).end();
  });
  server.on("connect", (req, client, head) => {
    log.push({
      target: `CONNECT ${req.url}`,
      authorization: String(req.headers["proxy-authorization"] ?? ""),
    });
    const upstream = connect(upstreamPort(), "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("error", () => upstream.destroy());
  });
  return { server, log };
}

let provider: ReturnType<typeof fakeProvider>;
let proxy: ReturnType<typeof tunnelProxy>;
let providerPort = 0;
let proxyPort = 0;
let configured: OutboundProxy | undefined;

beforeEach(async () => {
  provider = fakeProvider();
  providerPort = await listen(provider.server);
  proxy = tunnelProxy(() => providerPort);
  proxyPort = await listen(proxy.server);
});

afterEach(async () => {
  await configured?.restore();
  configured = undefined;
  await close(proxy.server);
  await close(provider.server);
});

const registry = new ModelRegistry({
  env: {
    OPENAI_API_KEY: "sk-test-openai",
    ANTHROPIC_API_KEY: "sk-test-anthropic",
    GEMINI_API_KEY: "test-gemini",
  },
});

/** One provider request with pi's real adapter, its base URL pointed at `baseUrl`. */
async function call(ref: string, baseUrl: string) {
  const resolved = registry.resolve(ref);
  const model: Model<Api> = { ...resolved.model, baseUrl };
  const stream = registry.models.streamSimple(
    model,
    { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] },
    { apiKey: resolved.getApiKey(), maxRetryDelayMs: 1 },
  );
  return stream.result();
}

describe("configureOutboundProxy", () => {
  it.each([
    ["openai/gpt-6-luna", "/v1", "POST /v1/responses"],
    ["anthropic/claude-haiku-5-5", "", "POST /v1/messages"],
    [
      "google/gemini-2.5-flash-lite",
      "/v1beta",
      "POST /v1beta/models/gemini-2.5-flash-lite",
    ],
  ])(
    "routes pi's %s client through the proxy",
    async (ref, prefix, expected) => {
      configured = configureOutboundProxy({
        HTTP_PROXY: `http://jj:proxy-secret@127.0.0.1:${proxyPort}`,
      });
      expect(configured).toMatchObject({
        httpProxy: `http://127.0.0.1:${proxyPort}`,
      });
      expect(JSON.stringify(configured)).not.toContain("proxy-secret");

      // provider.invalid never resolves: only a proxied request can arrive.
      const result = await call(
        ref,
        `http://provider.invalid:${providerPort}${prefix}`,
      );

      expect(result.stopReason).toBe("error");
      expect(proxy.log[0]).toEqual({
        target: `CONNECT provider.invalid:${providerPort}`,
        authorization: `Basic ${Buffer.from("jj:proxy-secret").toString("base64")}`,
      });
      expect(provider.requests.length).toBeGreaterThan(0);
      expect(
        `${provider.requests[0]?.method} ${provider.requests[0]?.path}`,
      ).toContain(expected);
      expect(provider.requests[0]?.auth).toContain("test-");
    },
  );

  it("sends hosts in NO_PROXY directly", async () => {
    configured = configureOutboundProxy({
      http_proxy: `http://127.0.0.1:${proxyPort}`,
      NO_PROXY: "127.0.0.1",
    });
    await call("openai/gpt-6-luna", `http://127.0.0.1:${providerPort}/v1`);
    expect(proxy.log).toEqual([]);
    expect(provider.requests).toHaveLength(1);
  });

  it("uses HTTPS_PROXY for https origins and leaves http origins direct", async () => {
    configured = configureOutboundProxy({
      HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
    });
    expect(configured).toEqual({
      httpsProxy: `http://127.0.0.1:${proxyPort}`,
      restore: expect.any(Function),
    });
    await call("openai/gpt-6-luna", `http://127.0.0.1:${providerPort}/v1`);
    expect(proxy.log).toEqual([]);
    expect(provider.requests).toHaveLength(1);
  });

  it("changes nothing without a proxy, and restores the previous dispatcher", async () => {
    const before = getGlobalDispatcher();
    expect(configureOutboundProxy({ NO_PROXY: "example.com" })).toBeUndefined();
    expect(getGlobalDispatcher()).toBe(before);
    const proxied = configureOutboundProxy({
      HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
    });
    expect(getGlobalDispatcher()).not.toBe(before);
    await proxied?.restore();
    expect(getGlobalDispatcher()).toBe(before);
  });
});
