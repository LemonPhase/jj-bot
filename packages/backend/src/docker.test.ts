import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { McpDiscoverer } from "@jj/runtime";
import { DOCKER_BASE_IMAGE, DockerSandboxDriver } from "@jj/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDriverRegistry } from "./drivers";
import { REDACTED } from "./redact";
import { createKeyring } from "./secrets/keyring";
import { SecretStore } from "./secrets/store";
import { type Brain, said } from "./testing/fake-executor";
import {
  OPEN_TIMEOUT,
  openTestDatabase,
  recordingDriver,
  type TestDatabase,
  type TestEngine,
  testEngine,
  until,
  untilTask,
} from "./testing/harness";
import { mcpFixture } from "./testing/mcp-fixture";
import {
  createTeam,
  delegatingCoordinator,
  lastResult,
} from "./testing/scenarios";
import { placementScenario } from "./testing/uploads";

// The docker variant of the shared-workspace scenario. Skips without a
// reachable daemon. Image: JJ_SANDBOX_TEST_IMAGE, else jj-sandbox:base-1 when
// built, else node:22-bookworm-slim (as in the driver's own tests).
const run = promisify(execFile);
const runId = `${process.pid}-${Date.now().toString(36)}`;
const labels = { "jj.test-run": runId };
const health = await new DockerSandboxDriver().probe();
const hasImage = async (name: string) =>
  run("docker", ["image", "inspect", name]).then(
    () => true,
    () => false,
  );
const image =
  process.env.JJ_SANDBOX_TEST_IMAGE?.trim() ||
  (health.ok && (await hasImage(DOCKER_BASE_IMAGE))
    ? DOCKER_BASE_IMAGE
    : "node:22-bookworm-slim");

let db: TestDatabase;
let current: TestEngine | undefined;

describe.skipIf(!health.ok)("docker driver", () => {
  beforeAll(async () => {
    db = await openTestDatabase();
  }, OPEN_TIMEOUT);
  afterAll(async () => {
    await current?.dispose();
    await db?.close();
    // Task workspaces outlive their containers; remove this run's volumes.
    const { stdout } = await run("docker", [
      "volume",
      "ls",
      "-q",
      "--filter",
      `label=jj.test-run=${runId}`,
    ]).catch(() => ({ stdout: "" }));
    const volumes = stdout.split("\n").filter(Boolean);
    if (volumes.length > 0)
      await run("docker", ["volume", "rm", "-f", ...volumes]).catch(() => {});
  });

  it("runs two bots in one isolated task container that shares their files", async () => {
    process.env.JJ_ENGINE_TEST_SECRET = "host-only-value";
    const docker = new DockerSandboxDriver({
      namespace: `jj-engine-${runId}`,
      labels,
      killGraceMs: 300,
    });
    current = await testEngine(db.database, {
      registry: createDriverRegistry([{ driver: docker, label: "Docker" }]),
    });
    const { engine, executor } = current;
    const { profile } = await engine.profiles.create({
      name: "Docker test",
      sandbox: {
        driver: "docker",
        image,
        network: { mode: "none" },
        resources: { cpus: 1, memoryMb: 512 },
      },
      isDefault: true,
    });
    expect(profile.status).toMatchObject({
      driverAvailable: true,
      isolated: true,
    });
    const team = await createTeam(engine, ["Ada", "Bob", "Cy"]);
    const [ada, bob, cy] = team.names as [string, string, string];
    const worker =
      (me: string, other: string): Brain =>
      (view) => {
        switch (said.turns(view)) {
          case 0:
            return {
              calls: [
                {
                  name: "bash",
                  args: { command: `echo from-${me} > ${me}.txt` },
                },
              ],
            };
          case 1:
            return { calls: [{ name: "gate", args: { name: me } }] };
          case 2:
            return {
              calls: [
                {
                  name: "bash",
                  args: {
                    command: `cat ${other}.txt; env | grep -c JJ_ENGINE_TEST_SECRET || true`,
                  },
                },
              ],
            };
          default:
            return {
              text: lastResult(view)?.text.trim().replace(/\s+/g, " ") ?? "",
            };
        }
      };
    executor
      .brain(ada, delegatingCoordinator([bob, cy]))
      .brain(bob, worker(bob, cy))
      .brain(cy, worker(cy, bob));
    const { task } = await engine.tasks.create({
      goal: "Write two files in docker",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    await Promise.all([executor.gate(bob).reached, executor.gate(cy).reached]);
    executor.gate(bob).open();
    executor.gate(cy).open();
    const view = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed",
      "the docker task",
      60_000,
    );
    const result = (bot: string) =>
      view.sessions.find((s) => s.botId === team.byName[bot])?.result;
    // Each saw the other's file, and none saw the host environment.
    expect(result(bob)).toBe(`from-${cy} 0`);
    expect(result(cy)).toBe(`from-${bob} 0`);
    expect(
      new Set(executor.inputs.map((input) => input.sandbox.driverId)),
    ).toEqual(new Set(["docker"]));
    expect(new Set(executor.inputs.map((input) => input.sandbox.id)).size).toBe(
      1,
    );
    expect(view.artifacts.map((a) => a.path).sort()).toEqual([
      `${bob}.txt`,
      `${cy}.txt`,
    ]);
  }, 120_000);

  it("gives a granted secret to every command in the task container, never to its configuration, and redacts it", async () => {
    await current?.dispose();
    const token = `ghp_docker${randomBytes(12).toString("hex")}`;
    const docker = new DockerSandboxDriver({
      namespace: `jj-engine-${runId}`,
      labels,
      killGraceMs: 300,
    });
    current = await testEngine(db.database, {
      registry: createDriverRegistry([{ driver: docker, label: "Docker" }]),
      secretStore: new SecretStore({
        db: db.database.db,
        keyring: createKeyring(randomBytes(32)),
      }),
    });
    const { engine, executor } = current;
    await engine.secrets.put("GITHUB_TOKEN", { value: token });
    const { profile } = await engine.profiles.create({
      name: "Docker with a token",
      sandbox: {
        driver: "docker",
        image,
        network: { mode: "none" },
        resources: { cpus: 1, memoryMb: 512 },
      },
      secrets: ["GITHUB_TOKEN"],
    });
    const team = await createTeam(engine, ["Dee"]);
    const [dee] = team.names as [string];
    await engine.bots.update(team.byName[dee] as string, {
      runtimeProfileId: profile.id,
    });
    let containerEnv = "";
    executor.brain(dee, async (view) => {
      switch (said.turns(view)) {
        case 0:
          return {
            calls: [
              {
                name: "bash",
                args: {
                  command:
                    'echo "$GITHUB_TOKEN"; printf %s "$GITHUB_TOKEN" | sha256sum',
                },
              },
            ],
          };
        case 1: {
          // The container's own configuration does not hold it.
          const { stdout } = await run("docker", [
            "ps",
            "-q",
            "--filter",
            `label=jj.test-run=${runId}`,
          ]);
          for (const id of stdout.split("\n").filter(Boolean))
            containerEnv += (
              await run("docker", [
                "inspect",
                "--format",
                "{{json .Config.Env}}",
                id,
              ])
            ).stdout;
          return {
            calls: [
              {
                name: "complete_task",
                args: { result: lastResult(view)?.text ?? "" },
              },
            ],
          };
        }
        default:
          return { text: "Done." };
      }
    });
    const { task } = await engine.tasks.create({
      goal: "Use the token in docker",
      coordinatorBotId: team.byName[dee] as string,
    });
    const view = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed" || v.task.status === "failed",
      "the docker task",
      60_000,
    );
    expect(view.task.status).toBe("completed");
    const digest = createHash("sha256").update(token).digest("hex");
    expect(view.task.result).toContain(REDACTED);
    expect(view.task.result).toContain(digest);
    expect(view.task.result).not.toContain(token);
    expect(containerEnv).not.toBe("");
    expect(containerEnv).not.toContain(token);
  }, 120_000);

  it("runs a plan's command checks in the task's container, not on the host", async () => {
    process.env.JJ_ENGINE_TEST_SECRET = "host-only-value";
    const docker = new DockerSandboxDriver({
      namespace: `jj-engine-${runId}-v`,
      labels,
      killGraceMs: 300,
    });
    await current?.dispose();
    current = await testEngine(db.database, {
      registry: createDriverRegistry([{ driver: docker, label: "Docker" }]),
    });
    const { engine, executor } = current;
    await engine.profiles.create({
      name: "Docker checks",
      sandbox: {
        driver: "docker",
        image,
        network: { mode: "none" },
        resources: { cpus: 1, memoryMb: 512 },
      },
      isDefault: true,
    });
    const team = await createTeam(engine, ["Vera"]);
    const [vera] = team.names as [string];
    executor.brain(vera, (view) => {
      const last = view.messages.at(-1);
      if (last?.role === "tool" && last.name === "complete_task")
        return { text: "Done." };
      return said.turns(view) === 0
        ? {
            calls: [
              { name: "bash", args: { command: "echo inside > out.txt" } },
            ],
          }
        : { calls: [{ name: "complete_task", args: { result: "out.txt" } }] };
    });
    const { task } = await engine.tasks.create({
      goal: "Write out.txt in docker",
      coordinatorBotId: team.byName[vera] as string,
      verificationPlan: [
        {
          id: "container",
          description: "Runs in the task container with the agent's file",
          method: "command",
          command:
            'test -f /.dockerenv && test "$(pwd)" = /workspace && ! env | grep -q JJ_ENGINE_TEST_SECRET && cat out.txt',
        },
      ],
    });
    const view = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed" || v.task.status === "waiting",
      "the checked docker task",
      60_000,
    );
    expect(view.task.status).toBe("completed");
    expect(view.verificationChecks).toMatchObject([
      { outcome: "passed", exitCode: 0, output: "inside\n" },
    ]);
  }, 120_000);

  it("places uploads in the task container before the first model call, replacing a symlink and failing a directory in the way", async () => {
    const docker = new DockerSandboxDriver({
      namespace: `jj-engine-${runId}-u`,
      labels,
      killGraceMs: 300,
    });
    await current?.dispose();
    current = await testEngine(db.database, {
      registry: createDriverRegistry([{ driver: docker, label: "Docker" }]),
    });
    const { engine, executor } = current;
    await engine.profiles.create({
      name: "Docker uploads",
      sandbox: {
        driver: "docker",
        image,
        network: { mode: "none" },
        resources: { cpus: 1, memoryMb: 512 },
      },
      isDefault: true,
    });
    await placementScenario(engine, executor);
  }, 120_000);

  it("discovers a stdio MCP server in an ephemeral container it removes, also when the server fails", async () => {
    await current?.dispose();
    const token = `docs-docker-${randomBytes(12).toString("hex")}`;
    const namespace = `jj-mcp-${runId}`;
    const docker = recordingDriver(
      new DockerSandboxDriver({ namespace, labels, killGraceMs: 300 }),
    );
    current = await testEngine(db.database, {
      registry: createDriverRegistry([
        { driver: docker.driver, label: "Docker" },
      ]),
      secretStore: new SecretStore({
        db: db.database.db,
        keyring: createKeyring(randomBytes(32)),
      }),
      mcp: new McpDiscoverer({ env: {}, closeGraceMs: 300 }),
    });
    const { engine } = current;
    await engine.secrets.put("DOCS_SECRET", { value: token });
    const { profile } = await engine.profiles.create({
      name: "Docker MCP",
      sandbox: {
        driver: "docker",
        image,
        network: { mode: "none" },
        resources: { cpus: 1, memoryMb: 512 },
      },
      secrets: ["DOCS_SECRET"],
    });
    const discover = async (mode?: "crash") => {
      const { discovery } = await engine.mcp.startDiscovery(profile.id, {
        server: mcpFixture({ command: "node", ...(mode ? { mode } : {}) }),
      });
      return until(
        async () => {
          const { discovery: now } = await engine.mcp.discovery(discovery.id);
          return now.status === "succeeded" || now.status === "failed"
            ? now
            : undefined;
        },
        { what: "the docker discovery", timeoutMs: 90_000 },
      );
    };

    const found = await discover();
    expect(found.error).toBeNull();
    expect(found.snapshot?.tools.map((tool) => tool.description)).toEqual([
      "Calls the docs API with [redacted].",
      `Searches the docs (a token of ${token.length} characters).`,
    ]);
    const crashed = await discover("crash");
    expect(crashed).toMatchObject({
      status: "failed",
      stderrTail: "fatal: the docs API refused [redacted]",
    });
    // Two containers of their own, ephemeral, each released and removed.
    expect(docker.acquired).toMatchObject([
      { spec: { workspace: "ephemeral" }, released: true },
      { spec: { workspace: "ephemeral" }, released: true },
    ]);
    const { stdout } = await run("docker", [
      "ps",
      "-aq",
      "--filter",
      `label=jj.test-run=${runId}`,
      "--filter",
      `name=${namespace}`,
    ]);
    expect(stdout.trim()).toBe("");
    const volumes = await run("docker", [
      "volume",
      "ls",
      "-q",
      "--filter",
      `name=${namespace}-ephemeral`,
    ]);
    expect(volumes.stdout.trim()).toBe("");
    expect(JSON.stringify([found, crashed])).not.toContain(token);
  }, 180_000);
});
