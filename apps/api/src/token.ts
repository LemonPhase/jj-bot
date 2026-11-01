// The bearer token the API requires. API_TOKEN when it is set. Otherwise a
// listener beyond loopback gets a token generated on its first boot and kept
// in the database (`instance_settings`), so restarts keep it; the startup
// line that opens the app is the only place its value is printed. Loopback
// without API_TOKEN stays unauthenticated.
import { randomBytes } from "node:crypto";
import { type Executor, instanceSetting } from "@jj/db";
import { isLoopbackHost, type ServerConfig } from "./config";

/** The instance setting that holds the generated token. */
export const GENERATED_TOKEN_KEY = "api_token";

export type ApiAuth =
  | { kind: "configured"; token: string }
  | { kind: "generated"; token: string; created: boolean }
  | { kind: "none" };

/** 32 random bytes, base64url: URL-safe, so it can travel as `?token=`. */
export const generateApiToken = () => randomBytes(32).toString("base64url");

export async function resolveApiToken(
  config: Pick<ServerConfig, "apiToken" | "host">,
  db: Executor,
): Promise<ApiAuth> {
  if (config.apiToken) return { kind: "configured", token: config.apiToken };
  if (isLoopbackHost(config.host)) return { kind: "none" };
  const { value, created } = await instanceSetting(
    db,
    GENERATED_TOKEN_KEY,
    generateApiToken,
  );
  return { kind: "generated", token: value, created };
}

/** The startup line's auth part. Never carries the token's value. */
export function describeAuth(auth: ApiAuth): string {
  switch (auth.kind) {
    case "configured":
      return "bearer token (API_TOKEN)";
    case "generated":
      return `bearer token (${auth.created ? "generated now" : "generated on first boot"}, kept in the database)`;
    default:
      return "none (loopback only)";
  }
}
