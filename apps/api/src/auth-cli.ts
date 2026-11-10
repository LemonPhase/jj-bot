// Sign-in helpers for the operator, reading the same settings as the server
// (DATABASE_URL or JJ_DATABASE_PATH, API_TOKEN, API_PUBLIC_URL, ...):
//
//   npm run auth:hash-password   a JJ_PASSWORD_HASH for a password typed twice
//                                (or piped in on stdin)
//   npm run auth:login-link      a new one-time login link (15 minutes)
//   npm run auth:token           the access token, alone on stdout, for scripts
//
// In the app image: `docker compose exec app jj-auth <command>`. PGlite takes
// one process, so with the server running on it, login-link and token need it
// stopped; PostgreSQL has no such limit. Exits 2 on a usage or setting error.
import { DatabaseInUseError, openDatabase } from "@jj/db";
import { loginLink } from "./auth/link";
import {
  hashPassword,
  MIN_PASSWORD_LENGTH,
  parsePasswordHash,
  verifyPassword,
} from "./auth/password";
import { AuthStore } from "./auth/store";
import { ConfigError, loadServerConfig, type ServerConfig } from "./config";
import { resolveApiToken } from "./token";

const USAGE =
  "Usage: node --import tsx apps/api/src/auth-cli.ts <hash-password | login-link | token>";

class UsageError extends Error {}

/** A line from the terminal without echoing it, or all of stdin when it is piped. */
async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    let text = "";
    for await (const chunk of stdin) text += chunk;
    return text.replace(/\r?\n$/, "");
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding("utf8");
  try {
    return await new Promise<string>((resolve, reject) => {
      let value = "";
      const onData = (chunk: string) => {
        for (const char of chunk) {
          if (char === "\r" || char === "\n") {
            stdin.off("data", onData);
            process.stderr.write("\n");
            return resolve(value);
          }
          if (char === "\u0003") {
            stdin.off("data", onData);
            process.stderr.write("\n");
            return reject(new UsageError("Cancelled."));
          }
          if (char === "\u007f" || char === "\b") value = value.slice(0, -1);
          else if (char >= " ") value += char;
        }
      };
      stdin.on("data", onData);
    });
  } finally {
    stdin.setRawMode(false);
    stdin.pause();
  }
}

async function hashPasswordCommand() {
  const password = await readSecret("Password: ");
  if ([...password].length < MIN_PASSWORD_LENGTH)
    throw new UsageError(
      `Use a password of at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  if (process.stdin.isTTY) {
    const again = await readSecret("The same password again: ");
    if (again !== password) throw new UsageError("The passwords differ.");
  }
  const hash = await hashPassword(password);
  // A check of the output, so a hash that does not verify is never printed.
  if (!(await verifyPassword(parsePasswordHash(hash), password)))
    throw new Error("The new hash did not verify.");
  process.stderr.write(
    "Set this in the server's environment (or .env) and restart it; every device signs in again:\n",
  );
  console.log(`JJ_PASSWORD_HASH=${hash}`);
}

async function withDatabase<T>(
  config: ServerConfig,
  use: (db: Awaited<ReturnType<typeof openDatabase>>) => Promise<T>,
): Promise<T> {
  const setting = config.database;
  if (setting.mode === "pglite" && setting.path === "memory://")
    throw new UsageError(
      "JJ_DATABASE_PATH is memory://: that database lives only inside the server process.",
    );
  let database: Awaited<ReturnType<typeof openDatabase>>;
  try {
    database =
      setting.mode === "pglite"
        ? await openDatabase({ mode: "pglite", path: setting.path })
        : await openDatabase({
            mode: "postgres",
            connectionString: setting.connectionString,
          });
  } catch (error) {
    if (error instanceof DatabaseInUseError)
      throw new UsageError(
        `The server is running on the PGlite database at ${error.directory}, which only one process can open. Stop it first, or use the link its boot printed (each boot prints a new one). With PostgreSQL this works while the server runs.`,
      );
    throw error;
  }
  try {
    return await use(database);
  } finally {
    await database.close();
  }
}

async function main(command: string | undefined) {
  if (command === "hash-password") return hashPasswordCommand();
  if (command !== "login-link" && command !== "token")
    throw new UsageError(USAGE);
  const config = loadServerConfig(process.env);
  await withDatabase(config, async ({ db }) => {
    const auth = await resolveApiToken(config, db);
    if (auth.kind === "none")
      throw new UsageError(
        "This server asks for no sign-in: on loopback without API_TOKEN or JJ_PASSWORD_HASH it answers only this machine, without a token.",
      );
    if (command === "token") {
      console.log(auth.token);
      return;
    }
    const code = await new AuthStore(db).createLoginCode();
    const base = config.publicUrl ?? `http://127.0.0.1:${config.port || 3001}`;
    process.stderr.write("Open this within 15 minutes; it signs in once:\n");
    console.log(loginLink(base, code));
  });
}

try {
  await main(process.argv[2]);
  process.exit(0);
} catch (error) {
  console.error(
    `JJ Bot auth: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(
    error instanceof UsageError || error instanceof ConfigError ? 2 : 1,
  );
}
