import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DOCKER_BASE_IMAGE, DockerSandboxDriver } from "@jj/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDriverRegistry } from "./drivers";
import { type Brain, said } from "./testing/fake-executor";
import {
  OPEN_TIMEOUT,
  openTestDatabase,
  type TestDatabase,
  type TestEngine,
  testEngine,
  untilTask,
} from "./testing/harness";
import {
  createTeam,
  delegatingCoordinator,
  lastResult,
} from "./testing/scenarios";

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
});
