// Redaction of the server's secret values (provider keys, the API token, the
// database password) from what the engine persists out of a run: events,
// transcript entries, spilled output, outcomes and collaboration tool calls.
// On an unisolated driver a command can print them (`cat .env`); they must
// not reach the task history. Files in the workspace are the user's and are
// stored as they are.

export const REDACTED = "[redacted]";

/** Shorter values are not treated as secrets: they occur by chance too often. */
const MIN_SECRET_LENGTH = 6;

/** Returns a copy of `value` with every secret in its strings replaced. */
export type Redactor = <Value>(value: Value) => Value;

export function createRedactor(
  secrets: () => Iterable<string | undefined>,
): Redactor {
  return <Value>(value: Value): Value => {
    const list = [...new Set(secrets())]
      .filter(
        (secret): secret is string =>
          typeof secret === "string" && secret.length >= MIN_SECRET_LENGTH,
      )
      // Longest first, so a secret containing another is replaced whole.
      .sort((a, b) => b.length - a.length);
    return list.length === 0 ? value : (redactDeep(value, list) as Value);
  };
}

function redactText(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets)
    if (out.includes(secret)) out = out.split(secret).join(REDACTED);
  return out;
}

function redactDeep(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") return redactText(value, secrets);
  if (Array.isArray(value))
    return value.map((item) => redactDeep(item, secrets));
  if (
    value !== null &&
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype
  )
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactDeep(item, secrets),
      ]),
    );
  return value;
}
