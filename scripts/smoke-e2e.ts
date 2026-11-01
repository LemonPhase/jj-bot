// End-to-end smoke test of the whole server over HTTP. Boots the real API
// in-process (startServer) on a temporary PGlite directory with the local
// sandbox driver, an API token and the scripted test model, then: creates
// three bots, creates a task with all three, follows its SSE stream until it
// completes, checks that two workers ran in parallel and that the artifacts
// download intact, and stops a second task. Exits non-zero on any failure.
//
// JJ_SMOKE_MODEL=<provider/model> runs the same flow against a real model
// instead (its provider key must be set); that mode is not run in CI.
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type RunningServer, startServer } from "@jj/api/server";
import type { Artifact, TaskEvent, TaskView } from "@jj/contracts";
import { ModelRegistry } from "@jj/runtime";

const realModel = process.env.JJ_SMOKE_MODEL?.trim() || undefined;
const timeoutMs = realModel ? 10 * 60_000 : 60_000;

if (realModel) {
  try {
    new ModelRegistry({ env: process.env }).resolve(realModel);
  } catch (error) {
    console.error(
      `smoke:e2e refused to run ${realModel}: ${error instanceof Error ? error.message : error}`,
    );
    process.exit(2);
  }
}

interface Step {
  name: string;
  ok: boolean;
  ms: number;
  detail?: string;
}
const steps: Step[] = [];

async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const value = await run();
    steps.push({ name, ok: true, ms: Date.now() - started });
    return value;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    steps.push({ name, ok: false, ms: Date.now() - started, detail });
    throw new StepFailed(name, detail);
  }
}

class StepFailed extends Error {}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), "jj-smoke-e2e-"));
  const token = randomBytes(24).toString("hex");
  const env: Record<string, string | undefined> = {
    ...process.env,
    API_HOST: "127.0.0.1",
    API_PORT: "0",
    API_TOKEN: token,
    DATABASE_URL: undefined,
    JJ_DATABASE_PATH: join(dir, "db"),
    JJ_EMBED_WORKER: "true",
    JJ_SANDBOX_DRIVERS: "local",
    JJ_SANDBOX_ROOT: join(dir, "sandbox"),
    JJ_ENABLE_SCRIPTED_MODEL: realModel ? "false" : "true",
    JJ_DEFAULT_MODEL: realModel,
  };
  let server: RunningServer | undefined;
  try {
    server = await step("boot the API (PGlite, local driver)", () =>
      startServer({ env }),
    );
    const base = server.url;
    const headers = { Authorization: `Bearer ${token}` };
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          ...headers,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    };
    const expectStatus = async (
      method: string,
      path: string,
      status: number,
      body?: unknown,
    ) => {
      const result = await call(method, path, body);
      check(
        result.status === status,
        `${method} ${path} answered ${result.status}, expected ${status}: ${JSON.stringify(result.body)}`,
      );
      return result.body;
    };

    await step("ready, and /api needs the token", async () => {
      const ready = await fetch(`${base}/health/ready`);
      check(ready.status === 200, `readiness ${ready.status}`);
      const anonymous = await fetch(`${base}/api/bootstrap`);
      check(anonymous.status === 401, `no token: ${anonymous.status}`);
      const bootstrap = await expectStatus("GET", "/api/bootstrap", 200);
      check(bootstrap.mode === "backend", "bootstrap mode");
      check(bootstrap.capabilities.agentExecution, "no model configured");
      check(
        bootstrap.defaultModel === (realModel ?? "scripted/team"),
        `default model ${bootstrap.defaultModel}`,
      );
    });

    const bots = await step("create three bots", async () => {
      const ids: Record<string, string> = {};
      for (const name of ["Ada", "Grace", "Linus"]) {
        const { bot } = await expectStatus("POST", "/api/bots", 201, {
          name,
          ...(realModel ? { model: realModel } : {}),
        });
        ids[name] = bot.id;
      }
      return ids as { Ada: string; Grace: string; Linus: string };
    });

    const goal =
      "Write two short notes about penguins. Delegate one part to Grace and one part to Linus at the same time; each writes their notes to a markdown file in the workspace. Then complete the task with a one-paragraph summary.";
    const { task } = await step("create a task with all three", () =>
      expectStatus("POST", "/api/tasks", 201, {
        goal,
        title: "Penguin notes",
        coordinatorBotId: bots.Ada,
        participantBotIds: [bots.Grace, bots.Linus],
      }),
    );

    const events = await step(
      "follow the SSE stream until the task completes",
      () => followUntilFinished(base, headers, task.id),
    );

    const view: TaskView = await step(
      "the task completed with its record",
      async () => {
        const finished = events.find((event) => event.type === "task.finished");
        check(finished, "no task.finished event");
        const current = await expectStatus("GET", `/api/tasks/${task.id}`, 200);
        check(
          current.task.status === "completed",
          `status ${current.task.status}: ${current.task.error ?? ""}`,
        );
        check(current.cursor >= events.at(-1)!.sequence, "view behind stream");
        return current;
      },
    );

    await step("at least two workers ran in parallel", async () => {
      const workers = view.sessions.filter(
        (session) => session.role === "worker",
      );
      check(workers.length >= 2, `${workers.length} worker session(s)`);
      const peak = maxParallelRuns(events, new Set(workers.map((s) => s.id)));
      check(peak >= 2, `at most ${peak} worker run(s) at once`);
    });

    await step("artifacts download intact", async () => {
      const files = view.artifacts.filter(
        (artifact) => artifact.kind === "file",
      );
      check(files.length >= 2, `${files.length} file artifact(s)`);
      for (const artifact of view.artifacts)
        await download(base, headers, task.id, artifact);
    });

    await step("stop a second task", async () => {
      const { task: second } = await expectStatus("POST", "/api/tasks", 201, {
        goal: `${goal} (second run, to be stopped)`,
        coordinatorBotId: bots.Ada,
        participantBotIds: [bots.Grace, bots.Linus],
      });
      const stopped = await expectStatus(
        "POST",
        `/api/tasks/${second.id}/stop`,
        200,
        {
          reason: "smoke test",
        },
      );
      check(stopped.task.cancelRequestedAt, "no cancelRequestedAt");
      const deadline = Date.now() + timeoutMs;
      let current: TaskView;
      for (;;) {
        current = await expectStatus("GET", `/api/tasks/${second.id}`, 200);
        if (current.task.status === "cancelled") break;
        check(Date.now() < deadline, `still ${current.task.status}`);
        await sleep(100);
      }
      check(
        current.events.some((event) => event.type === "cancellation.completed"),
        "no cancellation.completed event",
      );
      await expectStatus("POST", `/api/tasks/${second.id}/messages`, 409, {
        text: "Are you still there?",
      });
    });

    await step("still ready, then shut down gracefully", async () => {
      const ready = await fetch(`${base}/health/ready`);
      check(ready.status === 200, `readiness ${ready.status}`);
      const started = Date.now();
      await server?.close();
      check(Date.now() - started < 10_000, "shutdown took over 10 s");
    });
    return true;
  } catch (error) {
    if (!(error instanceof StepFailed)) {
      steps.push({
        name: "unexpected error",
        ok: false,
        ms: 0,
        detail:
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error),
      });
    }
    return false;
  } finally {
    await server?.close().catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}

/** Reads the task stream from the start until `task.finished`; checks the framing. */
async function followUntilFinished(
  base: string,
  headers: Record<string, string>,
  taskId: string,
): Promise<TaskEvent[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const events: TaskEvent[] = [];
  try {
    const response = await fetch(`${base}/api/tasks/${taskId}/stream`, {
      headers: { ...headers, Accept: "text/event-stream" },
      signal: controller.signal,
    });
    check(response.status === 200, `stream answered ${response.status}`);
    check(
      response.headers.get("Content-Type")?.includes("text/event-stream"),
      "not an event stream",
    );
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const { done, value } = await reader.read();
      check(!done, "the stream ended before the task finished");
      buffer += decoder.decode(value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const fields: Record<string, string> = {};
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue;
          const colon = line.indexOf(":");
          fields[line.slice(0, colon)] = line
            .slice(colon + 1)
            .replace(/^ /, "");
        }
        if (fields.data === undefined) continue;
        const event = JSON.parse(fields.data) as TaskEvent;
        check(
          fields.id === String(event.sequence),
          `frame id ${fields.id} != ${event.sequence}`,
        );
        check(
          fields.event === event.type,
          `frame event ${fields.event} != ${event.type}`,
        );
        check(
          event.sequence === (events.at(-1)?.sequence ?? 0) + 1,
          `sequence ${event.sequence} after ${events.at(-1)?.sequence ?? 0}`,
        );
        events.push(event);
        if (event.type === "task.finished") {
          controller.abort();
          return events;
        }
      }
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function maxParallelRuns(events: TaskEvent[], sessionIds: Set<string>): number {
  const open = new Set<string>();
  let peak = 0;
  for (const event of events) {
    if (!event.sessionId || !sessionIds.has(event.sessionId)) continue;
    if (event.type === "run.started") open.add(event.sessionId);
    if (event.type === "run.finished") open.delete(event.sessionId);
    peak = Math.max(peak, open.size);
  }
  return peak;
}

async function download(
  base: string,
  headers: Record<string, string>,
  taskId: string,
  artifact: Artifact,
) {
  const response = await fetch(
    `${base}/api/tasks/${taskId}/artifacts/${artifact.id}/content`,
    { headers },
  );
  check(response.status === 200, `${artifact.name}: ${response.status}`);
  check(
    response.headers.get("Content-Disposition")?.startsWith("attachment;"),
    `${artifact.name}: not an attachment`,
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  check(bytes.byteLength === artifact.sizeBytes, `${artifact.name}: size`);
  const digest = createHash("sha256").update(bytes).digest("hex");
  check(digest === artifact.sha256, `${artifact.name}: sha256 mismatch`);
}

const started = Date.now();
const ok = await main();
console.log(
  `\nsmoke:e2e (${realModel ?? "scripted/team"}): ${ok ? "passed" : "FAILED"} in ${((Date.now() - started) / 1000).toFixed(1)} s`,
);
for (const entry of steps)
  console.log(
    `  ${entry.ok ? "ok  " : "FAIL"} ${entry.name} (${entry.ms} ms)${entry.detail ? `\n       ${entry.detail}` : ""}`,
  );
process.exit(ok ? 0 : 1);
