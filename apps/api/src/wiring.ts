// The composition shared by the API and the standalone worker: the database,
// the sandbox drivers, the model registry, the pi executor and chat responder,
// and the engine over them. The caller decides whether the worker runs.
import {
  consoleLogger,
  createDriverRegistry,
  createEngine,
  type DriverEntry,
  type DriverRegistry,
  type Engine,
  type Logger,
  type Secret,
} from "@jj/backend";
import { type Database, openDatabase, readInstanceSetting } from "@jj/db";
import { ChatResponder, ModelRegistry, PiSessionExecutor } from "@jj/runtime";
import { DockerSandboxDriver, LocalSandboxDriver } from "@jj/sandbox";
import {
  ConfigError,
  type Env,
  redactUrl,
  type ServicesConfig,
} from "./config";
import { GENERATED_TOKEN_KEY } from "./token";

export interface Services {
  database: Database;
  drivers: DriverRegistry;
  models: ModelRegistry;
  engine: Engine;
  /** The server's secret values the engine redacts, read afresh on each call. */
  secrets: () => Promise<Secret[]>;
}

/**
 * The database password from a PostgreSQL URL, as written and decoded. It is
 * redacted only in URL position (`:<password>@`): passwords such as
 * "postgres" are ordinary words elsewhere.
 */
export function databasePassword(connectionString: string): string[] {
  try {
    const { password } = new URL(connectionString);
    if (!password) return [];
    return [...new Set([password, decodeURIComponent(password)])];
  } catch {
    return [];
  }
}

/**
 * The server's secrets: the provider keys in `env`, `API_TOKEN`, the database
 * password, and the generated API token, which is read from the database on
 * each call, so a worker that started before the API generated it still
 * redacts it.
 */
function serverSecrets(
  config: ServicesConfig,
  env: Env,
  database: Database,
  models: ModelRegistry,
): () => Promise<Secret[]> {
  const fixed: Secret[] = [
    ...models.secretValues(),
    ...(env.API_TOKEN?.trim()
      ? [{ name: "API_TOKEN", value: env.API_TOKEN.trim() }]
      : []),
    ...(config.database.mode === "postgres"
      ? databasePassword(config.database.connectionString).map((value) => ({
          name: "the DATABASE_URL password",
          value,
          inUrl: true,
        }))
      : []),
  ];
  return async () => {
    const generated = await readInstanceSetting(
      database.db,
      GENERATED_TOKEN_KEY,
    );
    return generated
      ? [...fixed, { name: "the generated API token", value: generated }]
      : fixed;
  };
}

/** The registered sandbox drivers. Docker stays registered without a daemon; its probe says so. */
export function sandboxDrivers(config: ServicesConfig): DriverEntry[] {
  return config.drivers.map((id): DriverEntry => {
    if (id === "local")
      return {
        // `env: {}`: the root comes from the settings, never from process.env.
        driver: new LocalSandboxDriver({ root: config.localRoot, env: {} }),
        label: "Local (unisolated)",
      };
    try {
      return {
        driver: new DockerSandboxDriver({
          namespace: config.dockerNamespace,
          allowInsecureTcp: config.dockerAllowInsecureTcp,
        }),
        label: "Docker",
      };
    } catch (error) {
      throw new ConfigError(
        `The docker sandbox driver cannot be configured: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });
}

async function open(config: ServicesConfig): Promise<Database> {
  const setting = config.database;
  try {
    return setting.mode === "pglite"
      ? await openDatabase({ mode: "pglite", path: setting.path })
      : await openDatabase({
          mode: "postgres",
          connectionString: setting.connectionString,
        });
  } catch (error) {
    const where =
      setting.mode === "pglite"
        ? `PGlite at ${setting.path}`
        : `PostgreSQL at ${redactUrl(setting.connectionString)}`;
    throw new Error(
      `Could not open the database (${where}): ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

/**
 * Opens the database (applying migrations), registers the drivers and models,
 * and builds the engine. The worker is not started. `env` is where the model
 * registry reads provider keys.
 */
export async function openServices(
  config: ServicesConfig,
  env: Env,
  logger: Logger = consoleLogger,
): Promise<Services> {
  const entries = sandboxDrivers(config);
  const database = await open(config);
  try {
    const drivers = createDriverRegistry(entries);
    const models = new ModelRegistry({
      env,
      enableScripted: config.enableScripted,
    });
    const secrets = serverSecrets(config, env, database, models);
    const outputCapBytes = config.engine.outputCapBytes;
    const engine = await createEngine({
      db: database,
      drivers,
      executor: new PiSessionExecutor({ models, outputCapBytes }),
      chat: new ChatResponder({ models, outputCapBytes }),
      models,
      config: config.engine,
      logger,
      secrets,
    });
    return { database, drivers, models, engine, secrets };
  } catch (error) {
    await database.close().catch(() => {});
    throw error;
  }
}
