import { readFileSync } from "node:fs";

/**
 * How the docker driver runs the egress proxy of the `allowlist` network
 * mode. The program is `egress-proxy.mjs`, passed verbatim to `node --eval`
 * with one line appended that starts it, so the tests, which import that
 * file, check exactly what runs in the container.
 */

/** The port the proxy listens on, on its internal-network address only. */
export const EGRESS_PROXY_PORT = 3128;

/** Must match `CONFIG_VAR` in egress-proxy.mjs. */
export const EGRESS_CONFIG_VAR = "JJ_EGRESS_CONFIG";

/** V8 heap ceiling of the proxy, well under its container memory limit. */
const PROXY_HEAP_MB = 64;

let source: string | undefined;

/** The proxy program: egress-proxy.mjs verbatim, then the call that starts it. */
export function egressProxyScript(): string {
  source ??= readFileSync(
    new URL("./egress-proxy.mjs", import.meta.url),
    "utf8",
  );
  return `${source}\nawait startFromEnvironment();\n`;
}

/** The proxy container's command line. The image needs only `node` (22 or later). */
export function egressProxyCommand(): string[] {
  return [
    "node",
    `--max-old-space-size=${PROXY_HEAP_MB}`,
    "--input-type=module",
    "--eval",
    egressProxyScript(),
  ];
}

/** The proxy's configuration, as the container's only environment entry. */
export function egressProxyEnv(
  hosts: readonly string[],
  subnet: string,
): string[] {
  return [
    `${EGRESS_CONFIG_VAR}=${JSON.stringify({ hosts, port: EGRESS_PROXY_PORT, subnet })}`,
  ];
}

/**
 * The sandbox container's environment: every common spelling of the proxy
 * variables, so curl, git, pip, npm and Node's own fetch use the proxy. None
 * of it is secret.
 */
export function sandboxProxyEnv(proxyAddress: string): string[] {
  const url = `http://${proxyAddress}:${EGRESS_PROXY_PORT}`;
  const local = "localhost,127.0.0.1";
  return [
    `HTTP_PROXY=${url}`,
    `HTTPS_PROXY=${url}`,
    `http_proxy=${url}`,
    `https_proxy=${url}`,
    `NO_PROXY=${local}`,
    `no_proxy=${local}`,
    "NODE_USE_ENV_PROXY=1",
  ];
}

/**
 * A command, run in the proxy container, that exits 0 once something listens
 * on the proxy port there and 1 if nothing does within `timeoutMs`.
 */
export function egressListeningCheck(timeoutMs: number): string[] {
  const port = EGRESS_PROXY_PORT.toString(16).toUpperCase().padStart(4, "0");
  const script = [
    `const fs=require("fs");const end=Date.now()+${timeoutMs};`,
    `const up=()=>["/proc/net/tcp","/proc/net/tcp6"].some(f=>{try{return /^\\s*\\d+: [0-9A-F]+:${port} [0-9A-F]+:0000 0A /m.test(fs.readFileSync(f,"utf8"))}catch{return false}});`,
    `const poll=()=>up()?process.exit(0):Date.now()>end?process.exit(1):setTimeout(poll,25);poll();`,
  ].join("");
  return ["node", "-e", script];
}
