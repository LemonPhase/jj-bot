// Redaction of the server's secret values (provider keys, the API token, the
// database password) from what the engine persists out of a run: events,
// transcript entries, spilled output, outcomes and the texts collaboration
// tools store. On an unisolated driver a command can print them
// (`cat .env`); they must not reach the task history. The runtime applies
// the same function before it cuts text, so no fragment survives a cap.
// Files in the workspace are the user's and are stored as they are.

export const REDACTED = "[redacted]";

/**
 * Shorter values are not redacted where they appear on their own: a short
 * value is too likely to be an ordinary word ("postgres"), and replacing it
 * would rewrite briefs, messages and the model's own history.
 */
export const MIN_BARE_SECRET_LENGTH = 16;

export interface Secret {
  /** What it is, for warnings ("OPENAI_API_KEY"). Never the value. */
  name: string;
  value: string;
  /**
   * Only where it appears as a URL password (`:<value>@`), never as a bare
   * word: database passwords are often short, common words.
   */
  inUrl?: boolean;
}

/** Returns a copy of `value` with every secret in its strings replaced. */
export type Redactor = <Value>(value: Value) => Value;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The secrets that cannot be redacted safely, by name, for a boot warning. */
export function tooShortToRedact(secrets: readonly Secret[]): string[] {
  return [
    ...new Set(
      secrets
        .filter(
          (secret) =>
            !secret.inUrl &&
            secret.value.length > 0 &&
            secret.value.length < MIN_BARE_SECRET_LENGTH,
        )
        .map((secret) => secret.name),
    ),
  ];
}

export function createRedactor(secrets: readonly Secret[]): Redactor {
  const bare = [
    ...new Set(
      secrets
        .filter(
          (secret) =>
            !secret.inUrl && secret.value.length >= MIN_BARE_SECRET_LENGTH,
        )
        .map((secret) => secret.value),
    ),
  ]
    // Longest first, so a secret containing another is replaced whole.
    .sort((a, b) => b.length - a.length);
  const inUrl = [
    ...new Set(
      secrets
        .filter((secret) => secret.inUrl && secret.value.length > 0)
        .map((secret) => secret.value),
    ),
  ];
  const urlPattern =
    inUrl.length > 0
      ? new RegExp(
          `:(?:${inUrl
            .sort((a, b) => b.length - a.length)
            .map(escape)
            .join("|")})@`,
          "g",
        )
      : undefined;
  if (bare.length === 0 && !urlPattern) return <Value>(value: Value) => value;
  const text = (input: string) => {
    let out = input;
    for (const secret of bare)
      if (out.includes(secret)) out = out.split(secret).join(REDACTED);
    if (urlPattern && out.includes("@"))
      out = out.replace(urlPattern, `:${REDACTED}@`);
    return out;
  };
  return <Value>(value: Value): Value => redactDeep(value, text) as Value;
}

function redactDeep(value: unknown, text: (input: string) => string): unknown {
  if (typeof value === "string") return text(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, text));
  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redactDeep(item, text)]),
    );
  return value;
}
