// End-to-end smoke test of the whole server over HTTP. By default it boots the
// real API in-process (startServer) on a temporary PGlite directory with the
// local sandbox driver, an API token and the scripted test model. With
// JJ_SMOKE_BASE_URL it runs against a server that is already up instead, such
// as the compose stack, and checks that tasks run in the isolated docker
// sandbox. Either way it creates three bots, creates a task with all three,
// follows its SSE stream until it completes, checks that two workers ran in
// parallel and that the artifacts download intact, and stops a second task.
//
// JJ_SMOKE_RESTART_COMMAND (with JJ_SMOKE_BASE_URL) adds restart survival: a
// third task is caught mid-command, the command restarts the server (for
// example `docker compose restart app`), and the task must still complete
// without repeating finished work, with the replayed stream rebuilding the
// same view as a reload. Exits non-zero on any failure.
//
// JJ_SMOKE_MODEL=<provider/model> runs the same flow against a real model
// instead (its provider key must be set where the server runs); that mode is
// not run in CI. JJ_SMOKE_TOKEN is the bearer token of a server at
// JJ_SMOKE_BASE_URL, when it has one.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type RunningServer, startServer } from "@jj/api/server";
import {
  type Artifact,
  applyTaskEvent,
  type RuntimeProfile,
  type TaskEvent,
  type TaskView,
} from "@jj/contracts";
import { ModelRegistry } from "@jj/runtime";

const setting = (name: string) => process.env[name]?.trim() || undefined;
const realModel = setting("JJ_SMOKE_MODEL");
const remoteUrl = setting("JJ_SMOKE_BASE_URL")?.replace(/\/+$/, "");
const remoteToken = setting("JJ_SMOKE_TOKEN");
const restartCommand = setting("JJ_SMOKE_RESTART_COMMAND");
const timeoutMs = realModel ? 10 * 60_000 : remoteUrl ? 120_000 : 60_000;
/** The slow command the restart lands on; it would outlast the whole check. */
const SLOW_COMMAND = "sleep 300";
/** Shows where commands run: the docker driver's sandbox user and workspace. */
const WHERE_COMMAND = "id -un && pwd";

if (restartCommand && !remoteUrl) {
  console.error(
    "smoke:e2e: JJ_SMOKE_RESTART_COMMAND needs JJ_SMOKE_BASE_URL (a server it can restart).",
  );
  process.exit(2);
}
if (realModel && !remoteUrl) {
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
    throw new StepFailed(`${name}: ${detail}`);
  }
}

class StepFailed extends Error {}

/** A parsed JSON answer. */
type Json = ReturnType<typeof JSON.parse>;
type ExpectStatus = (
  method: string,
  path: string,
  status: number,
  body?: unknown,
) => Promise<Json>;

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The server under test: booted here, or already running at JJ_SMOKE_BASE_URL. */
async function serverUnderTest(dir: string): Promise<{
  base: string;
  token: string | undefined;
  server?: RunningServer;
}> {
  if (remoteUrl) {
    await step(`reach the server at ${remoteUrl}`, () =>
      untilReady(remoteUrl, 60_000),
    );
    return { base: remoteUrl, token: remoteToken };
  }
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
  const server = await step("boot the API (PGlite, local driver)", () =>
    startServer({ env }),
  );
  return { base: server.url, token, server };
}

async function untilReady(base: string, withinMs: number): Promise<void> {
  const deadline = Date.now() + withinMs;
  let last = "no answer";
  for (;;) {
    try {
      const response = await fetch(`${base}/health/ready`);
      if (response.status === 200) return;
      last = `readiness ${response.status}: ${await response.text()}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    check(Date.now() < deadline, `not ready within ${withinMs} ms: ${last}`);
    await sleep(500);
  }
}

async function main(): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), "jj-smoke-e2e-"));
  let server: RunningServer | undefined;
  try {
    const target = await serverUnderTest(dir);
    server = target.server;
    const { base, token } = target;
    const headers: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {};
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
    const expectStatus: ExpectStatus = async (method, path, status, body) => {
      const result = await call(method, path, body);
      check(
        result.status === status,
        `${method} ${path} answered ${result.status}, expected ${status}: ${JSON.stringify(result.body)}`,
      );
      return result.body;
    };

    await step(
      token ? "ready, and /api needs the token" : "ready, without a token",
      async () => {
        const ready = await fetch(`${base}/health/ready`);
        check(ready.status === 200, `readiness ${ready.status}`);
        if (token) {
          const anonymous = await fetch(`${base}/api/bootstrap`);
          check(anonymous.status === 401, `no token: ${anonymous.status}`);
        }
        const bootstrap = await expectStatus("GET", "/api/bootstrap", 200);
        check(bootstrap.mode === "backend", "bootstrap mode");
        check(bootstrap.capabilities.agentExecution, "no model configured");
        if (!(remoteUrl && realModel))
          check(
            bootstrap.defaultModel === (realModel ?? "scripted/team"),
            `default model ${bootstrap.defaultModel}`,
          );
      },
    );

    // Against a deployed server, bots run on the default profile, which must
    // be the isolated docker sandbox.
    const dockerProfile = remoteUrl
      ? await step(
          "the default profile is the isolated docker sandbox",
          async () => {
            const { drivers } = await expectStatus(
              "GET",
              "/api/sandbox-drivers",
              200,
            );
            const docker = drivers.find(
              (driver: { id: string }) => driver.id === "docker",
            );
            check(docker?.available, "the docker driver is not available");
            const { profiles } = (await expectStatus(
              "GET",
              "/api/runtime-profiles",
              200,
            )) as { profiles: RuntimeProfile[] };
            const profile = profiles.find((entry) => entry.isDefault);
            check(profile, "no default runtime profile");
            check(
              profile.sandbox.driver === "docker",
              `the default profile uses ${profile.sandbox.driver}`,
            );
            check(
              profile.status.driverAvailable && profile.status.isolated,
              `profile status ${JSON.stringify(profile.status)}`,
            );
            return profile;
          },
        )
      : undefined;

    // A deployed server keeps its bots, and names are unique.
    const suffix = remoteUrl ? `-${randomBytes(3).toString("hex")}` : "";
    const bots = await step("create three bots", async () => {
      const ids: Record<string, string> = {};
      for (const name of ["Ada", "Grace", "Linus"]) {
        const { bot } = await expectStatus("POST", "/api/bots", 201, {
          name: `${name}${suffix}`,
          ...(realModel ? { model: realModel } : {}),
          ...(dockerProfile ? { runtimeProfileId: dockerProfile.id } : {}),
        });
        ids[name] = bot.id;
      }
      return ids as { Ada: string; Grace: string; Linus: string };
    });
    const roster = {
      coordinatorBotId: bots.Ada,
      participantBotIds: [bots.Grace, bots.Linus],
    };

    // The scripted model runs each command a brief quotes after "run" once.
    const goal = (directive: string) =>
      `${directive}Write two short notes about penguins. Delegate one part to Grace${suffix} and one part to Linus${suffix} at the same time; each writes their notes to a markdown file in the workspace. Then complete the task with a one-paragraph summary.`;
    const { task } = await step("create a task with all three", () =>
      expectStatus("POST", "/api/tasks", 201, {
        goal: goal(
          remoteUrl
            ? `After writing your notes, run \`${WHERE_COMMAND}\`. `
            : "",
        ),
        title: "Penguin notes",
        ...roster,
      }),
    );

    const events = await step(
      "follow the SSE stream until the task completes",
      () =>
        follow(base, headers, task.id, {
          after: 0,
          reconnect: false,
          until: (event) => event.type === "task.finished",
        }),
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

    if (remoteUrl && !realModel)
      await step(
        "commands ran as the sandbox user in /workspace (docker)",
        async () => {
          const outputs = events.flatMap((event) =>
            event.type === "tool.finished" &&
            event.payload.summary === WHERE_COMMAND
              ? [event.payload]
              : [],
          );
          check(outputs.length >= 2, `${outputs.length} \`${WHERE_COMMAND}\``);
          for (const output of outputs) {
            check(output.ok, `\`${WHERE_COMMAND}\` failed: ${output.output}`);
            check(
              output.output?.trim() === "sandbox\n/workspace",
              `\`${WHERE_COMMAND}\` printed ${JSON.stringify(output.output)}`,
            );
          }
        },
      );

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
        goal: `${goal("")} (second run, to be stopped)`,
        ...roster,
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

    if (restartCommand)
      await restartSurvival({
        base,
        headers,
        expectStatus,
        create: () =>
          expectStatus("POST", "/api/tasks", 201, {
            goal: goal(`After writing your notes, run \`${SLOW_COMMAND}\`. `),
            title: "Penguin notes across a restart",
            ...roster,
          }),
      });

    if (server) {
      await step("still ready, then shut down gracefully", async () => {
        const ready = await fetch(`${base}/health/ready`);
        check(ready.status === 200, `readiness ${ready.status}`);
        const started = Date.now();
        await server?.close();
        check(Date.now() - started < 10_000, "shutdown took over 10 s");
      });
    } else {
      await step("still ready", async () => {
        const ready = await fetch(`${base}/health/ready`);
        check(ready.status === 200, `readiness ${ready.status}`);
      });
    }
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

/**
 * Restart survival: start a task, wait until its workers are running the
 * slow command, restart the server with JJ_SMOKE_RESTART_COMMAND, and check
 * that the task completes, that nothing that had finished ran again, and that
 * the stream replayed across the restart folds into the view a reload shows.
 */
async function restartSurvival(options: {
  base: string;
  headers: Record<string, string>;
  expectStatus: ExpectStatus;
  create: () => Promise<{ task: { id: string } }>;
}) {
  const { base, headers, expectStatus } = options;
  const { taskId, initial, streamed, followed, cut } = await step(
    "start a task and catch its workers mid-command",
    async () => {
      const { task } = await options.create();
      const initial: TaskView = await expectStatus(
        "GET",
        `/api/tasks/${task.id}`,
        200,
      );
      const streamed: TaskEvent[] = [];
      const followed = follow(base, headers, task.id, {
        after: initial.cursor,
        reconnect: true,
        onEvent: (event) => streamed.push(event),
        until: (event) => event.type === "task.finished",
      });
      followed.catch(() => {});
      const running = () => {
        const started = streamed.filter(
          (event) =>
            event.type === "tool.started" &&
            event.payload.summary === SLOW_COMMAND,
        );
        return started.length >= 2 ? started : undefined;
      };
      const deadline = Date.now() + timeoutMs;
      while (!running()) {
        check(
          !streamed.some((event) => event.type === "task.finished"),
          "the task finished before its workers reached the slow command",
        );
        check(Date.now() < deadline, "no worker reached the slow command");
        await Promise.race([followed, sleep(100)]);
      }
      return {
        taskId: task.id,
        initial,
        streamed,
        followed,
        cut: streamed.at(-1)?.sequence ?? initial.cursor,
      };
    },
  );

  await step(`restart the server: ${restartCommand}`, async () => {
    const result = spawnSync(restartCommand as string, {
      shell: true,
      stdio: "inherit",
      timeout: 120_000,
    });
    check(
      result.status === 0,
      `exited with ${result.status ?? result.signal ?? result.error?.message}`,
    );
    await untilReady(base, 120_000);
  });

  const events = await step(
    "the task completes after the restart",
    () => followed,
  );
  const fresh: TaskView = await expectStatus(
    "GET",
    `/api/tasks/${taskId}`,
    200,
  );

  await step("the stop handed the running commands back", async () => {
    check(
      fresh.task.status === "completed",
      `status ${fresh.task.status}: ${fresh.task.error ?? ""}`,
    );
    const cutShort = events.filter(
      (event) =>
        event.type === "tool.finished" &&
        event.payload.summary === SLOW_COMMAND,
    );
    check(cutShort.length >= 2, `${cutShort.length} slow command result(s)`);
    for (const event of cutShort) {
      // A graceful stop verifies the command is gone ("yes"); a crash, where
      // the next process finds an expired lease, could only say "unknown".
      check(
        event.type === "tool.finished" &&
          !event.payload.ok &&
          event.payload.interrupted === "yes",
        `the slow command was not stopped cleanly: ${JSON.stringify(event.payload)}`,
      );
      const after = events.filter(
        (other) =>
          other.sessionId === event.sessionId &&
          other.sequence > event.sequence,
      );
      const handedBack = after.find((other) => other.type === "run.finished");
      check(
        handedBack?.type === "run.finished" &&
          handedBack.payload.outcome === "cancelled",
        `session ${event.sessionId}'s run was not handed back on shutdown: ${JSON.stringify(handedBack?.payload)}`,
      );
      check(
        after.some(
          (other) =>
            other.type === "run.started" && other.payload.reason === "recovery",
        ),
        `session ${event.sessionId} did not resume in a recovery run`,
      );
    }
  });

  await step("no finished work ran again", async () => {
    const workers = fresh.sessions.filter(
      (session) => session.role === "worker",
    );
    check(workers.length === 2, `${workers.length} worker sessions`);
    const key = (event: TaskEvent) =>
      event.type === "tool.started" || event.type === "tool.finished"
        ? `${event.sessionId} ${event.payload.tool} ${event.payload.summary}`
        : "";
    const finishedBefore = events.filter(
      (event) =>
        event.type === "tool.finished" &&
        event.payload.ok &&
        event.sequence <= cut,
    );
    check(
      finishedBefore.length >= 2,
      `only ${finishedBefore.length} tool call(s) finished before the restart`,
    );
    for (const done of finishedBefore) {
      const again = events.find(
        (event) =>
          event.type === "tool.started" &&
          event.sequence > done.sequence &&
          key(event) === key(done),
      );
      check(!again, `ran again after the restart: ${key(done)}`);
    }
    // The scripted model's calls are all distinct, the interrupted one included.
    const seen = new Set<string>();
    for (const event of events.filter((e) => e.type === "tool.started")) {
      check(!seen.has(key(event)), `started twice: ${key(event)}`);
      seen.add(key(event));
    }
  });

  await step(
    "replay across the restart rebuilds the reloaded view",
    async () => {
      const replayed = events.reduce(applyTaskEvent, initial);
      check(
        replayed.cursor === fresh.cursor,
        `replay cursor ${replayed.cursor} != ${fresh.cursor}`,
      );
      for (const part of ["task", "sessions", "messages", "artifacts"] as const)
        check(
          isDeepStrictEqual(replayed[part], fresh[part]),
          `the replayed ${part} differ from the reloaded view`,
        );
      const log = await allEvents(base, headers, taskId);
      check(
        log.every((event, index) => event.sequence === index + 1),
        "the event log has gaps",
      );
      check(
        isDeepStrictEqual(
          log.filter((event) => event.sequence > initial.cursor),
          events,
        ),
        "the stream and the event log differ",
      );
    },
  );
}

/** Every event of a task, from the paged log. */
async function allEvents(
  base: string,
  headers: Record<string, string>,
  taskId: string,
): Promise<TaskEvent[]> {
  const events: TaskEvent[] = [];
  let after = 0;
  for (;;) {
    const response = await fetch(
      `${base}/api/tasks/${taskId}/events?after=${after}`,
      { headers },
    );
    check(response.status === 200, `events page ${response.status}`);
    const page = (await response.json()) as {
      events: TaskEvent[];
      cursor: number;
      hasMore: boolean;
    };
    events.push(...page.events);
    if (!page.hasMore) return events;
    after = page.cursor;
  }
}

/**
 * Reads the task stream after `after` until `until` matches; checks the
 * framing and that sequences arrive gap-free. With `reconnect`, a stream that
 * ends or fails (a server restart) is reopened with `Last-Event-ID`.
 */
async function follow(
  base: string,
  headers: Record<string, string>,
  taskId: string,
  options: {
    after: number;
    reconnect: boolean;
    until: (event: TaskEvent) => boolean;
    onEvent?: (event: TaskEvent) => void;
  },
): Promise<TaskEvent[]> {
  const events: TaskEvent[] = [];
  const deadline = Date.now() + timeoutMs + (options.reconnect ? 120_000 : 0);
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.max(deadline - Date.now(), 0),
    );
    try {
      const last = events.at(-1)?.sequence ?? options.after;
      const response = await fetch(`${base}/api/tasks/${taskId}/stream`, {
        headers: {
          ...headers,
          Accept: "text/event-stream",
          ...(last > 0 ? { "Last-Event-ID": String(last) } : {}),
        },
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
        if (done) throw new StreamEnded();
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
          const previous = events.at(-1)?.sequence ?? options.after;
          check(
            event.sequence === previous + 1,
            `sequence ${event.sequence} after ${previous}`,
          );
          events.push(event);
          options.onEvent?.(event);
          if (options.until(event)) return events;
        }
      }
    } catch (error) {
      const broken =
        error instanceof StreamEnded ||
        (error instanceof TypeError && !controller.signal.aborted);
      if (!broken) throw error;
      check(options.reconnect, "the stream ended before the task finished");
      check(Date.now() < deadline, "the stream did not come back in time");
      await sleep(500);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }
}

class StreamEnded extends Error {}

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
  `\nsmoke:e2e (${realModel ?? "scripted/team"}${remoteUrl ? ` at ${remoteUrl}` : ""}): ${ok ? "passed" : "FAILED"} in ${((Date.now() - started) / 1000).toFixed(1)} s`,
);
for (const entry of steps)
  console.log(
    `  ${entry.ok ? "ok  " : "FAIL"} ${entry.name} (${entry.ms} ms)${entry.detail ? `\n       ${entry.detail}` : ""}`,
  );
process.exit(ok ? 0 : 1);
