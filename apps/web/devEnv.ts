/**
 * Where the dev server finds the API. `.env` lives at the repository root,
 * where the API reads it, so it is loaded from there whatever the working
 * directory (`npm run dev -w @jj/web` runs in apps/web).
 */
import { fileURLToPath } from "node:url";
import { loadEnv } from "vite";

export const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** `API_PORT` from the environment, else the root `.env` files; default 3001. */
export function apiTarget(mode: string, root: string = REPO_ROOT): string {
  const env = loadEnv(mode, root, "");
  return `http://127.0.0.1:${env.API_PORT || "3001"}`;
}
