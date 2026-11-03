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
import type { CutEdges } from "../redact";
import { ISOLATED_TIME_LIMIT_MS, runIsolated } from "./isolated";
import { jsonErrorOffset } from "./json-syntax";

export interface CheckRun {
  outcome: CheckOutcome;
  exitCode: number | null;
  interrupted: "no" | "yes" | "unknown" | null;
  durationMs: number;
  /** What was observed, in a sentence or two. */
  detail: string;
  /**
   * A command's combined output as kept, redacted where it was cut (see
   * `headTailCollector`); null for other methods. The gate redacts it whole.
   */
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
  /**
   * Applied to anything of the work a detail quotes, and to command output
   * with `cut` naming the edges where the output limit cut it.
   */
  redact: (text: string, cut?: CutEdges) => string;
}

const seconds = (ms: number) =>
  ms < 1000 ? `${Math.round(ms)} ms` : `${Math.round(ms / 100) / 10} s`;

const clipLine = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
};

const isNamed = (error: unknown, name: string) =>
  error instanceof Error && error.name === name;

/**
 * Keeps at most `maxBytes` of a command's output: its head and, once it runs
 * over, a rolling tail, so the end of the output (where test runners print
 * their failures) is always kept. `text(redact, stopped)` redacts what it
 * kept: a cut ends the head and starts the tail, and a command stopped
 * (timed out or aborted) ends where it was killed, perhaps inside a secret,
 * so those edges are named to `redact`, which masks what is left of one there.
 */
export function headTailCollector(maxBytes: number) {
  const headMax = Math.ceil(maxBytes / 2);
  const tailMax = maxBytes - headMax;
  const head: Buffer[] = [];
  let headBytes = 0;
  let tail: Buffer[] = [];
  let tailBytes = 0;
  let total = 0;
  return {
    onData(chunk: Buffer) {
      total += chunk.length;
      let rest = chunk;
      if (headBytes < headMax) {
        const taken = rest.subarray(0, headMax - headBytes);
        head.push(taken);
        headBytes += taken.length;
        rest = rest.subarray(taken.length);
      }
      if (rest.length === 0 || tailMax === 0) return;
      tail.push(rest);
      tailBytes += rest.length;
      while (tailBytes > tailMax && tail.length > 0) {
        const first = tail[0] as Buffer;
        const over = tailBytes - tailMax;
        if (first.length <= over) {
          tail.shift();
          tailBytes -= first.length;
        } else {
          tail[0] = first.subarray(over);
          tailBytes -= over;
        }
      }
    },
    get bytes() {
      return total;
    },
    /** True when the middle of the output was left out. */
    get cut() {
      return total > headBytes + tailBytes;
    },
    text(
      redact: (text: string, cut?: CutEdges) => string = (value) => value,
      stopped = false,
    ) {
      const start = Buffer.concat(head).toString("utf8");
      const end = Buffer.concat(tail).toString("utf8");
      const omitted = total - headBytes - tailBytes;
      return omitted > 0
        ? `${redact(start, { end: true })}\n[… ${omitted} bytes of output left out: the sandbox keeps ${Math.floor(maxBytes / 1024)} KiB, its head and its tail …]\n${redact(end, { start: true, end: stopped })}`
        : redact(`${start}${end}`, stopped ? { end: true } : undefined);
    },
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
  const output = headTailCollector(Math.max(2, env.limits.maxOutputBytes));
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
  // Output of a command stopped mid-way ends where it was killed; from a
  // driver that never calls onData, it may also end where the driver's own
  // output limit cut it.
  const stopped = result.interrupted !== "no";
  const cut = result.truncated || stopped ? { end: true } : undefined;
  let text =
    output.bytes > 0
      ? output.text(env.redact, stopped)
      : [result.stdout, result.stderr]
          .map((part) => env.redact(part, cut))
          .filter(Boolean)
          .join("\n");
  if (output.bytes === 0 && result.truncated)
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

/** Column number (1-based) of a character offset on its line. */
const columnOf = (text: string, index: number) =>
  index - text.lastIndexOf("\n", index - 1);

/**
 * Why `text` is not JSON, by position only: the message of `JSON.parse`
 * quotes the text around the error, a cut of the file that may go through
 * a secret, which redaction cannot mask once it is cut.
 */
function invalidJson(text: string, subject: string): string {
  const offset = jsonErrorOffset(text);
  if (offset === undefined) return `${subject} is not valid JSON.`;
  const where = `line ${lineOf(text, offset)}, column ${columnOf(text, offset)}`;
  return offset >= text.length
    ? `${subject} is not valid JSON: it ends early, at ${where}.`
    : `${subject} is not valid JSON: unexpected character at ${where}.`;
}

/**
 * Checks `text` against a `contains`, `matches` or `json` assertion. A
 * regular expression and a JSON Schema run isolated (isolated.ts): one that
 * does not finish in time is inconclusive, and the thread is never blocked.
 */
export async function assertText(
  text: string,
  criterion: Assertion,
  subject: string,
  redact: (text: string, cut?: CutEdges) => string = (value) => value,
  timeLimitMs = ISOLATED_TIME_LIMIT_MS,
): Promise<{ outcome: CheckOutcome; detail: string }> {
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
      const shown = `/${criterion.value ?? ""}/${criterion.flags ?? ""}`;
      const run = await runIsolated(
        {
          kind: "match",
          pattern: criterion.value ?? "",
          ...(criterion.flags ? { flags: criterion.flags } : {}),
          text,
        },
        timeLimitMs,
      );
      if (!run.ok)
        return {
          outcome: "inconclusive",
          detail:
            run.reason === "timeout"
              ? `The regular expression ${shown} was stopped: ${run.message} (it may backtrack catastrophically on this text). Simplify the pattern.`
              : run.reason === "busy"
                ? `The regular expression ${shown} was not evaluated in time: ${run.message}. This says nothing about the pattern.`
                : `The regular expression ${shown} could not be evaluated: ${run.message}`,
        };
      return run.result.kind === "match"
        ? {
            outcome: "passed",
            // The match is cut out of the text at both ends, perhaps out of a
            // secret: what it holds of one is masked, a middle piece included.
            detail: `${subject} matches ${shown} at line ${lineOf(text, run.result.index)}: ${JSON.stringify(clipLine(redact(run.result.text, { start: true, end: true }), 120))}.`,
          }
        : {
            outcome: "failed",
            detail: `${subject} does not match ${shown}.`,
          };
    }
    case "json": {
      let value: unknown;
      try {
        value = JSON.parse(text);
      } catch {
        return { outcome: "failed", detail: invalidJson(text, subject) };
      }
      if (!criterion.schema)
        return { outcome: "passed", detail: `${subject} is valid JSON.` };
      const run = await runIsolated(
        { kind: "schema", schema: criterion.schema, value },
        timeLimitMs,
      );
      if (!run.ok)
        return {
          outcome: "inconclusive",
          detail:
            run.reason === "timeout"
              ? `The JSON Schema check was stopped: ${run.message} (a pattern in it may backtrack catastrophically).`
              : run.reason === "busy"
                ? `The JSON Schema check was not evaluated in time: ${run.message}. This says nothing about the schema.`
                : `The JSON Schema cannot be checked: ${run.message}`,
        };
      if (run.result.kind === "valid")
        return {
          outcome: "passed",
          detail: `${subject} is JSON valid against the schema.`,
        };
      if (run.result.kind !== "invalid")
        return {
          outcome: "inconclusive",
          detail: "The JSON Schema check returned no verdict.",
        };
      const { count, issues } = run.result;
      return {
        outcome: "failed",
        detail: `${subject} does not match the JSON Schema (${count} issue${count === 1 ? "" : "s"}): ${issues
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
        : await assertText(env.result, criterion, "The result", env.redact);
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
