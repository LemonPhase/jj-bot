import { defineConfig } from "drizzle-kit";

// `npm run db:generate -w @jj/db` diffs src/schema.ts against the last
// snapshot in migrations/meta and writes the next SQL migration. Commit the
// output; openDatabase applies it on boot.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema.ts",
  out: "./migrations",
});
