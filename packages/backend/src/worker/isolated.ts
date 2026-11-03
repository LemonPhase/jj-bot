// Evaluates a user's regular expression or JSON Schema against text the
// agents wrote, off the main thread and with a hard time limit. A pattern
// can backtrack catastrophically (`^(\w+\s?)+$` on 35 bytes runs for
// minutes); on the main thread that would stop the worker and the API. The
// evaluation runs in a short-lived worker thread that is terminated when its
// time is up, and the check is recorded as inconclusive.
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

/** How long one regex match or schema validation may run. */
export const ISOLATED_TIME_LIMIT_MS = 2_000;
/** A worker that never comes online (an overloaded host) is given up after this. */
const START_LIMIT_MS = 10_000;

const zodPath = createRequire(import.meta.url).resolve("zod");

export type IsolatedJob =
  | { kind: "match"; pattern: string; flags?: string; text: string }
  | { kind: "schema"; schema: Record<string, unknown>; value: unknown };

export type IsolatedResult =
  | { kind: "match"; index: number; text: string }
  | { kind: "nomatch" }
  | { kind: "valid" }
  | {
      kind: "invalid";
      count: number;
      issues: { path: string[]; message: string }[];
    };

export type IsolatedOutcome =
  | { ok: true; result: IsolatedResult }
  | { ok: false; reason: "timeout" | "error"; message: string };

// CommonJS, evaluated as the worker's script: no file to resolve or compile.
const SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
function run(job) {
  if (job.kind === "match") {
    const match = new RegExp(job.pattern, job.flags).exec(job.text);
    return match
      ? { kind: "match", index: match.index, text: match[0].slice(0, 400) }
      : { kind: "nomatch" };
  }
  const zod = require(job.zodPath);
  const parsed = (zod.z || zod).fromJSONSchema(job.schema).safeParse(job.value);
  if (parsed.success) return { kind: "valid" };
  return {
    kind: "invalid",
    count: parsed.error.issues.length,
    issues: parsed.error.issues.slice(0, 5).map((issue) => ({
      path: issue.path.map(String),
      message: String(issue.message),
    })),
  };
}
try {
  parentPort.postMessage({ ok: true, result: run(workerData) });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    reason: "error",
    message: error && error.message ? String(error.message) : String(error),
  });
}
`;

/** Runs `job` in a fresh worker thread; never throws and never blocks the caller's thread. */
export function runIsolated(
  job: IsolatedJob,
  timeLimitMs = ISOLATED_TIME_LIMIT_MS,
): Promise<IsolatedOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const worker = new Worker(SOURCE, {
      eval: true,
      workerData: { ...job, zodPath },
      resourceLimits: { maxOldGenerationSizeMb: 128 },
    });
    const finish = (outcome: IsolatedOutcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      clearTimeout(starting);
      resolve(outcome);
      void worker.terminate();
    };
    const starting = setTimeout(
      () =>
        finish({
          ok: false,
          reason: "timeout",
          message: `the evaluation did not start within ${START_LIMIT_MS / 1000} s`,
        }),
      START_LIMIT_MS,
    );
    worker.once("online", () => {
      clearTimeout(starting);
      timer = setTimeout(
        () =>
          finish({
            ok: false,
            reason: "timeout",
            message: `it did not finish within ${timeLimitMs / 1000} s`,
          }),
        timeLimitMs,
      );
    });
    worker.once("message", (message: IsolatedOutcome) => finish(message));
    worker.once("error", (error) =>
      finish({ ok: false, reason: "error", message: error.message }),
    );
    worker.once("exit", (code) =>
      finish({
        ok: false,
        reason: "error",
        message: `the evaluation stopped (exit code ${code})`,
      }),
    );
  });
}
