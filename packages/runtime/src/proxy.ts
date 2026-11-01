import {
  type Dispatcher,
  EnvHttpProxyAgent,
  getGlobalDispatcher,
  setGlobalDispatcher,
} from "undici";

/**
 * Provider SDKs inside pi-ai (openai, @anthropic-ai/sdk, @google/genai) send
 * requests with Node's global `fetch`, which ignores HTTPS_PROXY and
 * HTTP_PROXY unless the process starts with NODE_USE_ENV_PROXY=1. This
 * installs undici's EnvHttpProxyAgent as the global dispatcher, which Node's
 * fetch uses, so those requests honour the standard proxy variables.
 * NODE_EXTRA_CA_CERTS keeps working: the agent uses Node's default TLS trust.
 */

export interface OutboundProxy {
  /** Proxy URLs with any credentials removed, for logs. */
  httpProxy?: string;
  httpsProxy?: string;
  noProxy?: string;
  /** Puts back the dispatcher that was installed before. */
  restore(): Promise<void>;
}

const first = (...values: (string | undefined)[]) =>
  values.map((value) => value?.trim()).find((value) => value) ?? undefined;

/** A proxy URL without its user info, for logs. */
export function redactProxyUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString().replace(/\/$/, "");
  } catch {
    return "(unparseable proxy URL)";
  }
}

/**
 * Routes outbound HTTP(S) from this process through the proxy named by
 * `https_proxy`/`HTTPS_PROXY` (HTTPS) and `http_proxy`/`HTTP_PROXY` (HTTP, and
 * HTTPS when no HTTPS proxy is set), except hosts matched by
 * `no_proxy`/`NO_PROXY`. Lowercase names win, as in curl. Only `env` is read.
 * Returns undefined, changing nothing, when no proxy is set. Call it once at
 * boot, before the first provider request.
 */
export function configureOutboundProxy(
  env: Readonly<Record<string, string | undefined>> = process.env,
): OutboundProxy | undefined {
  const httpProxy = first(env.http_proxy, env.HTTP_PROXY);
  const httpsProxy = first(env.https_proxy, env.HTTPS_PROXY);
  if (!httpProxy && !httpsProxy) return undefined;
  const noProxy = first(env.no_proxy, env.NO_PROXY);
  const previous: Dispatcher = getGlobalDispatcher();
  // Empty strings, not undefined: undici would otherwise fall back to process.env.
  const agent = new EnvHttpProxyAgent({
    httpProxy: httpProxy ?? "",
    httpsProxy: httpsProxy ?? "",
    noProxy: noProxy ?? "",
    // Plain-HTTP origins also use CONNECT tunnels, as pi's own CLI does.
    proxyTunnel: true,
  });
  setGlobalDispatcher(agent);
  return {
    ...(httpProxy ? { httpProxy: redactProxyUrl(httpProxy) } : {}),
    ...(httpsProxy ? { httpsProxy: redactProxyUrl(httpsProxy) } : {}),
    ...(noProxy ? { noProxy } : {}),
    restore: async () => {
      if (getGlobalDispatcher() === agent) setGlobalDispatcher(previous);
      await agent.close();
    },
  };
}
