// The server's log: one JSON object per line (or a readable line with
// `JJ_LOG_FORMAT=pretty`), filtered by `JJ_LOG_LEVEL`, every line carrying
// the ids of the request, task, session and run it was written from, and
// redacted with the engine's redactor like every stored record, so no
// provider key, API token or stored secret reaches it. Hand-written: the
// redaction is a function over free text, not a list of field paths, and a
// line is small enough that a dependency would buy nothing.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { Redactor } from "../redact";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
export const LOG_FORMATS = ["json", "pretty"] as const;
export type LogFormat = (typeof LOG_FORMATS)[number];

export interface Logger {
  /** Optional: loggers that drop debug lines may leave it out. */
  debug?(message: string, details?: unknown): void;
  info(message: string, details?: unknown): void;
  warn(message: string, details?: unknown): void;
  error(message: string, details?: unknown): void;
  /**
   * Redact lines from now on with `redactor`. The engine calls it whenever
   * it builds a redactor, so stored secrets added later are covered too.
   */
  redactWith?(redactor: Redactor): void;
  /**
   * Writes `message` at info, whatever the level, leaving `value` in it: the
   * one line that hands the user a generated API token. Everything else in it
   * is still redacted.
   */
  reveal?(message: string, value: string): void;
}

/** The ids a line carries from the request, job or run it was written in. */
export interface LogFields {
  requestId?: string;
  jobId?: string;
  botId?: string;
  taskId?: string;
  sessionId?: string;
  runId?: string;
}

const FIELD_ORDER: readonly (keyof LogFields)[] = [
  "requestId",
  "jobId",
  "botId",
  "taskId",
  "sessionId",
  "runId",
];

const scope = new AsyncLocalStorage<LogFields>();

/**
 * Runs `fn` with `fields` added to every line it (and what it awaits) logs,
 * on top of the current scope's, or alone with `fresh`: a job or request
 * starts its own scope, whatever context happened to start it (a wake
 * delivered inside another job's write, say).
 */
export function withLogFields<T>(
  fields: LogFields,
  fn: () => T,
  fresh = false,
): T {
  const merged: LogFields = fresh ? {} : { ...scope.getStore() };
  for (const key of FIELD_ORDER) {
    const value = fields[key];
    if (value) merged[key] = value;
  }
  return scope.run(merged, fn);
}

/** The ids of the current scope. */
export const logFields = (): LogFields => scope.getStore() ?? {};

export interface LogSettings {
  level: LogLevel;
  format: LogFormat;
}

/**
 * `JJ_LOG_LEVEL` (default `info`) and `JJ_LOG_FORMAT` (default `json`).
 * Throws naming the variable when a value is not one of them; `lenient`
 * falls back to the default instead.
 */
export function logSettings(
  env: Readonly<Record<string, string | undefined>>,
  lenient = false,
): LogSettings {
  const pick = <T extends string>(
    name: string,
    allowed: readonly T[],
    fallback: T,
  ): T => {
    const value = env[name]?.trim().toLowerCase();
    if (!value) return fallback;
    if ((allowed as readonly string[]).includes(value)) return value as T;
    if (lenient) return fallback;
    throw new Error(
      `${name} must be one of ${allowed.join(", ")}; got "${env[name]?.trim()}".`,
    );
  };
  return {
    level: pick("JJ_LOG_LEVEL", LOG_LEVELS, "info"),
    format: pick("JJ_LOG_FORMAT", LOG_FORMATS, "json"),
  };
}

export interface LoggerOptions extends Partial<LogSettings> {
  /** Where a line goes. Default: stdout for debug and info, stderr for warn and error. */
  write?: (line: string, level: LogLevel) => void;
  clock?: () => Date;
}

/** A logger that writes lines, as `createLogger` makes it. */
export type StructuredLogger = Required<Logger> & {
  readonly level: LogLevel;
  readonly format: LogFormat;
};

const RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const defaultWrite = (line: string, level: LogLevel) => {
  (level === "warn" || level === "error"
    ? process.stderr
    : process.stdout
  ).write(`${line}\n`);
};

/** Errors as their name, message and stack; everything else as JSON would carry it. */
function plain(value: unknown): unknown {
  try {
    const text = JSON.stringify(value, (_key, item: unknown) => {
      if (item instanceof Error)
        return {
          name: item.name,
          message: item.message,
          ...(item.stack ? { stack: item.stack } : {}),
          ...((item as { code?: unknown }).code !== undefined
            ? { code: (item as { code?: unknown }).code }
            : {}),
        };
      if (typeof item === "bigint") return item.toString();
      return item;
    });
    return text === undefined ? undefined : JSON.parse(text);
  } catch {
    return String(value);
  }
}

/** A call's details as the line's own fields. */
function detailFields(details: unknown): Record<string, unknown> {
  if (details === undefined) return {};
  const value = plain(details);
  if (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(details instanceof Error)
  )
    return value as Record<string, unknown>;
  return details instanceof Error ? { error: value } : { details: value };
}

/** Every string of plain JSON data redacted, object keys included. */
function redactAll(value: unknown, redact: Redactor): unknown {
  if (typeof value === "string") return redact(value);
  if (Array.isArray(value)) return value.map((item) => redactAll(item, redact));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redact(key),
        redactAll(item, redact),
      ]),
    );
  return value;
}

const RESERVED = new Set(["time", "level", "msg"]);

function prettyValue(value: unknown): string {
  if (typeof value === "string")
    return /^[^\s"=]+$/.test(value) ? value : JSON.stringify(value);
  return JSON.stringify(value) ?? String(value);
}

/** Stands in for a revealed value while the line is redacted: no secret holds it. */
const REVEALED = `jj-revealed-${randomUUID()}`;

export function createLogger(options: LoggerOptions = {}): StructuredLogger {
  const level = options.level ?? "info";
  const format = options.format ?? "json";
  const write = options.write ?? defaultWrite;
  const clock = options.clock ?? (() => new Date());
  let redact: Redactor = <Value>(value: Value) => value;

  const line = (at: LogLevel, message: string, details?: unknown) => {
    const fields: Record<string, unknown> = {};
    const ids = logFields();
    for (const key of FIELD_ORDER) if (ids[key]) fields[key] = ids[key];
    for (const [key, value] of Object.entries(detailFields(details)))
      fields[RESERVED.has(key) ? `${key}_` : key] = value;
    const safe = redactAll(fields, redact) as Record<string, unknown>;
    const time = clock().toISOString();
    if (format === "json")
      return JSON.stringify({ time, level: at, msg: message, ...safe });
    const rest = Object.entries(safe)
      .map(([key, value]) => ` ${key}=${prettyValue(value)}`)
      .join("");
    return `${time} ${at.toUpperCase().padEnd(5)} ${message}${rest}`;
  };

  const log =
    (at: LogLevel) =>
    (message: string, details?: unknown): void => {
      if (RANK[at] < RANK[level]) return;
      write(line(at, redact(message), details), at);
    };

  return {
    level,
    format,
    debug: log("debug"),
    info: log("info"),
    warn: log("warn"),
    error: log("error"),
    redactWith(redactor) {
      redact = redactor;
    },
    reveal(message, value) {
      const masked = value ? message.split(value).join(REVEALED) : message;
      const text = line("info", redact(masked));
      const shown =
        format === "json" ? JSON.stringify(value).slice(1, -1) : value;
      write(value ? text.split(REVEALED).join(shown) : text, "info");
    },
  };
}
