import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

/** Open only when requested; callers own shutdown. Schema/migrations are the persistence task. */
export function createDatabase(connectionString: string) {
  if (!connectionString.trim())
    throw new Error("DATABASE_URL is required for persistence.");
  const pool = new Pool({ connectionString });
  return { db: drizzle(pool), close: () => pool.end() };
}
