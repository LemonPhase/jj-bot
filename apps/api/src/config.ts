// Server and worker settings from the environment. Everything is read and
// checked here, before anything opens, so a setting that cannot work stops the
// process with one clear message instead of failing later.
import { existsSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { configFromEnv, type EngineConfigInput } from "@jj/backend";
import { nodeDataDirectory } from "@jj/db";

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
  /** Registers the keyless `scripted/team` test model. */
  enableScripted: boolean;
  engine: EngineConfigInput;
}

export interface ServerConfig extends ServicesConfig {
  /** The listen address, without IPv6 brackets. */
  host: string;
  port: number;
  /** `API_TOKEN`. Without it, a listener beyond loopback uses a generated token. */
  apiToken?: string;
  /** Where users open the app, for the startup line: `API_PUBLIC_URL`, else `http://127.0.0.1:<port>`. */
  publicUrl?: string;
  /** API_ALLOWED_HOSTS: `Host` values besides loopback that `/api/*` answers without a token. */
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

export function loadServicesConfig(env: Env): ServicesConfig {
  const database = databaseSetting(env);
  let engine: EngineConfigInput;
  try {
    engine = configFromEnv(env);
  } catch (error) {
    throw new ConfigError(
      error instanceof Error ? error.message : String(error),
    );
  }
  const sandboxRoot = text(env, "JJ_SANDBOX_ROOT");
  return {
    database,
    drivers: driverList(env),
    // Outside any checkout by default, so a workspace never sits in a repository.
    ...(sandboxRoot ? { localRoot: fromRoot(sandboxRoot) } : {}),
    dockerNamespace: text(env, "JJ_DOCKER_NAMESPACE") ?? "jj-sandbox",
    dockerAllowInsecureTcp: flag(env, "JJ_DOCKER_ALLOW_INSECURE_TCP", false),
    enableScripted: flag(env, "JJ_ENABLE_SCRIPTED_MODEL", false),
    engine,
  };
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
 * listens there unauthenticated.
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
  return {
    ...services,
    host,
    port: port(env, "API_PORT", 3001),
    ...(apiToken ? { apiToken } : {}),
    ...(url ? { publicUrl: url } : {}),
    allowedHosts: (text(env, "API_ALLOWED_HOSTS") ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
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
