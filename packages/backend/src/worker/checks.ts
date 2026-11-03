// Evaluating one verification criterion: a command in the task's sandbox, an
// assertion on a workspace file, or one on the completion's result text.
// Pure but for the sandbox calls; the gate (gate.ts) records what it returns.
import {
  CHECK_DETAIL_LIMIT,
  CHECK_FILE_LIMIT_BYTES,
  type CheckOutcome,
  type VerificationCriterion,
  z,
} from "@jj/contracts";
import {
  resolveExecTimeoutMs,
  type Sandbox,
  type SandboxLimits,
} from "@jj/sandbox/contract";
import { errorMessage } from "../errors";

export interface CheckRun {
  outcome: CheckOutcome;
  exitCode: number | null;
  interrupted: "no" | "yes" | "unknown" | null;
  durationMs: number;
  /** What was observed, in a sentence or two. */
  detail: string;
  /** A command's combined output as kept (not yet redacted); null for other methods. */
  output: string | null;
}

export interface CheckEnv {
  sandbox: Sandbox;
  limits: Pick<SandboxLimits, "execTimeoutMs" | "maxOutputBytes">;
  signal: AbortSignal;
  /** The run's deadline: a check that cannot start before it is inconclusive. */
  deadline: Date;
  /** The result text passed to `complete_task`. */
  result: string;
  /** Applied to anything of the work a detail quotes. */
  redact: (text: string) => string;
}

const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`;

const clipLine = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
};

const isNamed = (error: unknown, name: string) =>
  error instanceof Error && error.name === name;

/** Keeps at most `maxBytes` of a command's output, in arrival order. */
function collector(maxBytes: number) {
  const chunks: Buffer[] = [];
  let kept = 0;
  let cut = false;
  return {
    onData(chunk: Buffer) {
      if (cut) return;
      const room = maxBytes - kept;
      if (chunk.length > room) {
        if (room > 0) chunks.push(chunk.subarray(0, room));
        kept = maxBytes;
        cut = true;
        return;
      }
      chunks.push(chunk);
      kept += chunk.length;
    },
    get bytes() {
      return kept;
    },
    get cut() {
      return cut;
    },
    text: () => Buffer.concat(chunks).toString("utf8"),
  };
}

async function runCommand(
  criterion: Extract<VerificationCriterion, { method: "command" }>,
  env: CheckEnv,
): Promise<CheckRun> {
  const started = Date.now();
  const remaining = env.deadline.getTime() - started;
  const base = { exitCode: null, interrupted: null, output: null };
  if (remaining <= 0)
    return {
      ...base,
      outcome: "inconclusive",
      durationMs: 0,
      detail:
        "Not run: the run's time budget ran out before this check could start.",
    };
  let timeoutMs = resolveExecTimeoutMs(
    env.limits,
    criterion.timeoutSeconds === undefined
      ? undefined
      : criterion.timeoutSeconds * 1000,
  );
  const byDeadline = remaining < timeoutMs;
  if (byDeadline) timeoutMs = Math.max(1, Math.floor(remaining));
  const output = collector(Math.max(1, env.limits.maxOutputBytes));
  let result: Awaited<ReturnType<Sandbox["exec"]>>;
  try {
    result = await env.sandbox.exec(criterion.command, {
      timeoutMs,
      signal: env.signal,
      onData: (chunk) => output.onData(chunk),
    });
  } catch (error) {
    return {
      ...base,
      outcome: "inconclusive",
      durationMs: Date.now() - started,
      detail: `The command could not run: ${env.redact(errorMessage(error))}`,
    };
  }
  let text =
    output.bytes > 0
      ? output.text()
      : [result.stdout, result.stderr].filter(Boolean).join("\n");
  if (output.cut || result.truncated)
    text += `\n[Output cut at ${Math.floor(env.limits.maxOutputBytes / 1024)} KiB, the sandbox's output limit.]`;
  const run = {
    exitCode: result.exitCode,
    interrupted: result.interrupted,
    durationMs: result.durationMs || Date.now() - started,
    output: text,
  };
  const took = seconds(run.durationMs);
  if (result.interruptReason === "timeout")
    return byDeadline
      ? {
          ...run,
          outcome: "inconclusive",
          detail: `Stopped after ${took}: the run's time budget ran out.`,
        }
      : {
          ...run,
          outcome: "failed",
          detail: `Timed out after ${seconds(timeoutMs)}.`,
        };
  if (result.interrupted !== "no")
    return {
      ...run,
      outcome: "inconclusive",
      detail:
        result.interruptReason === "release"
          ? "Stopped: the task's sandbox was released."
          : result.interruptReason === "abort"
            ? "Stopped: the run was stopped."
            : `Interrupted (${result.interruptReason ?? "unknown reason"}); its outcome is unknown.`,
    };
  return result.exitCode === 0
    ? { ...run, outcome: "passed", detail: `Exited with code 0 in ${took}.` }
    : {
        ...run,
        outcome: "failed",
        detail: `Exited with code ${result.exitCode} in ${took}.`,
      };
}

type Assertion = Extract<VerificationCriterion, { method: "file" | "result" }>;

/** Line number (1-based) of a character offset. */
const lineOf = (text: string, index: number) =>
  text.slice(0, index).split("\n").length;

/** Checks `text` against a `contains`, `matches` or `json` assertion. */
export function assertText(
  text: string,
  criterion: Assertion,
  subject: string,
  redact: (text: string) => string = (value) => value,
): { outcome: CheckOutcome; detail: string } {
  switch (criterion.expect) {
    case "contains": {
      const value = criterion.value ?? "";
      const index = text.indexOf(value);
      return index >= 0
        ? {
            outcome: "passed",
            detail: `${subject} contains ${JSON.stringify(value)} (line ${lineOf(text, index)}).`,
          }
        : {
            outcome: "failed",
            detail: `${subject} does not contain ${JSON.stringify(value)}.`,
          };
    }
    case "matches": {
      let pattern: RegExp;
      try {
        pattern = new RegExp(criterion.value ?? "", criterion.flags);
      } catch (error) {
        return {
          outcome: "inconclusive",
          detail: `The regular expression does not compile: ${errorMessage(error)}`,
        };
      }
      const match = pattern.exec(text);
      return match
        ? {
            outcome: "passed",
            detail: `${subject} matches /${pattern.source}/${pattern.flags} at line ${lineOf(text, match.index)}: ${JSON.stringify(clipLine(redact(match[0]), 120))}.`,
          }
        : {
            outcome: "failed",
            detail: `${subject} does not match /${pattern.source}/${pattern.flags}.`,
          };
    }
    case "json": {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch (error) {
        return {
          outcome: "failed",
          detail: `${subject} is not valid JSON: ${errorMessage(error)}`,
        };
      }
      if (!criterion.schema)
        return { outcome: "passed", detail: `${subject} is valid JSON.` };
      let schema: z.ZodType;
      try {
        schema = z.fromJSONSchema(criterion.schema as never);
      } catch (error) {
        return {
          outcome: "inconclusive",
          detail: `The JSON Schema cannot be checked: ${errorMessage(error)}`,
        };
      }
      const parsed = schema.safeParse(value);
      if (parsed.success)
        return {
          outcome: "passed",
          detail: `${subject} is JSON valid against the schema.`,
        };
      const issues = parsed.error.issues;
      return {
        outcome: "failed",
        detail: `${subject} does not match the JSON Schema (${issues.length} issue${issues.length === 1 ? "" : "s"}): ${issues
          .slice(0, 5)
          .map(
            (issue) =>
              `${issue.path.length ? `/${issue.path.join("/")}` : "(root)"}: ${issue.message}`,
          )
          .join("; ")}`,
      };
    }
    case "exists":
      return { outcome: "passed", detail: `${subject} exists.` };
  }
}

async function checkFile(
  criterion: Extract<VerificationCriterion, { method: "file" }>,
  env: CheckEnv,
): Promise<{ outcome: CheckOutcome; detail: string }> {
  const subject = `\`${criterion.path}\``;
  let stat: Awaited<ReturnType<Sandbox["fs"]["stat"]>>;
  try {
    stat = await env.sandbox.fs.stat(criterion.path);
  } catch (error) {
    if (isNamed(error, "SandboxPathError"))
      return {
        outcome: "failed",
        detail: `${subject} leads outside the workspace.`,
      };
    return {
      outcome: "inconclusive",
      detail: `${subject} could not be read: ${env.redact(errorMessage(error))}`,
    };
  }
  if (!stat) return { outcome: "failed", detail: `${subject} does not exist.` };
  if (criterion.expect === "exists")
    return {
      outcome: "passed",
      detail: `${subject} exists (${stat.kind === "file" ? `a file of ${stat.size} bytes` : `a ${stat.kind}`}).`,
    };
  if (stat.kind !== "file")
    return {
      outcome: "failed",
      detail: `${subject} is a ${stat.kind}, not a file.`,
    };
  if (stat.size > CHECK_FILE_LIMIT_BYTES)
    return {
      outcome: "inconclusive",
      detail: `${subject} is ${stat.size} bytes, more than the ${CHECK_FILE_LIMIT_BYTES / (1024 * 1024)} MiB a check reads.`,
    };
  let content: Buffer;
  try {
    content = await env.sandbox.fs.read(criterion.path);
  } catch (error) {
    return {
      outcome: "inconclusive",
      detail: `${subject} could not be read: ${env.redact(errorMessage(error))}`,
    };
  }
  if (content.byteLength > CHECK_FILE_LIMIT_BYTES)
    return {
      outcome: "inconclusive",
      detail: `${subject} is ${content.byteLength} bytes, more than the ${CHECK_FILE_LIMIT_BYTES / (1024 * 1024)} MiB a check reads.`,
    };
  return assertText(content.toString("utf8"), criterion, subject, env.redact);
}

/** Runs one criterion. Never throws: a check that cannot be evaluated is inconclusive. */
export async function runCheck(
  criterion: VerificationCriterion,
  env: CheckEnv,
): Promise<CheckRun> {
  if (criterion.method === "command") return runCommand(criterion, env);
  const started = Date.now();
  const base = { exitCode: null, interrupted: null, output: null };
  try {
    const judged =
      criterion.method === "file"
        ? await checkFile(criterion, env)
        : assertText(env.result, criterion, "The result", env.redact);
    return { ...base, ...judged, durationMs: Date.now() - started };
  } catch (error) {
    return {
      ...base,
      outcome: "inconclusive",
      durationMs: Date.now() - started,
      detail: `The check could not be evaluated: ${env.redact(errorMessage(error))}`,
    };
  }
}

/** `detail` within the record's limit. */
export const clipDetail = (detail: string) =>
  detail.length <= CHECK_DETAIL_LIMIT
    ? detail
    : `${detail.slice(0, CHECK_DETAIL_LIMIT - 1)}…`;

const encoder = new TextEncoder();
const byteLength = (text: string) => encoder.encode(text).length;

/** The longest start (or end) of `text` within `bytes` UTF-8 bytes, never splitting a character. */
function fitBytes(text: string, bytes: number, from: "start" | "end"): string {
  if (bytes <= 0) return "";
  if (byteLength(text) <= bytes) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const slice =
      from === "start" ? text.slice(0, mid) : text.slice(text.length - mid);
    if (byteLength(slice) <= bytes) low = mid;
    else high = mid - 1;
  }
  const slice =
    from === "start" ? text.slice(0, low) : text.slice(text.length - low);
  return slice.replace(
    from === "start" ? /[\uD800-\uDBFF]$/ : /^[\uDC00-\uDFFF]/,
    "",
  );
}

/** `text` within `bytes`: whole, or its head and tail around a marker. */
export function headAndTail(
  text: string,
  bytes: number,
): { text: string; truncated: boolean } {
  const total = byteLength(text);
  if (total <= bytes) return { text, truncated: false };
  const marker = `\n[… ${total} bytes in total; the middle is left out …]\n`;
  const room = Math.max(0, bytes - byteLength(marker));
  const head = fitBytes(text, Math.floor(room / 2), "start");
  const tail = fitBytes(text, room - byteLength(head), "end");
  return { text: `${head}${marker}${tail}`, truncated: true };
}

/** The end of `text` within `bytes`, starting on a whole line when it can. */
export function tailOf(text: string, bytes: number): string {
  const trimmed = text.replace(/\s+$/, "");
  if (byteLength(trimmed) <= bytes) return trimmed;
  const tail = fitBytes(trimmed, bytes, "end");
  const newline = tail.indexOf("\n");
  return newline >= 0 && newline < tail.length - 1
    ? tail.slice(newline + 1)
    : tail;
}
