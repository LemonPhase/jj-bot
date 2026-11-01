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
  /**
   * The server's secret values the engine redacts from what runs persist.
   * The API adds a token it generates after opening the services.
   */
  secrets: Set<string>;
}

/** The database password from a PostgreSQL URL, as written and decoded. */
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
 * Secret values known when the services open: the provider keys in `env`,
 * `API_TOKEN`, a token generated on an earlier boot, and the database password.
 */
async function knownSecrets(
  config: ServicesConfig,
  env: Env,
  database: Database,
  models: ModelRegistry,
): Promise<Set<string>> {
  const values = [
    ...models.secretValues(),
    env.API_TOKEN?.trim(),
    await readInstanceSetting(database.db, GENERATED_TOKEN_KEY),
    ...(config.database.mode === "postgres"
      ? databasePassword(config.database.connectionString)
      : []),
  ];
  return new Set(values.filter((value): value is string => Boolean(value)));
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
    const secrets = await knownSecrets(config, env, database, models);
    const outputCapBytes = config.engine.outputCapBytes;
    const engine = await createEngine({
      db: database,
      drivers,
      executor: new PiSessionExecutor({ models, outputCapBytes }),
      chat: new ChatResponder({ models, outputCapBytes }),
      models,
      config: config.engine,
      logger,
      secrets: () => secrets,
    });
    return { database, drivers, models, engine, secrets };
  } catch (error) {
    await database.close().catch(() => {});
    throw error;
  }
}
