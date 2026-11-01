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
import { type Database, openDatabase } from "@jj/db";
import { ChatResponder, ModelRegistry, PiSessionExecutor } from "@jj/runtime";
import { DockerSandboxDriver, LocalSandboxDriver } from "@jj/sandbox";
import {
  ConfigError,
  type Env,
  redactUrl,
  type ServicesConfig,
} from "./config";

export interface Services {
  database: Database;
  drivers: DriverRegistry;
  models: ModelRegistry;
  engine: Engine;
}

/** The registered sandbox drivers. Docker stays registered without a daemon; its probe says so. */
export function sandboxDrivers(config: ServicesConfig): DriverEntry[] {
  return config.drivers.map((id): DriverEntry => {
    if (id === "local")
      return {
        driver: new LocalSandboxDriver({ root: config.localRoot }),
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
    const outputCapBytes = config.engine.outputCapBytes;
    const engine = await createEngine({
      db: database,
      drivers,
      executor: new PiSessionExecutor({ models, outputCapBytes }),
      chat: new ChatResponder({ models, outputCapBytes }),
      models,
      config: config.engine,
      logger,
    });
    return { database, drivers, models, engine };
  } catch (error) {
    await database.close().catch(() => {});
    throw error;
  }
}
