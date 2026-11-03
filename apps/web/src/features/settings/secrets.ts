import type { RuntimeProfile, StoredSecret } from "@jj/contracts";
import { formatMessageTime } from "../../lib/format";

/**
 * Presentation helpers for stored keys and sandbox secrets. Values are
 * write-only: the server answers with their last four characters, never the
 * value, and the inputs that send one are cleared once it is stored.
 */

/** The one line that turns the secrets store on, run where the server's .env is. */
export const ENABLE_STORE_COMMAND =
  'echo "JJ_SECRET_KEY=$(openssl rand -base64 32)" >> .env';

/** "ends in 3xYz · set 14:20": what settings shows in place of a value. */
export function storedLabel(stored: StoredSecret): string {
  const when = formatMessageTime(stored.updatedAt);
  return `ends in ${stored.hint}${when ? ` · set ${when}` : ""}`;
}

/** Why a stored value is not used, for the "unreadable" state. */
export function unreadableText(storeAvailable: boolean): string {
  return storeAvailable
    ? "The server's current JJ_SECRET_KEY cannot decrypt it, so it is not used. Store it again, or remove it."
    : "JJ_SECRET_KEY is not set on the server, so it cannot be read or used. Set the key it was stored with, or remove it.";
}

/** The profiles that grant a secret, by name. */
export function grantingProfiles(
  name: string,
  profiles: readonly RuntimeProfile[],
): RuntimeProfile[] {
  return profiles.filter((profile) => profile.secrets.includes(name));
}

/** A server refusal as the settings banners show it. */
export interface ServerError {
  code: string;
  message: string;
}
