// Server and worker settings from the environment. Everything is read and
// checked here, before anything opens, so a setting that cannot work stops the
// process with one clear message instead of failing later.
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  configFromEnv,
  type EngineConfigInput,
  type LogSettings,
  logSettings,
  MasterKeyError,
  parseMasterKey,
} from "@jj/backend";
import { nodeDataDirectory } from "@jj/db";
import { remoteMcpEnabled } from "@jj/runtime";
import { parseSubnetPool } from "@jj/sandbox";

export type Env = Readonly<Record<string, string | undefined>>;

/** A setting that cannot work. The process prints the message and exits. */
export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

/** The repository root. Relative paths in settings resolve against it. */
export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/** The built web app the API serves when it exists (`npm run build -w @jj/web`). */
export const WEB_DIST = join(REPO_ROOT, "apps", "web", "dist");

export const SANDBOX_DRIVER_IDS = ["docker", "local"] as const;
export type SandboxDriverId = (typeof SANDBOX_DRIVER_IDS)[number];

export type DatabaseSetting =
  | { mode: "pglite"; path: string }
  | { mode: "postgres"; connectionString: string };

/** What the API and the standalone worker both open. */
export interface ServicesConfig {
  database: DatabaseSetting;
  /** Sandbox drivers to register, in order. */
  drivers: readonly SandboxDriverId[];
  /** Workspace root of the `local` driver; unset uses the driver's default (`<os.tmpdir()>/jj-sandbox`). */
  localRoot?: string;
  /** Container and volume name prefix of the `docker` driver. */
  dockerNamespace: string;
  dockerAllowInsecureTcp: boolean;
  /** Where the `docker` driver's allowlist networks take their subnets; unset uses the driver's default. */
  dockerEgressSubnetPool?: string;
  /** Registers the keyless `scripted/team` test model. */
  enableScripted: boolean;
  /** The secrets store's master keys; absent without `JJ_SECRET_KEY`. */
  secretKeys?: SecretKeys;
  /** `JJ_MCP_REMOTE`: remote MCP servers may be called. Default true. */
  mcpRemote?: boolean;
  engine: EngineConfigInput;
  /** `JJ_LOG_LEVEL` and `JJ_LOG_FORMAT`; absent: info, JSON. */
  log?: LogSettings;
  /**
   * `JJ_DRAIN_TIMEOUT_SEC`: how long a stop signal lets running sessions
   * reach a turn boundary before the rest is interrupted as a lost lease is.
   */
  drainTimeoutMs: number;
  /**
   * `JJ_STOP_GRACE_PERIOD` (compose passes its `stop_grace_period`): how
   * long the platform waits before it kills the process; unknown when unset.
   */
  stopGracePeriodMs?: number;
}

/** `JJ_DRAIN_TIMEOUT_SEC` when unset. */
export const DEFAULT_DRAIN_TIMEOUT_SEC = 20;
/** The longest drain `JJ_DRAIN_TIMEOUT_SEC` may ask for. */
const MAX_DRAIN_TIMEOUT_SEC = 3600;
/**
 * What a stop needs beyond the drain: the process's own 20 s to release
 * sandboxes and close (`SHUTDOWN_AFTER_DRAIN_MS`), and some slack.
 */
export const STOP_GRACE_MARGIN_MS = 25_000;

const DURATION_UNITS: Record<string, number> = {
  h: 3_600_000,
  m: 60_000,
  s: 1_000,
  ms: 1,
  us: 0.001,
  ns: 0.000001,
};

/** A duration as compose writes one (`45s`, `1m30s`, `2m`), in milliseconds. */
export function parseDuration(text: string): number | undefined {
  const parts = [...text.matchAll(/(\d+(?:\.\d+)?)(ms|us|ns|h|m|s)/g)];
  if (parts.length === 0 || parts.map((part) => part[0]).join("") !== text)
    return undefined;
  return parts.reduce(
    (total, [, value, unit]) =>
      total + Number(value) * (DURATION_UNITS[unit as string] ?? 0),
    0,
  );
}

/**
 * The boot warning when the platform would kill a stop before its drain and
 * shutdown end: its sessions would then resume as after a crash, once their
 * leases run out.
 */
export function stopGraceWarning(config: ServicesConfig): string | undefined {
  const grace = config.stopGracePeriodMs;
  if (
    grace === undefined ||
    config.drainTimeoutMs + STOP_GRACE_MARGIN_MS <= grace
  )
    return undefined;
  return `JJ_STOP_GRACE_PERIOD (${grace / 1000} s) is less than JJ_DRAIN_TIMEOUT_SEC (${config.drainTimeoutMs / 1000} s) plus ${STOP_GRACE_MARGIN_MS / 1000} s: a stop can be killed before it drains and shuts down, and its sessions then resume only once their leases run out. Raise the stop grace period (compose: JJ_STOP_GRACE_PERIOD) or lower JJ_DRAIN_TIMEOUT_SEC.`;
}

/** `JJ_SECRET_KEY` and `JJ_SECRET_KEY_PREVIOUS`, decoded, with their text for redaction. */
export interface SecretKeys {
  current: Buffer;
  previous: Buffer[];
  /** The variables' values as written, redacted like the server's other secrets. */
  texts: string[];
}

export interface ServerConfig extends ServicesConfig {
  /** The listen address, without IPv6 brackets. */
  host: string;
  port: number;
  /** `API_TOKEN`. Without it, a listener beyond loopback uses a generated token. */
  apiToken?: string;
  /** Where users open the app, for the startup line: `API_PUBLIC_URL`, else `http://127.0.0.1:<port>`. */
  publicUrl?: string;
  /** API_ALLOWED_HOSTS: `Host` values besides loopback that `/api/*` answers without a token (refused at boot without one). */
  allowedHosts: string[];
  /** Run the job loop inside the API process. */
  embedWorker: boolean;
  /** The built web app to serve, or null. */
  webDist: string | null;
}

const LOOPBACK_NAMES = new Set(["localhost", "::1", "0:0:0:0:0:0:0:1"]);

/** True for addresses only this machine can reach. `0.0.0.0` and `::` listen everywhere. */
export function isLoopbackHost(host: string): boolean {
  const name = host
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
  if (LOOPBACK_NAMES.has(name)) return true;
  const v4 = name.startsWith("::ffff:") ? name.slice("::ffff:".length) : name;
  return /^127(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/.test(v4);
}

const text = (env: Env, name: string) => {
  const value = env[name]?.trim();
  return value ? value : undefined;
};

function flag(env: Env, name: string, fallback: boolean): boolean {
  const value = text(env, name)?.toLowerCase();
  if (value === undefined) return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new ConfigError(`${name} must be true or false; got "${value}".`);
}

function port(env: Env, name: string, fallback: number): number {
  const value = text(env, name);
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > 65535)
    throw new ConfigError(`${name} must be a port number; got "${value}".`);
  return number;
}

function seconds(env: Env, name: string, fallback: number, max: number) {
  const value = text(env, name);
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > max)
    throw new ConfigError(
      `${name} must be a whole number of seconds from 0 to ${max}; got "${value}".`,
    );
  return number;
}

function stopGracePeriod(env: Env): { stopGracePeriodMs?: number } {
  const value = text(env, "JJ_STOP_GRACE_PERIOD");
  if (value === undefined) return {};
  const ms = parseDuration(value);
  if (ms === undefined)
    throw new ConfigError(
      `JJ_STOP_GRACE_PERIOD must be a duration such as 45s or 1m30s; got "${value}".`,
    );
  return { stopGracePeriodMs: ms };
}

const fromRoot = (path: string) =>
  isAbsolute(path) ? path : resolve(REPO_ROOT, path);

/**
 * PostgreSQL when `DATABASE_URL` is set, else PGlite at `JJ_DATABASE_PATH`
 * (default `.jj-data`; `memory://` keeps nothing).
 */
export function databaseSetting(env: Env): DatabaseSetting {
  const url = text(env, "DATABASE_URL");
  if (url) return { mode: "postgres", connectionString: url };
  const path = text(env, "JJ_DATABASE_PATH") ?? ".jj-data";
  const directory = nodeDataDirectory(path);
  return { mode: "pglite", path: directory ? fromRoot(directory) : path };
}

/**
 * The `docker` driver's namespace: `JJ_DOCKER_NAMESPACE`, default
 * `jj-sandbox`. Its task workspaces are the volumes `<namespace>-task-<id>`.
 */
export function dockerNamespace(env: Env): string {
  return text(env, "JJ_DOCKER_NAMESPACE") ?? "jj-sandbox";
}

function driverList(env: Env): SandboxDriverId[] {
  const raw = text(env, "JJ_SANDBOX_DRIVERS") ?? SANDBOX_DRIVER_IDS.join(",");
  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const unknown = ids.filter(
    (id) => !(SANDBOX_DRIVER_IDS as readonly string[]).includes(id),
  );
  if (unknown.length > 0 || ids.length === 0)
    throw new ConfigError(
      `JJ_SANDBOX_DRIVERS lists ${SANDBOX_DRIVER_IDS.join(" and/or ")}, comma-separated; got "${raw}".`,
    );
  return [...new Set(ids)] as SandboxDriverId[];
}

/** `JJ_MCP_REMOTE`: `on` (or unset) lets the worker call remote MCP servers, `off` turns them off. */
export function mcpRemote(env: Env): boolean {
  try {
    return remoteMcpEnabled(env);
  } catch (error) {
    throw new ConfigError(
      error instanceof Error ? error.message : String(error),
    );
  }
}

/**
 * The master key of the secrets store, and the keys it replaced. Unset: the
 * store is off. A key that cannot be used stops the process, naming the
 * variable and never the value.
 */
export function secretKeys(env: Env): SecretKeys | undefined {
  const current = text(env, "JJ_SECRET_KEY");
  const previous = (text(env, "JJ_SECRET_KEY_PREVIOUS") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!current) {
    if (previous.length > 0)
      throw new ConfigError(
        "JJ_SECRET_KEY_PREVIOUS is set without JJ_SECRET_KEY: set the new key as JJ_SECRET_KEY and keep the old ones in JJ_SECRET_KEY_PREVIOUS.",
      );
    return undefined;
  }
  try {
    return {
      current: parseMasterKey(current, "JJ_SECRET_KEY"),
      previous: previous.map((value, index) =>
        parseMasterKey(value, `JJ_SECRET_KEY_PREVIOUS (entry ${index + 1})`),
      ),
      texts: [current, ...previous],
    };
  } catch (error) {
    if (error instanceof MasterKeyError) throw new ConfigError(error.message);
    throw error;
  }
}

export function loadServicesConfig(env: Env): ServicesConfig {
  const database = databaseSetting(env);
  let engine: EngineConfigInput;
  let log: LogSettings;
  try {
    engine = configFromEnv(env);
    log = logSettings(env);
  } catch (error) {
    throw new ConfigError(
      error instanceof Error ? error.message : String(error),
    );
  }
  const keys = secretKeys(env);
  const sandboxRoot = text(env, "JJ_SANDBOX_ROOT");
  const egressPool = text(env, "JJ_DOCKER_EGRESS_SUBNET_POOL");
  if (egressPool !== undefined)
    try {
      parseSubnetPool(egressPool);
    } catch (error) {
      throw new ConfigError(
        `JJ_DOCKER_EGRESS_SUBNET_POOL: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  return {
    database,
    drivers: driverList(env),
    // Outside any checkout by default, so a workspace never sits in a repository.
    ...(sandboxRoot ? { localRoot: fromRoot(sandboxRoot) } : {}),
    dockerNamespace: dockerNamespace(env),
    dockerAllowInsecureTcp: flag(env, "JJ_DOCKER_ALLOW_INSECURE_TCP", false),
    ...(egressPool ? { dockerEgressSubnetPool: egressPool } : {}),
    enableScripted: flag(env, "JJ_ENABLE_SCRIPTED_MODEL", false),
    ...(keys ? { secretKeys: keys } : {}),
    mcpRemote: mcpRemote(env),
    engine,
    log,
    drainTimeoutMs:
      seconds(
        env,
        "JJ_DRAIN_TIMEOUT_SEC",
        DEFAULT_DRAIN_TIMEOUT_SEC,
        MAX_DRAIN_TIMEOUT_SEC,
      ) * 1000,
    ...stopGracePeriod(env),
  };
}

/**
 * Whether the API answers without any token: no API_TOKEN and a loopback
 * listener. Anywhere else it requires one, generating it when API_TOKEN is
 * unset (see `resolveApiToken`).
 */
export const servesWithoutToken = (
  config: Pick<ServerConfig, "apiToken" | "host">,
) => !config.apiToken && isLoopbackHost(config.host);

/**
 * Refuses settings that would expose the API beyond this machine without a
 * token, or send the token over plain http across a network:
 *
 * - API_ALLOWED_HOSTS or an API_PUBLIC_URL beyond loopback while the API
 *   answers without a token. A reverse proxy or `tailscale serve` on the same
 *   host forwards from loopback, so the listener alone cannot tell.
 * - A plain-http API_PUBLIC_URL beyond loopback, unless
 *   JJ_ALLOW_INSECURE_HTTP=true.
 */
function checkExposure(
  env: Env,
  config: Pick<
    ServerConfig,
    "apiToken" | "host" | "allowedHosts" | "publicUrl"
  >,
) {
  const url = config.publicUrl ? new URL(config.publicUrl) : undefined;
  const remote = url && !isLoopbackHost(url.hostname) ? url : undefined;
  const allowInsecure = flag(env, "JJ_ALLOW_INSECURE_HTTP", false);
  if (servesWithoutToken(config)) {
    if (config.allowedHosts.length > 0)
      throw new ConfigError(
        "API_ALLOWED_HOSTS is set, but the API has no token: it listens on loopback without API_TOKEN, so whatever forwards those names to it (a reverse proxy, `tailscale serve`) would expose it unauthenticated. Set API_TOKEN, and serve it over HTTPS.",
      );
    if (remote)
      throw new ConfigError(
        `API_PUBLIC_URL names "${remote.hostname}", beyond loopback, but the API has no token: it listens on loopback without API_TOKEN, so whatever forwards that address to it (a reverse proxy, \`tailscale serve\`) would expose it unauthenticated. Set API_TOKEN, and serve it over HTTPS.`,
      );
  }
  if (remote?.protocol === "http:" && !allowInsecure)
    throw new ConfigError(
      `API_PUBLIC_URL is plain http beyond loopback ("${remote.hostname}"), so the token would cross the network in the clear. Serve the app over HTTPS through a reverse proxy and set API_PUBLIC_URL to its https:// address, or set JJ_ALLOW_INSECURE_HTTP=true on a network that encrypts traffic itself.`,
    );
}

/** An absolute http(s) URL without a trailing slash. */
function publicUrl(env: Env): string | undefined {
  const value = text(env, "API_PUBLIC_URL");
  if (value === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigError(
      `API_PUBLIC_URL must be an http(s) URL; got "${value}".`,
    );
  }
  if (!["http:", "https:"].includes(url.protocol) || url.search || url.hash)
    throw new ConfigError(
      `API_PUBLIC_URL must be an http(s) URL without a query; got "${value}".`,
    );
  return url.toString().replace(/\/+$/, "");
}

/**
 * The API's settings. Beyond loopback without `API_TOKEN`, the server
 * generates a token on first boot (see `resolveApiToken`), so it never
 * listens there unauthenticated; settings that would expose a tokenless
 * loopback API, or the token over plain http, are refused (`checkExposure`).
 */
export function loadServerConfig(env: Env): ServerConfig {
  // `[::1]` names the address; listen() takes it without the brackets.
  const host = (text(env, "API_HOST") ?? "127.0.0.1").replace(
    /^\[(.*)\]$/,
    "$1",
  );
  const apiToken = text(env, "API_TOKEN");
  const url = publicUrl(env);
  const services = loadServicesConfig(env);
  const embedWorker = flag(env, "JJ_EMBED_WORKER", true);
  if (!embedWorker && services.database.mode === "pglite")
    throw new ConfigError(
      "JJ_EMBED_WORKER=false needs PostgreSQL: PGlite is single-process, so no separate worker can open it. Set DATABASE_URL, or embed the worker.",
    );
  const allowedHosts = (text(env, "API_ALLOWED_HOSTS") ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  checkExposure(env, {
    host,
    allowedHosts,
    ...(apiToken ? { apiToken } : {}),
    ...(url ? { publicUrl: url } : {}),
  });
  return {
    ...services,
    host,
    port: port(env, "API_PORT", 3001),
    ...(apiToken ? { apiToken } : {}),
    ...(url ? { publicUrl: url } : {}),
    allowedHosts,
    embedWorker,
    webDist: existsSync(join(WEB_DIST, "index.html")) ? WEB_DIST : null,
  };
}

/** The standalone worker's settings: PostgreSQL only. */
export function loadWorkerConfig(env: Env): ServicesConfig {
  if (!text(env, "DATABASE_URL"))
    throw new ConfigError(
      "The standalone worker needs PostgreSQL: set DATABASE_URL. PGlite is single-process, so with PGlite the API runs the worker itself (JJ_EMBED_WORKER, on by default).",
    );
  return loadServicesConfig(env);
}

/** A connection string with its password removed, for messages. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return "(unparseable URL)";
  }
}

/**
 * An endpoint for a log line, such as the OTLP collector's: its user name,
 * password and every query value replaced, since any of them can carry a key.
 */
export function redactEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.username) parsed.username = "***";
    if (parsed.password) parsed.password = "***";
    for (const key of new Set(parsed.searchParams.keys()))
      parsed.searchParams.set(key, "***");
    return parsed.toString();
  } catch {
    return "(unparseable URL)";
  }
}
