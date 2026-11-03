// The data check (`npm run data:check`, and the restore check of
// `scripts/restore.sh`): prints what the configured database holds against
// this build, without migrating or writing anything. It reads DATABASE_URL or
// JJ_DATABASE_PATH, and JJ_SECRET_KEY and JJ_SECRET_KEY_PREVIOUS, as the
// server does. `--json` or `--env` (key=value lines) print it for scripts.
// Exits 1 when the database is newer than this build, which would refuse to
// start on it, or cannot be read, and 2 on a usage or setting error.
import { ConfigError, databaseSetting, secretKeys } from "./config";
import { formatEnv, formatReport, readDataReport } from "./data-report";

const USAGE =
  "Usage: node --import tsx apps/api/src/data-check.ts [--json | --env]";

const args = process.argv.slice(2);
if (
  args.some((arg) => arg !== "--json" && arg !== "--env") ||
  args.length > 1
) {
  console.error(USAGE);
  process.exit(2);
}

try {
  secretKeys(process.env);
  const report = await readDataReport(
    databaseSetting(process.env),
    process.env,
  );
  console.log(
    args[0] === "--json"
      ? JSON.stringify(report, null, 2)
      : args[0] === "--env"
        ? formatEnv(report)
        : formatReport(report),
  );
  process.exit(report.schema.state === "newer" ? 1 : 0);
} catch (error) {
  console.error(
    `Data check: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(error instanceof ConfigError ? 2 : 1);
}
