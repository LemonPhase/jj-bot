// The bearer token the API requires. API_TOKEN when it is set. Otherwise a
// listener beyond loopback, or a password (JJ_PASSWORD_HASH), gets a token
// generated on its first boot and kept in the database (`instance_settings`),
// so restarts keep it; Settings → Security replaces it. It is never printed:
// `npm run auth:token` reads it, and the boot line carries a one-time login
// link instead (auth/). Loopback without a token or a password stays
// unauthenticated.
import { randomBytes } from "node:crypto";
import { type Executor, instanceSetting } from "@jj/db";
import { type ServerConfig, servesWithoutToken } from "./config";

/** The instance setting that holds the generated token. */
export const GENERATED_TOKEN_KEY = "api_token";

export type ApiAuth =
  | { kind: "configured"; token: string }
  | { kind: "generated"; token: string; created: boolean }
  | { kind: "none" };

/** 32 random bytes, base64url. */
export const generateApiToken = () => randomBytes(32).toString("base64url");

export async function resolveApiToken(
  config: Pick<ServerConfig, "apiToken" | "host" | "password">,
  db: Executor,
): Promise<ApiAuth> {
  if (config.apiToken) return { kind: "configured", token: config.apiToken };
  if (servesWithoutToken(config)) return { kind: "none" };
  const { value, created } = await instanceSetting(
    db,
    GENERATED_TOKEN_KEY,
    generateApiToken,
  );
  return { kind: "generated", token: value, created };
}

/** The startup line's auth part. Never carries a credential. */
export function describeAuth(auth: ApiAuth, password: boolean): string {
  const withPassword = password ? " or password" : "";
  switch (auth.kind) {
    case "configured":
      return `sign-in with the token (API_TOKEN)${withPassword}`;
    case "generated":
      return `sign-in with the token (${auth.created ? "generated now" : "generated on first boot"}, kept in the database)${withPassword}`;
    default:
      return "none (loopback only)";
  }
}
