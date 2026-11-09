// End-to-end smoke test of the whole server over HTTP. By default it boots the
// real API in-process (startServer) on a temporary PGlite directory with the
// local sandbox driver, an API token and the scripted test model. With
// JJ_SMOKE_BASE_URL it runs against a server that is already up instead, such
// as the compose stack, and checks that tasks run in the isolated docker
// sandbox. Either way it creates three bots, creates a task with all three,
// follows its SSE stream until it completes, checks that two workers ran in
// parallel and that the artifacts download intact, and stops a second task.
// Verification plans: a failing check is fixed and the task completes
// verified, and a check that cannot pass leaves its task waiting.
// Then it chats with another bot: a request for a file creates a task, the
// bot tells its result in the chat, answers how it went, and a follow-up
// continues the same task. With a token, it also signs in as the web app
// does: a cookie session (`__Host-jj_session` and Secure over https), the
// first task's stream resumed on it with `Last-Event-ID`, a cookie write
// without the app's Origin refused, and signing out.
//
// JJ_SMOKE_RESTART_COMMAND (with JJ_SMOKE_BASE_URL) adds restart survival: a
// third task is caught mid-command, the command restarts the server (for
// example `docker compose restart app`, whose drain times out on that
// command), and the task must still complete without repeating finished
// work, with the replayed stream rebuilding the same view as a reload.
// Exits non-zero on any failure.
//
// JJ_SMOKE_RESTORE_COMMAND (with JJ_SMOKE_BASE_URL) adds backup survival:
// after the first task, the command backs the stack up, wipes it and restores
// it (scripts/backup.sh, `docker compose down -v`, scripts/restore.sh, up
// again). Every bot, profile, task, event and artifact must read back the
// same with the same token, and the restored task continues with a
// verification plan whose checks find its files in the restored workspace,
// byte for byte. The rest of the smoke then runs on the restored data.
//
// JJ_SMOKE_DRIVER=docker boots the server on the docker driver alone instead
// of local, in a daemon namespace of its own that it removes at the end; it
// checks that the default profile is the isolated docker sandbox and runs it
// without network (JJ_SMOKE_SANDBOX_IMAGE replaces the profile's image).
// Model-written commands then never run next to the provider key.
//
// JJ_SMOKE_MODEL=<provider/model> runs the same flow against a real model
// instead (its provider key must be set where the server runs); pull-request
// CI never runs that mode, the nightly live run (scripts/smoke-nightly.ts)
// does, on docker. JJ_SMOKE_TOKEN is the bearer token of a server at JJ_SMOKE_BASE_URL,
// when it has one.
//
// Spend: a spend cap that stops work no step expects to stop (the server's
// JJ_MAX_USD_PER_DAY, which the booted server reads from this environment, or
// a task's cap) fails the step at once as stopped at that cap.
// JJ_SMOKE_TASK_CAP_USD caps every task of the server the smoke boots (its
// default profile's `maxUsdPerTask`). The spend in the server's last 24 hours
// (`GET /api/usage`) is printed at the end; JJ_SMOKE_REPORT=<path> also writes
// it, with every step, as JSON.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { type RunningServer, startServer } from "@jj/api/server";
import {
  type Artifact,
  applyTaskEvent,
  formatSpendAgainstCap,
  formatUsd,
  isVerified,
  MAX_SPEND_CAP_USD,
  type RuntimeProfile,
  type SpendScope,
  type TaskEvent,
  type TaskSummary,
  type TaskView,
  type UsageReport,
  verificationSummary,
} from "@jj/contracts";
import { ModelRegistry } from "@jj/runtime";
import { mcpFixture } from "../packages/backend/src/testing/mcp-fixture";

const setting = (name: string) => process.env[name]?.trim() || undefined;
const realModel = setting("JJ_SMOKE_MODEL");
const remoteUrl = setting("JJ_SMOKE_BASE_URL")?.replace(/\/+$/, "");
const remoteToken = setting("JJ_SMOKE_TOKEN");
const restartCommand = setting("JJ_SMOKE_RESTART_COMMAND");
const restoreCommand = setting("JJ_SMOKE_RESTORE_COMMAND");
const reportPath = setting("JJ_SMOKE_REPORT");
const taskCapSetting = setting("JJ_SMOKE_TASK_CAP_USD");
const taskCapUsd =
  taskCapSetting === undefined ? undefined : Number(taskCapSetting);
/** The driver of the server the smoke boots: `local` (default) or `docker`. */
const bootDriver = setting("JJ_SMOKE_DRIVER") ?? "local";
/** The docker sandbox image of the server the smoke boots, instead of the profile's. */
const sandboxImage = setting("JJ_SMOKE_SANDBOX_IMAGE");
/** Tasks run in docker sandboxes: a deployed server's, or the booted one's. */
const onDocker = Boolean(remoteUrl) || bootDriver === "docker";
/**
 * A namespace of its own on the daemon, so the booted server's worker reaps
 * no other server's sandboxes, and the smoke removes its own at the end.
 */
const dockerNamespace = `jj-smoke-${randomBytes(4).toString("hex")}`;
const timeoutMs = realModel ? 10 * 60_000 : onDocker ? 120_000 : 60_000;
/** The slow command the restart lands on; it outlasts the server's drain and the whole check. */
const SLOW_COMMAND = "sleep 300";
/** Shows where commands run: the docker driver's sandbox user and workspace. */
const WHERE_COMMAND = "id -un && pwd";
/**
 * host:port targets a sandbox must not reach, against a deployed server
 * (JJ_SMOKE_UNREACHABLE, comma-separated; default the compose app and
 * PostgreSQL by service name). CI adds their container addresses.
 */
const unreachable = (
  setting("JJ_SMOKE_UNREACHABLE") ?? "app:3001,postgres:5432"
)
  .split(",")
  .map((target) => target.trim())
  .filter(Boolean);
/** Tries each target with bash's /dev/tcp; prints `open <target>` for any it reaches. */
const PROBE_COMMAND = `for t in ${unreachable.map((target) => target.replace(":", "/")).join(" ")}; do timeout 3 bash -c "</dev/tcp/$t" 2>/dev/null && echo "open $t"; done; echo probed`;

if ((restartCommand || restoreCommand) && !remoteUrl) {
  console.error(
    "smoke:e2e: JJ_SMOKE_RESTART_COMMAND and JJ_SMOKE_RESTORE_COMMAND need JJ_SMOKE_BASE_URL (a server they can restart).",
  );
  process.exit(2);
}
if (bootDriver !== "local" && bootDriver !== "docker") {
  console.error(
    `smoke:e2e: JJ_SMOKE_DRIVER is local or docker; got "${bootDriver}".`,
  );
  process.exit(2);
}
if (remoteUrl && (setting("JJ_SMOKE_DRIVER") || sandboxImage)) {
  console.error(
    "smoke:e2e: JJ_SMOKE_DRIVER and JJ_SMOKE_SANDBOX_IMAGE set up the server the smoke boots; one at JJ_SMOKE_BASE_URL must run docker already.",
  );
  process.exit(2);
}
if (sandboxImage && bootDriver !== "docker") {
  console.error(
    "smoke:e2e: JJ_SMOKE_SANDBOX_IMAGE needs JJ_SMOKE_DRIVER=docker.",
  );
  process.exit(2);
}
if (taskCapUsd !== undefined) {
  if (remoteUrl) {
    console.error(
      "smoke:e2e: JJ_SMOKE_TASK_CAP_USD caps the server the smoke boots; it cannot change one at JJ_SMOKE_BASE_URL.",
    );
    process.exit(2);
  }
  if (
    !(
      Number.isFinite(taskCapUsd) &&
      taskCapUsd > 0 &&
      taskCapUsd <= MAX_SPEND_CAP_USD
    )
  ) {
    console.error(
      `smoke:e2e: JJ_SMOKE_TASK_CAP_USD must be a positive number of US dollars, at most ${MAX_SPEND_CAP_USD}.`,
    );
    process.exit(2);
  }
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
/** The first spend cap that stopped work no step expected to stop. */
let cappedBy: string | undefined;
/** `GET /api/usage` of the server under test, read before it shuts down. */
let usageReport: UsageReport | undefined;
/** Reads `GET /api/usage` of the server under test, once it is up. */
let readUsage: (() => Promise<UsageReport>) | undefined;

async function step<T>(name: string, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const value = await run();
    steps.push({ name, ok: true, ms: Date.now() - started });
    return value;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (error instanceof SpendCapped) cappedBy ??= error.cap;
    steps.push({ name, ok: false, ms: Date.now() - started, detail });
    throw new StepFailed(`${name}: ${detail}`);
  }
}

class StepFailed extends Error {}

/** A spend cap stopped work that no step expects to stop: the run is over budget. */
class SpendCapped extends Error {
  constructor(readonly cap: string) {
    super(`stopped at a spend cap: ${cap}`);
  }
}

const capNames: Record<SpendScope, string> = {
  task: "The task's spend cap",
  bot: "A bot's daily spend cap",
  instance: "The server's daily spend cap (JJ_MAX_USD_PER_DAY)",
};

/** `spend.capped` as a SpendCapped error. */
function spendCapped(payload: {
  scope: SpendScope;
  spentUsd: number;
  capUsd: number;
}): SpendCapped {
  const shown = formatSpendAgainstCap(payload.spentUsd, payload.capUsd);
  return new SpendCapped(
    `${capNames[payload.scope]}: ${shown.spent} of ${shown.cap} spent.`,
  );
}

/** Throws SpendCapped when a cap stopped a model call of the task since it last reopened. */
function assertNotCapped(view: TaskView): void {
  for (const event of [...view.events].reverse()) {
    if (event.type === "task.reopened") return;
    if (event.type === "spend.capped") throw spendCapped(event.payload);
  }
}

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
    // One driver, so the seeded default profile is that driver's.
    JJ_SANDBOX_DRIVERS: bootDriver,
    JJ_SANDBOX_ROOT: join(dir, "sandbox"),
    JJ_DOCKER_NAMESPACE: dockerNamespace,
    JJ_ENABLE_SCRIPTED_MODEL: realModel ? "false" : "true",
    // Pin the scripted model, so provider keys in the environment do not
    // change which model the keyless smoke runs.
    JJ_DEFAULT_MODEL: realModel ?? "scripted/team",
  };
  const server = await step(`boot the API (PGlite, ${bootDriver} driver)`, () =>
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

/** The server the smoke booted and its directory, for a stop by signal. */
let booted: RunningServer | undefined;
let workDir: string | undefined;

async function main(): Promise<boolean> {
  const dir = await mkdtemp(join(tmpdir(), "jj-smoke-e2e-"));
  workDir = dir;
  let server: RunningServer | undefined;
  try {
    const target = await serverUnderTest(dir);
    server = target.server;
    booted = server;
    const { base, token } = target;
    const headers: Record<string, string> = token
      ? { Authorization: `Bearer ${token}` }
      : {};
    readUsage = async () => {
      const response = await fetch(`${base}/api/usage`, { headers });
      check(
        response.status === 200,
        `GET /api/usage answered ${response.status}`,
      );
      return (await response.json()) as UsageReport;
    };
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
      if (
        result.status !== status &&
        result.body?.error?.code === "SPEND_CAP_REACHED"
      )
        throw new SpendCapped(result.body.error.message);
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

    if (taskCapUsd !== undefined)
      await step(
        `cap every task at ${formatUsd(taskCapUsd)} (the default profile)`,
        async () => {
          const { profiles } = (await expectStatus(
            "GET",
            "/api/runtime-profiles",
            200,
          )) as { profiles: RuntimeProfile[] };
          const profile = profiles.find((entry) => entry.isDefault);
          check(profile, "no default runtime profile");
          const { profile: updated } = await expectStatus(
            "PATCH",
            `/api/runtime-profiles/${profile.id}`,
            200,
            { budgets: { maxUsdPerTask: taskCapUsd } },
          );
          check(
            updated.budgets.maxUsdPerTask === taskCapUsd,
            `maxUsdPerTask ${updated.budgets.maxUsdPerTask}`,
          );
        },
      );

    // On docker, bots run on the default profile, which must be the isolated
    // docker sandbox; the booted server's has no network, which no task here
    // needs (model calls are the server's, not the sandbox's).
    const dockerProfile = onDocker
      ? await step(
          remoteUrl
            ? "docker is the only driver and the default, isolated profile"
            : "docker is the only driver and the default, isolated profile, without network",
          async () => {
            if (!remoteUrl) {
              const { profiles } = (await expectStatus(
                "GET",
                "/api/runtime-profiles",
                200,
              )) as { profiles: RuntimeProfile[] };
              const seeded = profiles.find((entry) => entry.isDefault);
              check(seeded, "no default runtime profile");
              const { profile: updated } = (await expectStatus(
                "PATCH",
                `/api/runtime-profiles/${seeded.id}`,
                200,
                {
                  sandbox: {
                    network: { mode: "none" },
                    ...(sandboxImage ? { image: sandboxImage } : {}),
                  },
                },
              )) as { profile: RuntimeProfile };
              check(
                updated.sandbox.network.mode === "none",
                `network ${JSON.stringify(updated.sandbox.network)}`,
              );
            }
            const { drivers } = await expectStatus(
              "GET",
              "/api/sandbox-drivers",
              200,
            );
            const ids = drivers.map((driver: { id: string }) => driver.id);
            check(
              ids.length === 1 && ids[0] === "docker",
              `registered drivers: ${ids.join(", ")}; expected docker alone`,
            );
            check(drivers[0].available, "the docker driver is not available");
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
    // Its briefs quote the goal's first 300 characters, so directives lead.
    const goal = (directive: string) => {
      check(directive.length < 280, `directives too long: ${directive}`);
      return `${directive}Write two short notes about penguins. Delegate one part to Grace${suffix} and one part to Linus${suffix} at the same time; each writes their notes to a markdown file in the workspace. Then complete the task with a one-paragraph summary.`;
    };
    const { task } = await step("create a task with all three", () =>
      expectStatus("POST", "/api/tasks", 201, {
        goal: goal(
          remoteUrl
            ? `After writing your notes, run \`${WHERE_COMMAND}\` and run \`${PROBE_COMMAND}\`. `
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

    if (token)
      await step(
        "sign in to a cookie session, resume the task's stream on it, sign out",
        () => cookieSession(base, token, task.id, events),
      );

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

    if (remoteUrl && !realModel)
      await step(
        `a sandbox cannot reach ${unreachable.join(", ")}`,
        async () => {
          const probes = events.flatMap((event) =>
            event.type === "tool.finished" &&
            event.payload.summary === PROBE_COMMAND
              ? [event.payload]
              : [],
          );
          check(probes.length >= 2, `${probes.length} network probe(s)`);
          for (const probe of probes) {
            const output = probe.output ?? "";
            check(
              probe.ok && output.trim().endsWith("probed"),
              `the probe did not run: ${JSON.stringify(probe)}`,
            );
            check(
              !output.includes("open "),
              `a sandbox reached ${output.trim()}`,
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

    if (restoreCommand)
      await restoreSurvival({
        base,
        headers,
        expectStatus,
        taskId: task.id,
      });

    // After the backup: CI's restore checks expect it to hold one task's workspace.
    await uploadsInWorkspace({
      base,
      headers,
      expectStatus,
      coordinatorBotId: bots.Ada,
      scripted: !realModel,
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

    await step(
      "stop a task at its spend cap, then continue it once raised",
      async () => {
        // The scripted model's fictional-price variant costs a few tenths of a
        // cent a call, so a $0.002 cap stops the task after its first call.
        const { bot: penny } = await expectStatus("POST", "/api/bots", 201, {
          name: `Penny${suffix}`,
          model: realModel ?? "scripted/team-priced",
          ...(dockerProfile ? { runtimeProfileId: dockerProfile.id } : {}),
        });
        const capUsd = realModel ? 0.0001 : 0.002;
        const { task: capped } = await expectStatus("POST", "/api/tasks", 201, {
          goal: "Write notes-penny.md: run `echo one`, run `echo two`, run `echo three`, one command a turn, then complete the task.",
          title: "Capped notes",
          coordinatorBotId: penny.id,
          spendCapUsd: capUsd,
        });
        check(capped.spendCapUsd === capUsd, `cap ${capped.spendCapUsd}`);
        const deadline = Date.now() + timeoutMs;
        let current: TaskView;
        for (;;) {
          current = await expectStatus("GET", `/api/tasks/${capped.id}`, 200);
          const stopped = current.events.find(
            (event) => event.type === "spend.capped",
          );
          // Only the task's own cap is this step's to reach.
          if (
            stopped?.type === "spend.capped" &&
            stopped.payload.scope !== "task"
          )
            throw spendCapped(stopped.payload);
          if (stopped && current.task.status === "waiting") break;
          check(
            current.task.status !== "completed" &&
              current.task.status !== "failed",
            `the capped task ${current.task.status} without stopping at its cap`,
          );
          check(Date.now() < deadline, `still ${current.task.status}`);
          await sleep(100);
        }
        check(
          current.usage.total.costUsd >= capUsd,
          `spent ${current.usage.total.costUsd} of ${capUsd}`,
        );
        check(
          current.messages
            .at(-1)
            ?.text.startsWith("Stopped: The task reached its spend cap"),
          `last message: ${current.messages.at(-1)?.text}`,
        );
        const refused = await expectStatus(
          "POST",
          `/api/tasks/${capped.id}/messages`,
          409,
          { text: "Carry on." },
        );
        check(
          refused.error.code === "SPEND_CAP_REACHED",
          `refused with ${refused.error.code}`,
        );
        // Raised to the run's own task cap, when it has one.
        await expectStatus("PATCH", `/api/tasks/${capped.id}`, 200, {
          spendCapUsd: taskCapUsd ?? null,
        });
        await expectStatus("POST", `/api/tasks/${capped.id}/messages`, 201, {
          text: "Carry on.",
        });
        for (;;) {
          current = await expectStatus("GET", `/api/tasks/${capped.id}`, 200);
          assertNotCapped(current);
          if (current.task.status === "completed") break;
          check(
            current.task.status !== "failed",
            `the continued task failed: ${current.task.error}`,
          );
          check(Date.now() < deadline, `still ${current.task.status}`);
          await sleep(100);
        }
        const usage = await expectStatus("GET", "/api/usage", 200);
        const spent = usage.bots.find(
          (entry: { botId: string }) => entry.botId === penny.id,
        );
        check(
          spent && spent.last24h.costUsd >= current.usage.total.costUsd - 1e-9,
          `usage report for Penny: ${JSON.stringify(spent)}`,
        );
      },
    );
    await verificationGate({ expectStatus, coordinatorBotId: bots.Ada });

    await step(
      "hold a call for approval, then run it once when approved",
      async () => {
        // A profile like the default one that asks before `git push`.
        const { profiles } = await expectStatus(
          "GET",
          "/api/runtime-profiles",
          200,
        );
        const like =
          dockerProfile ??
          profiles.find((profile: { isDefault: boolean }) => profile.isDefault);
        check(like, "no default profile to copy");
        const { profile } = await expectStatus(
          "POST",
          "/api/runtime-profiles",
          201,
          {
            name: `Guarded${suffix}`,
            sandbox: like.sandbox,
            approvals: [{ tool: "bash", match: "git push" }],
          },
        );
        const { bot: guarded } = await expectStatus("POST", "/api/bots", 201, {
          name: `Gatekeeper${suffix}`,
          runtimeProfileId: profile.id,
          ...(realModel ? { model: realModel } : {}),
        });
        const command = "echo shipped > shipped.txt # git push";
        const { task: held } = await expectStatus("POST", "/api/tasks", 201, {
          goal: `Ship it: run \`${command}\` with bash, then complete the task.`,
          title: "Guarded push",
          coordinatorBotId: guarded.id,
        });
        const deadline = Date.now() + timeoutMs;
        let current: TaskView;
        for (;;) {
          current = await expectStatus("GET", `/api/tasks/${held.id}`, 200);
          if (
            current.task.status === "waiting" &&
            current.approvals.some((approval) => approval.status === "pending")
          )
            break;
          check(
            current.task.status !== "completed" &&
              current.task.status !== "failed",
            `the task ${current.task.status} without holding the call`,
          );
          check(Date.now() < deadline, `still ${current.task.status}`);
          await sleep(100);
        }
        const approval = current.approvals.find(
          (entry) => entry.status === "pending",
        );
        check(approval?.tool === "bash", `held ${approval?.tool}`);
        check(
          !current.events.some(
            (event) =>
              event.type === "tool.started" &&
              event.payload.toolCallId === approval.toolCallId,
          ),
          "the held call started",
        );
        check(
          !current.artifacts.some(
            (artifact) => artifact.path === "shipped.txt",
          ),
          "the held call wrote its file",
        );
        await expectStatus(
          "POST",
          `/api/tasks/${held.id}/approvals/${approval.id}`,
          200,
          { decision: "approve" },
        );
        for (;;) {
          current = await expectStatus("GET", `/api/tasks/${held.id}`, 200);
          if (current.task.status === "completed") break;
          check(
            current.task.status !== "failed",
            `the approved task failed: ${current.task.error}`,
          );
          check(Date.now() < deadline, `still ${current.task.status}`);
          await sleep(100);
        }
        const ran = current.approvals.find((entry) => entry.id === approval.id);
        check(
          ran?.status === "approved" && ran.outcome?.ok === true,
          `approval ${JSON.stringify(ran)}`,
        );
        check(
          current.events.filter(
            (event) =>
              event.type === "tool.finished" &&
              event.payload.toolCallId === approval.toolCallId,
          ).length === 1,
          "the approved call did not run exactly once",
        );
        const file = current.artifacts.find(
          (artifact) => artifact.path === "shipped.txt",
        );
        check(file, "no shipped.txt artifact");
        await download(base, headers, held.id, file);
        const again = await expectStatus(
          "POST",
          `/api/tasks/${held.id}/approvals/${approval.id}`,
          409,
          { decision: "deny" },
        );
        check(
          again.error.code === "APPROVAL_NOT_PENDING",
          `answered again with ${again.error.code}`,
        );
      },
    );

    await step(
      "test a stdio MCP server, pin it, and have a bot call it in its task's sandbox",
      async () => {
        const bootstrap = await expectStatus("GET", "/api/bootstrap", 200);
        check(
          bootstrap.capabilities.mcp?.stdio === true,
          `capabilities.mcp ${JSON.stringify(bootstrap.capabilities.mcp)}`,
        );
        const { profiles } = await expectStatus(
          "GET",
          "/api/runtime-profiles",
          200,
        );
        const like =
          dockerProfile ??
          profiles.find((profile: { isDefault: boolean }) => profile.isDefault);
        check(like, "no default profile to copy");
        // The fixture travels in its args and needs only Node in the sandbox.
        const server = mcpFixture({
          ...(onDocker ? { command: "node" } : {}),
          secretEnv: {},
        });
        const { profile } = await expectStatus(
          "POST",
          "/api/runtime-profiles",
          201,
          { name: `With MCP${suffix}`, sandbox: like.sandbox },
        );
        const { discovery } = await expectStatus(
          "POST",
          `/api/runtime-profiles/${profile.id}/mcp-discoveries`,
          202,
          { server },
        );
        const deadline = Date.now() + timeoutMs;
        let tested = discovery;
        while (tested.status === "queued" || tested.status === "running") {
          check(Date.now() < deadline, `the test is still ${tested.status}`);
          await sleep(100);
          ({ discovery: tested } = await expectStatus(
            "GET",
            `/api/mcp-discoveries/${discovery.id}`,
            200,
          ));
        }
        check(
          tested.status === "succeeded" &&
            tested.snapshot?.configHash === discovery.configHash,
          `discovery ${JSON.stringify(tested)}`,
        );
        await expectStatus(
          "PATCH",
          `/api/runtime-profiles/${profile.id}`,
          200,
          { mcpServers: [{ ...server, snapshotId: tested.snapshot.id }] },
        );
        const { bot: caller } = await expectStatus("POST", "/api/bots", 201, {
          name: `Librarian${suffix}`,
          runtimeProfileId: profile.id,
          ...(realModel ? { model: realModel } : {}),
        });
        const { task } = await expectStatus("POST", "/api/tasks", 201, {
          goal: 'Look the docs up: call `mcp__docs__search {"query":"smoke"}` once, then complete the task with what it found.',
          title: "MCP lookup",
          coordinatorBotId: caller.id,
        });
        let current: TaskView;
        for (;;) {
          current = await expectStatus("GET", `/api/tasks/${task.id}`, 200);
          if (current.task.status === "completed") break;
          check(
            current.task.status !== "failed",
            `the task failed: ${current.task.error}`,
          );
          check(Date.now() < deadline, `still ${current.task.status}`);
          await sleep(100);
        }
        const { events } = await expectStatus(
          "GET",
          `/api/tasks/${task.id}/events`,
          200,
        );
        const states = (events as TaskEvent[]).flatMap((event) =>
          event.type === "mcp.server" ? [event.payload.state] : [],
        );
        check(
          isDeepStrictEqual(states.slice(0, 2), ["starting", "ready"]),
          `mcp.server states ${states.join(", ")}`,
        );
        const answered = (events as TaskEvent[]).find(
          (event) =>
            event.type === "tool.finished" &&
            event.payload.tool === "mcp__docs__search",
        );
        check(
          answered?.type === "tool.finished" &&
            answered.payload.ok &&
            answered.payload.output?.startsWith('Results for "smoke"'),
          `the MCP call ${JSON.stringify(answered?.payload)}`,
        );
      },
    );

    await directChat({
      expectStatus,
      name: `Hopper${suffix}`,
      bot: {
        ...(realModel ? { model: realModel } : {}),
        ...(dockerProfile ? { runtimeProfileId: dockerProfile.id } : {}),
      },
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

    await step("read the spend from /api/usage", async () => {
      usageReport = await readUsage?.();
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
    // A failed run reports what it spent too.
    if (!usageReport && readUsage)
      usageReport = await readUsage().catch(() => undefined);
    await server?.close().catch(() => {});
    if (server && bootDriver === "docker") removeDockerNamespace();
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Removes the booted server's sandbox containers, then its workspace
 * volumes, which the driver keeps for the tasks (containers first, so no
 * volume is in use).
 */
function removeDockerNamespace() {
  const label = `label=jj.sandbox.namespace=${dockerNamespace}`;
  const docker = (args: string[]) =>
    spawnSync("docker", args, { encoding: "utf8", timeout: 20_000 });
  const ids = (args: string[]) =>
    (docker(args).stdout ?? "").split("\n").filter(Boolean);
  const containers = ids(["ps", "-aq", "--filter", label]);
  if (containers.length > 0) docker(["rm", "-f", ...containers]);
  const volumes = ids(["volume", "ls", "-q", "--filter", label]);
  if (volumes.length > 0) docker(["volume", "rm", ...volumes]);
  const left = [
    ...ids(["ps", "-aq", "--filter", label]),
    ...ids(["volume", "ls", "-q", "--filter", label]),
  ];
  if (left.length > 0)
    console.warn(
      `smoke:e2e: could not remove ${left.length} container(s) or volume(s) labelled jj.sandbox.namespace=${dockerNamespace}`,
    );
}

/**
 * Verification plans: a task whose command check fails first completes,
 * verified, once the coordinator fixes the work (the scripted model runs the
 * fix the goal names); a task whose check cannot pass waits for the user and
 * is never completed. On a real model only the first runs, and only its
 * verified completion is checked.
 */
/**
 * Uploads: two files staged as raw bytes (`POST /api/uploads`, the one write
 * that is not JSON, still refused cross-site and as JSON) and attached at
 * creation are in the workspace before the coordinator's first model call,
 * where its first command, `sha256sum uploads/*`, reads exactly those bytes.
 */
async function uploadsInWorkspace(options: {
  base: string;
  headers: Record<string, string>;
  expectStatus: ExpectStatus;
  coordinatorBotId: string;
  scripted: boolean;
}) {
  const { base, headers, expectStatus } = options;
  const files = {
    "table.csv": Buffer.from("id,name\n1,Ada\n2,Grace\n"),
    "blob.bin": Buffer.from([0, 255, 1, 254, 10, 13, 0, 7]),
  };
  const put = (
    name: string,
    body: Uint8Array,
    extra: Record<string, string> = {},
  ) =>
    fetch(`${base}/api/uploads?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/octet-stream",
        ...extra,
      },
      body,
    });
  await step("uploads: refused as JSON and cross-site", async () => {
    const json = await put("a.txt", Buffer.from("{}"), {
      "Content-Type": "application/json",
    });
    check(json.status === 415, `JSON upload answered ${json.status}`);
    const crossSite = await put("a.txt", Buffer.from("x"), {
      "Sec-Fetch-Site": "cross-site",
    });
    check(
      crossSite.status === 403,
      `cross-site upload answered ${crossSite.status}`,
    );
  });
  const staged = await step(
    "uploads: stage two files as raw bytes",
    async () => {
      const ids: string[] = [];
      for (const [name, bytes] of Object.entries(files)) {
        const response = await put(name, bytes);
        const text = await response.text();
        check(response.status === 201, `${name}: ${response.status} ${text}`);
        const { upload } = JSON.parse(text) as {
          upload: { id: string; sha256: string; sizeBytes: number };
        };
        check(
          upload.sha256 === createHash("sha256").update(bytes).digest("hex"),
          `${name}: sha256 ${upload.sha256}`,
        );
        ids.push(upload.id);
      }
      return ids;
    },
  );
  const { task } = await step("uploads: create a task with both", () =>
    expectStatus("POST", "/api/tasks", 201, {
      goal: "Check the uploaded files: run `sha256sum uploads/*` once, then complete the task with what it printed.",
      title: "Uploaded files",
      coordinatorBotId: options.coordinatorBotId,
      uploads: staged.map((uploadId) => ({ uploadId })),
    }),
  );
  const events = await step("uploads: follow the task to its end", () =>
    follow(base, headers, task.id, {
      after: 0,
      reconnect: false,
      until: (event) => event.type === "task.finished",
    }),
  );
  await step(
    "uploads: placed before the first model call, and downloadable",
    async () => {
      const view = (await expectStatus(
        "GET",
        `/api/tasks/${task.id}`,
        200,
      )) as TaskView;
      check(view.task.status === "completed", `status ${view.task.status}`);
      const uploaded = view.artifacts.filter((artifact) => artifact.upload);
      check(
        uploaded.length === 2 &&
          uploaded.every((artifact) => artifact.upload?.state === "placed"),
        `uploads ${JSON.stringify(uploaded.map((artifact) => [artifact.path, artifact.upload]))}`,
      );
      const placed = events.filter(
        (event) => event.type === "artifact.updated",
      );
      const firstCall = events.find((event) => event.type === "model.started");
      check(placed.length === 2, `${placed.length} artifact.updated`);
      check(
        firstCall &&
          placed.every((event) => event.sequence < firstCall.sequence),
        "a model call came before the files were placed",
      );
      const announced = view.messages.find(
        (message) =>
          message.authorKind === "user" && message.intent === "notification",
      );
      check(
        announced?.text ===
          `Uploaded 2 files: uploads/table.csv (${files["table.csv"].length} B), uploads/blob.bin (8 B)`,
        `announcement ${JSON.stringify(announced?.text)}`,
      );
      for (const artifact of uploaded)
        await download(base, headers, task.id, artifact);
      if (!options.scripted) return;
      const sums = events.find(
        (event) =>
          event.type === "tool.finished" &&
          event.payload.summary === "sha256sum uploads/*",
      );
      check(
        sums?.type === "tool.finished" && sums.payload.ok,
        "sha256sum did not run",
      );
      const expected = Object.entries(files)
        .map(
          ([name, bytes]) =>
            `${createHash("sha256").update(bytes).digest("hex")}  uploads/${name}`,
        )
        .sort((a, b) => a.slice(66).localeCompare(b.slice(66)))
        .join("\n");
      check(
        sums.payload.output?.trim() === expected,
        `sha256sum printed ${JSON.stringify(sums.payload.output)}`,
      );
    },
  );
}

async function verificationGate(options: {
  expectStatus: ExpectStatus;
  coordinatorBotId: string;
}) {
  const { expectStatus, coordinatorBotId } = options;
  const settled = async (taskId: string): Promise<TaskView> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const view: TaskView = await expectStatus(
        "GET",
        `/api/tasks/${taskId}`,
        200,
      );
      assertNotCapped(view);
      if (view.task.status !== "queued" && view.task.status !== "running")
        return view;
      check(Date.now() < deadline, `the task is still ${view.task.status}`);
      await sleep(100);
    }
  };
  const checkEvents = async (taskId: string) =>
    (
      (await expectStatus(
        "GET",
        `/api/tasks/${taskId}/events?after=0`,
        200,
      )) as { events: TaskEvent[] }
    ).events.flatMap((event) =>
      event.type === "verification.checked" ? [event.payload.check] : [],
    );

  await step(
    "verification: a failing check is fixed, re-run and the task completes verified",
    async () => {
      const { task } = await expectStatus("POST", "/api/tasks", 201, {
        goal: "Write the word ready to checked.txt in the workspace. If a check fails, fix it with `printf ready > checked.txt`.",
        title: "Checked file",
        coordinatorBotId,
        verificationPlan: [
          {
            id: "ready",
            description: "checked.txt says ready",
            method: "command",
            command: "grep -q ready checked.txt",
          },
          {
            id: "file",
            description: "checked.txt exists",
            method: "file",
            path: "checked.txt",
            expect: "contains",
            value: "ready",
          },
        ],
      });
      const view = await settled(task.id);
      check(
        view.task.status === "completed",
        `status ${view.task.status}: ${view.task.error ?? ""}`,
      );
      const summary = verificationSummary(view.task, view.verificationChecks);
      check(
        isVerified(view.task, summary),
        `not verified: ${JSON.stringify(summary)}`,
      );
      const checks = await checkEvents(task.id);
      if (!realModel) {
        check(
          checks[0]?.outcome === "failed" && checks[0]?.exitCode !== 0,
          `the first check did not fail: ${JSON.stringify(checks[0])}`,
        );
        check(
          checks.at(-1)?.outcome === "passed" && checks.at(-1)?.attempt === 2,
          `the last check: ${JSON.stringify(checks.at(-1))}`,
        );
      }
      const { tasks } = await expectStatus("GET", "/api/tasks", 200);
      const listed = (tasks as TaskSummary[]).find(
        (entry) => entry.id === task.id,
      );
      check(
        listed?.verification?.state === "passed",
        `summary ${JSON.stringify(listed?.verification)}`,
      );
    },
  );

  if (realModel) return;
  await step(
    "verification: a check that cannot pass leaves the task waiting, unverified",
    async () => {
      const { task } = await expectStatus("POST", "/api/tasks", 201, {
        goal: "Write a short note about penguins.",
        title: "Never verified",
        coordinatorBotId,
        verificationPlan: [
          {
            id: "never",
            description: "never-created.txt exists",
            method: "command",
            command: "test -f never-created.txt",
          },
        ],
      });
      const view = await settled(task.id);
      check(view.task.status === "waiting", `status ${view.task.status}`);
      check(view.task.result === null, "a result was recorded");
      const summary = verificationSummary(view.task, view.verificationChecks);
      check(
        summary?.state === "failed" && !isVerified(view.task, summary),
        `summary ${JSON.stringify(summary)}`,
      );
      check(
        view.events.every((event) => event.type !== "task.finished"),
        "the task finished",
      );
    },
  );
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
  taskId: string | null;
}

/**
 * Direct chat with a bot of its own: a request for a file creates one task,
 * the bot tells the user when it completes (an update with the task's card),
 * answers "how did it go?", and a follow-up continues the same task (reopened,
 * same coordinator session). On a real model only the structure is checked.
 */
async function directChat(options: {
  expectStatus: ExpectStatus;
  name: string;
  bot: Record<string, string>;
}) {
  const { expectStatus } = options;
  const botId = await step(
    `create ${options.name} for direct chat`,
    async () => {
      const { bot } = await expectStatus("POST", "/api/bots", 201, {
        name: options.name,
        ...options.bot,
      });
      return bot.id as string;
    },
  );
  /** The conversation once it holds `count` replies and the bot is idle. */
  const replies = async (count: number): Promise<ChatMessage[]> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const view = await expectStatus(
        "GET",
        `/api/bots/${botId}/messages`,
        200,
      );
      const messages = view.messages as ChatMessage[];
      const answered = messages.filter((m) => m.role === "assistant").length;
      if (answered >= count && !view.replying) return messages;
      // A reply a spend cap refused (worker/chat-reply.ts words it so).
      if (
        !view.replying &&
        view.lastReplyError?.message.startsWith("Not answered:")
      )
        throw new SpendCapped(view.lastReplyError.message);
      check(
        !view.lastReplyError || view.replying,
        `reply failed: ${view.lastReplyError?.message}`,
      );
      check(Date.now() < deadline, `${answered} of ${count} replies`);
      await sleep(100);
    }
  };
  const say = (text: string) =>
    expectStatus("POST", `/api/bots/${botId}/messages`, 201, { text });
  const taskView = (taskId: string): Promise<TaskView> =>
    expectStatus("GET", `/api/tasks/${taskId}`, 200);
  const untilCompleted = async (taskId: string, runs: number) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const view = await taskView(taskId);
      assertNotCapped(view);
      const root = view.sessions.find((s) => s.parentSessionId === null);
      if (view.task.status === "completed" && (root?.runCount ?? 0) >= runs)
        return view;
      check(
        view.task.status !== "failed" && view.task.status !== "cancelled",
        `the chat's task ${view.task.status}: ${view.task.error}`,
      );
      check(Date.now() < deadline, `the chat's task is ${view.task.status}`);
      await sleep(100);
    }
  };

  const taskId = await step(
    "direct chat: a request for a file creates one task",
    async () => {
      // A task is for work that needs commands or files (the chat prompt);
      // a real model writes a plain note in the chat itself, without one.
      await say("Please write a short note about penguins in penguins.md.");
      const messages = await replies(1);
      const taskId = messages.find((m) => m.role === "assistant")?.taskId;
      check(taskId, "the reply links no task");
      return taskId;
    },
  );
  await step(
    "direct chat: the bot tells the result, with the task card",
    async () => {
      const view = await untilCompleted(taskId, 1);
      const messages = await replies(2);
      const update = messages.filter((m) => m.role === "assistant")[1];
      check(update?.taskId === taskId, "the update links no task");
      if (!realModel)
        check(
          update.text.startsWith(
            `Update on "${view.task.title}": it completed.`,
          ),
          `update: ${update.text}`,
        );
    },
  );
  await step("direct chat: answers how it went from the result", async () => {
    await say("How did it go?");
    const messages = await replies(3);
    const answer = messages.at(-1);
    check(answer?.role === "assistant" && answer.text.trim(), "no answer");
    if (!realModel)
      check(
        answer.text.includes("is completed. Result:"),
        `answer: ${answer.text}`,
      );
  });
  await step("direct chat: a follow-up continues the same task", async () => {
    const before = await taskView(taskId);
    const root = before.sessions.find((s) => s.parentSessionId === null);
    await say("Please also add a line about their diet to the task.");
    const messages = await replies(4);
    check(messages.at(-1)?.taskId === taskId, "the follow-up went elsewhere");
    const after = await untilCompleted(taskId, 2);
    check(
      after.events.some((event) => event.type === "task.reopened"),
      "no task.reopened event",
    );
    const sameRoot = after.sessions.find((s) => s.parentSessionId === null);
    check(sameRoot?.id === root?.id, "a new coordinator session");
    // The second completion is told too.
    const told = await replies(5);
    check(told.at(-1)?.taskId === taskId, "the second update links no task");
    const { tasks } = await expectStatus("GET", "/api/tasks", 200);
    const own = (tasks as { coordinatorBotId: string }[]).filter(
      (task) => task.coordinatorBotId === botId,
    );
    check(own.length === 1, `${own.length} tasks created from chat`);
  });
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
    // The same token still opens the API: a generated one is kept, not renewed.
    if (headers.Authorization) {
      const anonymous = await fetch(`${base}/api/bootstrap`);
      check(
        anonymous.status === 401,
        `no token after restart: ${anonymous.status}`,
      );
      await expectStatus("GET", "/api/bootstrap", 200);
    }
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

  await step("the stop interrupted the running commands", async () => {
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
      // Still running when the drain timed out, the command was interrupted
      // as a lost lease interrupts one: the next process reports it with an
      // unknown outcome and closes the run as interrupted by the restart.
      check(
        event.type === "tool.finished" &&
          !event.payload.ok &&
          event.payload.interrupted === "unknown",
        `the slow command was not reported as cut off: ${JSON.stringify(event.payload)}`,
      );
      const after = events.filter(
        (other) =>
          other.sessionId === event.sessionId &&
          other.sequence > event.sequence,
      );
      const interrupted = after.find((other) => other.type === "run.finished");
      check(
        interrupted?.type === "run.finished" &&
          interrupted.payload.outcome === "failed" &&
          interrupted.payload.error?.startsWith(
            "Interrupted by a worker restart",
          ),
        `session ${event.sessionId}'s run was not closed as interrupted by the restart: ${JSON.stringify(interrupted?.payload)}`,
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

  await step(
    "files written before the restart are there after it",
    async () => {
      const written = events.filter(
        (event) =>
          event.type === "tool.finished" &&
          event.payload.tool === "write" &&
          event.payload.ok &&
          event.sequence <= cut,
      );
      check(
        written.length >= 2,
        `${written.length} file(s) written before the restart`,
      );
      for (const write of written) {
        if (write.type !== "tool.finished") continue;
        const path = write.payload.summary;
        const listing = events.find(
          (event) =>
            event.type === "tool.finished" &&
            event.sessionId === write.sessionId &&
            event.payload.summary === "ls -la" &&
            event.sequence > cut,
        );
        check(
          listing?.type === "tool.finished" &&
            listing.payload.output?.includes(path),
          `${path} is missing from the workspace after the restart: ${JSON.stringify(listing?.type === "tool.finished" ? listing.payload.output : null)}`,
        );
      }
    },
  );

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

/** What the API answers about every record, for comparing across a restore. */
async function everything(
  base: string,
  headers: Record<string, string>,
  expectStatus: ExpectStatus,
) {
  const { bots } = await expectStatus("GET", "/api/bots", 200);
  const { profiles } = await expectStatus("GET", "/api/runtime-profiles", 200);
  const { tasks } = (await expectStatus("GET", "/api/tasks", 200)) as {
    tasks: TaskSummary[];
  };
  const views: Record<string, unknown> = {};
  for (const summary of tasks) {
    const view: TaskView = await expectStatus(
      "GET",
      `/api/tasks/${summary.id}`,
      200,
    );
    for (const artifact of view.artifacts)
      await download(base, headers, summary.id, artifact);
    views[summary.id] = {
      view,
      events: await allEvents(base, headers, summary.id),
    };
  }
  return { bots, profiles, tasks, views };
}

/**
 * Backup survival: record every record the API serves, back the stack up,
 * wipe and restore it with JJ_SMOKE_RESTORE_COMMAND, and check that the same
 * token reads every record back unchanged; then continue the restored task
 * with a plan whose checks find its files in the restored workspace, byte
 * for byte, so the task completes verified.
 */
async function restoreSurvival(options: {
  base: string;
  headers: Record<string, string>;
  expectStatus: ExpectStatus;
  taskId: string;
}) {
  const { base, headers, expectStatus, taskId } = options;
  const before = await step("record every record before the backup", () =>
    everything(base, headers, expectStatus),
  );

  await step(`back up, wipe and restore: ${restoreCommand}`, async () => {
    const result = spawnSync(restoreCommand as string, {
      shell: true,
      stdio: "inherit",
      timeout: 600_000,
    });
    check(
      result.status === 0,
      `exited with ${result.status ?? result.signal ?? result.error?.message}`,
    );
    await untilReady(base, 180_000);
    if (headers.Authorization) {
      const anonymous = await fetch(`${base}/api/bootstrap`);
      check(
        anonymous.status === 401,
        `no token after the restore: ${anonymous.status}`,
      );
    }
  });

  await step(
    "every bot, profile, task, event and artifact reads back the same",
    async () => {
      const after = await everything(base, headers, expectStatus);
      for (const part of ["bots", "profiles", "tasks"] as const)
        check(
          isDeepStrictEqual(after[part], before[part]),
          `the restored ${part} differ: ${JSON.stringify(after[part])} != ${JSON.stringify(before[part])}`,
        );
      for (const [id, recorded] of Object.entries(before.views))
        check(
          isDeepStrictEqual(after.views[id], recorded),
          `the restored task ${id} differs from its backup`,
        );
    },
  );

  await step(
    "the restored task continues, verified on the files in its restored workspace",
    async () => {
      const view: TaskView = await expectStatus(
        "GET",
        `/api/tasks/${taskId}`,
        200,
      );
      const files = view.artifacts.filter(
        (artifact) => artifact.kind === "file" && artifact.path,
      );
      check(files.length >= 2, `${files.length} file artifact(s)`);
      await expectStatus("POST", `/api/tasks/${taskId}/messages`, 201, {
        text: "Check that the notes came through the restore.",
        observedGoalVersion: view.task.goalVersion,
        verificationPlan: files.map((artifact, index) => ({
          id: `restored-${index + 1}`,
          description: `${artifact.path} is as it was before the backup`,
          method: "command",
          command: `printf '%s  %s\\n' ${artifact.sha256} '${artifact.path}' | sha256sum -c -`,
        })),
      });
      const deadline = Date.now() + timeoutMs;
      let current: TaskView;
      for (;;) {
        current = await expectStatus("GET", `/api/tasks/${taskId}`, 200);
        if (
          current.task.goalVersion > view.task.goalVersion &&
          current.task.status !== "queued" &&
          current.task.status !== "running"
        )
          break;
        check(Date.now() < deadline, `still ${current.task.status}`);
        await sleep(100);
      }
      const summary = verificationSummary(
        current.task,
        current.verificationChecks,
      );
      check(
        current.task.status === "completed" &&
          isVerified(current.task, summary),
        `status ${current.task.status}, verification ${JSON.stringify(summary)}: ${JSON.stringify(current.verificationChecks.map((entry) => entry.detail ?? entry.outputPreview))}`,
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
          // A task a spend cap stopped would never finish.
          if (event.type === "spend.capped") throw spendCapped(event.payload);
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

/**
 * Signs in with the token as the web app does, and checks the session: its
 * cookie's name and flags for the base URL's scheme (HSTS too over https),
 * the task stream resumed on the cookie from the middle with
 * `Last-Event-ID`, a cookie write without the app's Origin refused, and
 * signing out ending it.
 */
async function cookieSession(
  base: string,
  token: string,
  taskId: string,
  events: TaskEvent[],
): Promise<void> {
  const https = new URL(base).protocol === "https:";
  const origin = new URL(base).origin;
  const json = { "Content-Type": "application/json" };
  const login = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { ...json, Origin: origin },
    body: JSON.stringify({ token }),
  });
  check(login.status === 200, `sign-in answered ${login.status}`);
  const setCookie = login.headers.get("Set-Cookie") ?? "";
  const name = https ? "__Host-jj_session" : "jj_session";
  check(setCookie.startsWith(`${name}=`), `cookie ${setCookie.split("=")[0]}`);
  const flags = setCookie.split(";").map((part) => part.trim());
  for (const flag of ["Path=/", "HttpOnly", "SameSite=Strict"])
    check(flags.includes(flag), `the cookie lacks ${flag}`);
  check(
    flags.includes("Secure") === https,
    `Secure over ${new URL(base).protocol}`,
  );
  if (https)
    check(
      login.headers.get("Strict-Transport-Security"),
      "no Strict-Transport-Security over https",
    );
  const cookie = { Cookie: setCookie.split(";")[0] as string };
  const state = (await (
    await fetch(`${base}/api/auth/session`, { headers: cookie })
  ).json()) as { authenticated: boolean; via: string };
  check(
    state.authenticated && state.via === "cookie",
    `session ${JSON.stringify(state)}`,
  );
  const middle = events[Math.floor(events.length / 2)]?.sequence ?? 0;
  const last = events.at(-1)?.sequence ?? 0;
  const replayed = await follow(base, cookie, taskId, {
    after: middle,
    reconnect: false,
    until: (event) => event.sequence >= last,
  });
  check(
    isDeepStrictEqual(
      replayed,
      events.filter((event) => event.sequence > middle),
    ),
    "the stream resumed on the cookie differs from the first one",
  );
  const forged = await fetch(`${base}/api/bots`, {
    method: "POST",
    headers: { ...json, ...cookie },
    body: JSON.stringify({ name: "Forged" }),
  });
  check(
    forged.status === 403,
    `a cookie write without Origin: ${forged.status}`,
  );
  const out = await fetch(`${base}/api/auth/logout`, {
    method: "POST",
    headers: { ...json, ...cookie, Origin: origin },
  });
  check(out.status === 204, `sign-out answered ${out.status}`);
  const after = await fetch(`${base}/api/bootstrap`, { headers: cookie });
  check(after.status === 401, `a signed-out cookie: ${after.status}`);
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

/** Prints the steps and the spend, writes JJ_SMOKE_REPORT, and exits. */
function finish(ok: boolean, code = ok ? 0 : 1): never {
  const durationMs = Date.now() - started;
  const spent = usageReport?.instance.last24h;
  const dailyCap = usageReport?.instance.capUsdPerDay ?? null;
  console.log(
    `\nsmoke:e2e (${realModel ?? "scripted/team"}${remoteUrl ? ` at ${remoteUrl}` : ""}): ${ok ? "passed" : "FAILED"} in ${(durationMs / 1000).toFixed(1)} s`,
  );
  for (const entry of steps)
    console.log(
      `  ${entry.ok ? "ok  " : "FAIL"} ${entry.name} (${entry.ms} ms)${entry.detail ? `\n       ${entry.detail}` : ""}`,
    );
  if (spent)
    console.log(
      `  spent ${formatUsd(spent.costUsd)} in ${spent.modelCalls} model call(s) in the server's last 24 hours${dailyCap === null ? "" : `, of its ${formatUsd(dailyCap)} daily cap`}${spent.unpricedCalls > 0 ? `; ${spent.unpricedCalls} call(s) had no listed price` : ""}`,
    );
  if (cappedBy) console.log(`  stopped at a spend cap: ${cappedBy}`);
  if (reportPath)
    writeFileSync(
      reportPath,
      `${JSON.stringify(
        {
          test: "e2e",
          status: ok ? "passed" : "failed",
          model: realModel ?? "scripted/team",
          // Where the model's commands ran; a deployed server is checked to be docker.
          driver: remoteUrl ? "docker" : bootDriver,
          durationMs,
          steps,
          usage: spent ?? null,
          capUsdPerDay: dailyCap,
          taskCapUsd: taskCapUsd ?? null,
          ...(cappedBy ? { capped: cappedBy } : {}),
        },
        null,
        2,
      )}\n`,
    );
  process.exit(code);
}

// Stopped from outside (the nightly's timeout, Ctrl+C): stop the booted
// server, remove its docker namespace and directory, and still report the
// steps and the spend, within the nightly's 30 s before SIGKILL.
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    console.error(`\nsmoke:e2e: ${signal}, stopping the server it booted`);
    const within = <T>(ms: number, work: Promise<T>) =>
      Promise.race([work, sleep(ms).then(() => undefined)]);
    void (async () => {
      steps.push({ name: `stopped by ${signal}`, ok: false, ms: 0 });
      if (!usageReport && readUsage)
        usageReport = await within(
          3_000,
          readUsage().catch(() => undefined),
        );
      await within(
        10_000,
        booted?.close().catch(() => {}) ?? Promise.resolve(),
      );
      if (booted && bootDriver === "docker") removeDockerNamespace();
      if (workDir)
        await rm(workDir, { recursive: true, force: true }).catch(() => {});
      finish(false, signal === "SIGINT" ? 130 : 143);
    })();
  });

finish(await main());
