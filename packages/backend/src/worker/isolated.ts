// Evaluates a user's regular expression or JSON Schema against text the
// agents wrote, off the main thread and with a hard time limit. A pattern
// can backtrack catastrophically (`^(\w+\s?)+$` on 35 bytes runs for
// minutes); on the main thread that would stop the worker and the API. The
// evaluation runs in a short-lived worker thread that is terminated when its
// time is up, and the check is recorded as inconclusive.
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

/** How long one regex match or schema validation may run, once its thread is ready. */
export const ISOLATED_TIME_LIMIT_MS = 2_000;
/**
 * How long a thread may take to start and load what it needs before the
 * evaluation's own limit begins. Generous: many threads starting at once on
 * a busy host are slow to start, which says nothing about the pattern.
 */
const START_LIMIT_MS = 30_000;

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
// It says "ready" once it has loaded what it needs, right before evaluating,
// so the time limit measures the evaluation alone.
const SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
function run(job, zod) {
  if (job.kind === "match") {
    const pattern = new RegExp(job.pattern, job.flags);
    parentPort.postMessage({ ready: true });
    const match = pattern.exec(job.text);
    return match
      ? { kind: "match", index: match.index, text: match[0].slice(0, 400) }
      : { kind: "nomatch" };
  }
  const schema = (zod.z || zod).fromJSONSchema(job.schema);
  parentPort.postMessage({ ready: true });
  const parsed = schema.safeParse(job.value);
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
  const zod = workerData.kind === "schema" ? require(workerData.zodPath) : undefined;
  parentPort.postMessage({ done: true, ok: true, result: run(workerData, zod) });
} catch (error) {
  parentPort.postMessage({
    done: true,
    ok: false,
    reason: "error",
    message: error && error.message ? String(error.message) : String(error),
  });
}
`;

let live = 0;

/** Isolated threads started and not yet exited (tests check none is left running). */
export const liveIsolatedThreads = () => live;

/** Runs `job` in a fresh worker thread; never throws and never blocks the caller's thread. */
export function runIsolated(
  job: IsolatedJob,
  timeLimitMs = ISOLATED_TIME_LIMIT_MS,
): Promise<IsolatedOutcome> {
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(SOURCE, {
        eval: true,
        workerData: { ...job, zodPath },
        resourceLimits: { maxOldGenerationSizeMb: 128 },
      });
    } catch (error) {
      // Data the structured clone cannot copy, or a host that cannot start a thread.
      resolve({
        ok: false,
        reason: "error",
        message: `the evaluation could not start: ${error instanceof Error ? error.message : String(error)}`,
      });
      return;
    }
    live += 1;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (outcome: IsolatedOutcome) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      clearTimeout(starting);
      resolve(outcome);
      // A thread still evaluating (a timeout) is stopped here, at once.
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
    worker.on(
      "message",
      (message: { ready: true } | ({ done: true } & IsolatedOutcome)) => {
        if ("ready" in message) {
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
          return;
        }
        const { done: _done, ...outcome } = message;
        finish(outcome as IsolatedOutcome);
      },
    );
    worker.once("error", (error) =>
      finish({ ok: false, reason: "error", message: error.message }),
    );
    worker.once("exit", (code) => {
      live -= 1;
      finish({
        ok: false,
        reason: "error",
        message: `the evaluation stopped (exit code ${code})`,
      });
    });
  });
}
