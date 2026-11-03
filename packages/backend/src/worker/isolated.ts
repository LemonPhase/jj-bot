// Evaluates a user's regular expression or JSON Schema against text the
// agents wrote, off the main thread and with a hard time limit. A pattern
// can backtrack catastrophically (`^(\w+\s?)+$` on 35 bytes runs for
// minutes); on the main thread that would stop the worker and the API. The
// evaluation runs in a short-lived worker thread that is terminated when its
// time is up, and the check is recorded as inconclusive.
//
// A busy host can keep the thread waiting for a core, and its result waiting
// for the main thread, past the limit: that says nothing about the pattern.
// So the limit stops only a thread that has been running: one that has used
// at least `ISOLATED_MIN_RUN_MS` of processor time by then. A pattern that
// backtracks catastrophically uses that within the limit on any working
// host; a trivial evaluation needs a few milliseconds and finishes as soon as
// it gets them, however long it waited.
import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";

/** How long one regex match or schema validation may run, once its thread is ready. */
export const ISOLATED_TIME_LIMIT_MS = 2_000;
/**
 * Processor time a thread must have used before its limit stops it: below
 * this, the host kept it waiting rather than the evaluation running long.
 */
export const ISOLATED_MIN_RUN_MS = 100;
/**
 * How much longer than its limit a thread the host keeps waiting gets, before
 * it is stopped anyway. The caller's own timers end the check then, whether or
 * not the thread answers: a check always ends, however busy the host.
 */
export const ISOLATED_WAIT_ALLOWANCE_MS = 3_000;
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
  | {
      ok: false;
      /**
       * `timeout`: the evaluation ran past its limit. `busy`: the host did
       * not run it in time (it did not start, or barely ran by the end of its
       * allowance), which says nothing about the pattern.
       */
      reason: "timeout" | "busy" | "error";
      message: string;
    };

// CommonJS, evaluated as the worker's script: no file to resolve or compile.
// It says "ready" once it has loaded what it needs, right before evaluating,
// with the processor time its thread has used so far (microseconds; null
// where Node cannot tell), so the limit times the evaluation alone.
const SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
function ready() {
  const usage = typeof process.threadCpuUsage === "function" ? process.threadCpuUsage() : null;
  parentPort.postMessage({ ready: true, cpu: usage ? usage.user + usage.system : null });
}
function run(job, zod) {
  if (job.kind === "match") {
    const pattern = new RegExp(job.pattern, job.flags);
    ready();
    const match = pattern.exec(job.text);
    return match
      ? { kind: "match", index: match.index, text: match[0].slice(0, 400) }
      : { kind: "nomatch" };
  }
  const schema = (zod.z || zod).fromJSONSchema(job.schema);
  ready();
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

const seconds = (ms: number) => `${Math.round(ms / 100) / 10} s`;

const turn = () => new Promise((resolve) => setImmediate(resolve));

/**
 * Runs `job` in a fresh worker thread; never throws and never blocks the
 * caller's thread. The evaluation may run for `timeLimitMs` once its thread
 * is ready; a thread the host keeps waiting gets up to `waitAllowanceMs` more.
 */
export function runIsolated(
  job: IsolatedJob,
  timeLimitMs = ISOLATED_TIME_LIMIT_MS,
  waitAllowanceMs = ISOLATED_WAIT_ALLOWANCE_MS,
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
          reason: "busy",
          message: `the evaluation did not start within ${seconds(START_LIMIT_MS)}`,
        }),
      START_LIMIT_MS,
    );
    // From "ready" on. Once the limit is up, a thread that has been running
    // (used `minRunMs` of processor time) is stopped; one the host kept
    // waiting is looked at again until it has, finishes, or its allowance is up.
    const limit = (readyCpu: number | null) => {
      const readyAt = performance.now();
      const minRunMs = Math.min(ISOLATED_MIN_RUN_MS, timeLimitMs);
      const lastMs = timeLimitMs + waitAllowanceMs;
      const cpuAtReady =
        typeof worker.cpuUsage === "function" ? readyCpu : null;
      /**
       * Processor time used since "ready"; where Node cannot tell, the time
       * that passed. Node answers on the thread itself, which a busy host may
       * not run: no answer by the end of the allowance counts as no time, so
       * this thread's own timers still end the check there.
       */
      const used = async () => {
        if (cpuAtReady === null) return performance.now() - readyAt;
        let unanswered: ReturnType<typeof setTimeout> | undefined;
        try {
          const usage = await Promise.race([
            worker.cpuUsage(),
            new Promise<undefined>((resolve) => {
              unanswered = setTimeout(
                () => resolve(undefined),
                Math.max(0, lastMs - (performance.now() - readyAt)),
              );
            }),
          ]);
          if (!usage) return 0;
          return Math.max(0, usage.user + usage.system - cpuAtReady) / 1000;
        } catch {
          // The thread has stopped, so it runs no longer: its result, or its
          // exit, is on the way and settles the outcome.
          return 0;
        } finally {
          clearTimeout(unanswered);
        }
      };
      const check = async () => {
        timer = undefined;
        // A result that has already arrived is taken before the limit is judged.
        await turn();
        if (settled) return;
        const ran = await used();
        if (settled) return;
        const waited = performance.now() - readyAt;
        if (ran >= minRunMs)
          return finish({
            ok: false,
            reason: "timeout",
            message: `it did not finish within ${timeLimitMs / 1000} s`,
          });
        // A thread that just stopped reads as no time: its result may be in.
        if (waited >= lastMs) await turn();
        if (settled) return;
        if (waited >= lastMs)
          return finish({
            ok: false,
            reason: "busy",
            message: `the host was too busy to run it: it had ${Math.round(ran)} ms of processor time in ${seconds(waited)}`,
          });
        timer = setTimeout(
          check,
          Math.max(10, Math.min(minRunMs - ran, lastMs - waited)),
        );
      };
      timer = setTimeout(check, timeLimitMs);
    };
    worker.on(
      "message",
      (
        message:
          | { ready: true; cpu: number | null }
          | ({ done: true } & IsolatedOutcome),
      ) => {
        if ("ready" in message) {
          clearTimeout(starting);
          limit(message.cpu);
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
