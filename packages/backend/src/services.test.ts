import {
  bootstrapSchema,
  modelsViewSchema,
  runtimeProfileSchema,
  sandboxDriverInfoSchema,
  taskSummarySchema,
  type WorkspaceHint,
} from "@jj/contracts";
import { LocalSandboxDriver } from "@jj/sandbox";
import { assertSpecSupported, sandboxSpecSchema } from "@jj/sandbox/contract";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDriverRegistry } from "./drivers";
import { DomainError } from "./errors";
import type { EngineDriver } from "./ports";
import { FakeModels } from "./testing/fakes";
import {
  OPEN_TIMEOUT,
  openTestDatabase,
  type TestDatabase,
  type TestEngine,
  testEngine,
  until,
  untilTask,
} from "./testing/harness";
import { createTeam, uniqueNameFor } from "./testing/scenarios";

let db: TestDatabase;
const opened: TestEngine[] = [];

beforeAll(async () => {
  db = await openTestDatabase();
}, OPEN_TIMEOUT);
afterEach(async () => {
  for (const engine of opened.splice(0)) await engine.dispose();
});
afterAll(async () => {
  await db?.close();
});

async function setup(
  options: Parameters<typeof testEngine>[1] = {},
  database = db,
) {
  const engine = await testEngine(database.database, options);
  opened.push(engine);
  return engine;
}

async function refusal(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(DomainError);
  return error as DomainError;
}

/** An isolating driver that is not reachable: like docker on a machine without it. */
function fakeDocker(ok: boolean): EngineDriver {
  const driver: EngineDriver = {
    id: "docker",
    capabilities: {
      networkModes: ["none", "allowlist", "open"],
      resourceLimits: true,
      filesystemIsolation: true,
      exposePort: false,
      snapshot: false,
      metrics: false,
    },
    validateSpec(spec) {
      const parsed = sandboxSpecSchema.parse(spec);
      assertSpecSupported(driver, parsed);
      return parsed;
    },
    probe: async () =>
      ok ? { ok: true } : { ok: false, detail: "Docker is not reachable" },
    acquire: () => Promise.reject(new Error("Docker is not reachable")),
  };
  return driver;
}

describe("bootstrap", () => {
  it("reports real capabilities only", async () => {
    const { engine } = await setup({
      start: false,
      drivers: [{ driver: fakeDocker(false), label: "Docker" }],
      config: { persistence: false },
    });
    const boot = bootstrapSchema.parse(await engine.bootstrap());
    expect(boot.mode).toBe("backend");
    expect(boot.capabilities).toEqual({
      agentExecution: true,
      persistence: false,
      streaming: true,
      verification: false,
      drivers: [
        { id: "local", available: true, isolated: false },
        { id: "docker", available: false, isolated: true },
      ],
    });
    expect(boot.defaultModel).toBe("fake/model");
    const drivers = await engine.drivers();
    for (const info of drivers.drivers) sandboxDriverInfoSchema.parse(info);
    expect(drivers.drivers.find((d) => d.id === "docker")?.detail).toBe(
      "Docker is not reachable",
    );

    const keyless = await setup({
      start: false,
      models: new FakeModels(false),
    });
    const bare = await keyless.engine.bootstrap();
    expect(bare.capabilities.agentExecution).toBe(false);
    expect(bare.capabilities.persistence).toBe(true);
    expect(bare.defaultModel).toBeNull();
    modelsViewSchema.parse(keyless.engine.models());
    const team = await createTeam(engine, ["Ada"]);
    expect(
      (
        await refusal(
          keyless.engine.tasks.create({
            goal: "x",
            coordinatorBotId: team.ids[0] as string,
          }),
        )
      ).code,
    ).toBe("MODEL_NOT_CONFIGURED");
  });
});

describe("profiles", () => {
  it("seeds the local profile as the default when docker is unavailable", async () => {
    const { engine } = await setup({ start: false });
    const { profiles } = await engine.profiles.list();
    const seeded = profiles.filter((p) => p.name === "Local (unisolated)");
    expect(seeded).toHaveLength(1);
    expect(seeded[0]).toMatchObject({
      isDefault: true,
      sandbox: {
        driver: "local",
        network: { mode: "open" },
        workspace: "task",
      },
      status: { driverAvailable: true, isolated: false },
    });
  });

  it("seeds docker as the default when its probe is ok", async () => {
    const fresh = await openTestDatabase();
    try {
      const { engine } = await setup(
        {
          start: false,
          drivers: [{ driver: fakeDocker(true), label: "Docker" }],
        },
        fresh,
      );
      const { profiles } = await engine.profiles.list();
      expect(
        profiles.map((p) => [p.name, p.isDefault, p.status.isolated]),
      ).toEqual([
        ["Docker sandbox", true, true],
        ["Local (unisolated)", false, false],
      ]);
      expect(profiles[0]?.sandbox).toMatchObject({
        driver: "docker",
        image: "jj-sandbox:base-1",
        network: { mode: "open" },
        workspace: "task",
        resources: { cpus: 2, memoryMb: 2048, processes: 512 },
      });
      // A second boot does not seed again.
      await setup(
        {
          start: false,
          drivers: [{ driver: fakeDocker(true), label: "Docker" }],
        },
        fresh,
      );
      expect((await engine.profiles.list()).profiles).toHaveLength(2);
    } finally {
      for (const engine of opened.splice(0)) await engine.dispose();
      await fresh.close();
    }
  });

  it("creates, updates and deletes profiles, refusing specs the driver cannot enforce", async () => {
    const { engine } = await setup({ start: false });
    const hints: WorkspaceHint[] = [];
    const stop = await engine.subscribeHints((hint) => hints.push(hint));
    const refused = await refusal(
      engine.profiles.create({
        name: "No network",
        sandbox: { driver: "local", network: { mode: "none" } },
      }),
    );
    expect(refused.code).toBe("PROFILE_UNSUPPORTED");
    expect(refused.message).toBe(
      'Driver local cannot enforce network.mode="none"',
    );
    expect(
      (
        await refusal(
          engine.profiles.create({
            name: "Mystery",
            sandbox: { driver: "daytona" },
          }),
        )
      ).code,
    ).toBe("PROFILE_UNSUPPORTED");
    expect(
      (
        await refusal(
          engine.profiles.create({
            name: "Bad",
            sandbox: { driver: "local", image: "x", network: { mode: "open" } },
          }),
        )
      ).message,
    ).toContain("image");

    const { profile } = await engine.profiles.create({
      name: "Short runs",
      sandbox: { driver: "local", network: { mode: "open" } },
      tools: ["bash", "read"],
      budgets: { maxTurnsPerRun: 10, maxRunMinutes: 5 },
    });
    runtimeProfileSchema.parse(profile);
    expect(profile).toMatchObject({
      isDefault: false,
      tools: ["bash", "read"],
      status: { isolated: false },
    });

    const { profile: patched } = await engine.profiles.update(profile.id, {
      budgets: { maxTurnsPerRun: 20 },
      sandbox: { limits: { execTimeoutMs: 5_000 } },
    });
    expect(patched.budgets).toEqual({ maxTurnsPerRun: 20, maxRunMinutes: 5 });
    expect(patched.sandbox.limits).toEqual({
      execTimeoutMs: 5_000,
      maxOutputBytes: 262_144,
    });
    expect(
      (
        await refusal(
          engine.profiles.update(profile.id, {
            sandbox: { network: { mode: "none" } },
          }),
        )
      ).code,
    ).toBe("PROFILE_UNSUPPORTED");

    const previous = (await engine.profiles.list()).profiles.find(
      (p) => p.isDefault,
    );
    await engine.profiles.update(profile.id, { isDefault: true });
    const defaults = (await engine.profiles.list()).profiles.filter(
      (p) => p.isDefault,
    );
    expect(defaults.map((p) => p.id)).toEqual([profile.id]);
    expect(
      (await refusal(engine.profiles.update(profile.id, { isDefault: false })))
        .code,
    ).toBe("CONFLICT");
    expect((await refusal(engine.profiles.delete(profile.id))).code).toBe(
      "CONFLICT",
    );
    await engine.profiles.update(previous?.id as string, { isDefault: true });

    const team = await createTeam(engine, ["Ada"]);
    await engine.bots.update(team.ids[0] as string, {
      runtimeProfileId: profile.id,
    });
    const inUse = await refusal(engine.profiles.delete(profile.id));
    expect(inUse.code).toBe("PROFILE_IN_USE");
    await engine.bots.update(team.ids[0] as string, { runtimeProfileId: null });
    await engine.profiles.delete(profile.id);
    expect((await refusal(engine.profiles.get(profile.id))).code).toBe(
      "NOT_FOUND",
    );
    await until(
      () =>
        hints.filter((hint) => hint.type === "profiles.changed").length >= 5,
      {
        what: "profile hints",
      },
    );
    await stop();
  });
});

describe("bots", () => {
  it("validates commands and refuses to archive a bot with active tasks", async () => {
    const { engine, executor } = await setup();
    const hints: WorkspaceHint[] = [];
    const stop = await engine.subscribeHints((hint) => hints.push(hint));
    const team = await createTeam(engine, ["Ada"]);
    const [ada] = team.names as [string];
    const adaId = team.ids[0] as string;
    expect(
      (await refusal(engine.bots.create({ name: ada.toUpperCase() }))).code,
    ).toBe("CONFLICT");
    expect((await refusal(engine.bots.create({ name: "" }))).code).toBe(
      "VALIDATION_FAILED",
    );
    expect(
      (
        await refusal(
          engine.bots.create({
            name: uniqueNameFor("Model"),
            model: "openai/gpt-x",
          }),
        )
      ).code,
    ).toBe("MODEL_NOT_CONFIGURED");
    expect(
      (
        await refusal(
          engine.bots.create({
            name: uniqueNameFor("Prof"),
            runtimeProfileId: "prof_missing",
          }),
        )
      ).code,
    ).toBe("VALIDATION_FAILED");
    expect(
      (
        await refusal(
          engine.tasks.create({
            goal: "verified",
            coordinatorBotId: adaId,
            verificationPlan: [
              {
                id: "c1",
                description: "d",
                method: "m",
                expectedEvidence: "e",
              },
            ],
          }),
        )
      ).code,
    ).toBe("VERIFICATION_UNAVAILABLE");
    expect(
      (
        await refusal(
          engine.tasks.create({
            goal: "x",
            coordinatorBotId: adaId,
            participantBotIds: ["bot_nope"],
          }),
        )
      ).code,
    ).toBe("VALIDATION_FAILED");
    expect((await refusal(engine.tasks.get("task_missing"))).code).toBe(
      "NOT_FOUND",
    );

    executor.brain(ada, () => ({ text: "Which one?" }));
    const { task } = await engine.tasks.create({
      goal: "Ask me",
      coordinatorBotId: adaId,
    });
    expect(task.title).toBe("Ask me");
    await untilTask(engine, task.id, (view) => view.task.status === "waiting");
    expect((await engine.bots.get(adaId)).bot).toMatchObject({
      presence: "idle",
      activeTaskIds: [task.id],
    });
    const conflict = await refusal(engine.bots.archive(adaId));
    expect(conflict.code).toBe("CONFLICT");
    expect(conflict.details).toEqual({ activeTaskIds: [task.id] });

    const summaries = (await engine.tasks.list()).tasks;
    const summary = taskSummarySchema.parse(
      summaries.find((t) => t.id === task.id),
    );
    expect(summary).toMatchObject({
      sessionCount: 1,
      activeSessionCount: 1,
      usage: { modelCalls: 1 },
    });

    await engine.tasks.stop(task.id);
    await engine.bots.archive(adaId);
    expect(
      (await engine.bots.list()).bots.some((bot) => bot.id === adaId),
    ).toBe(false);
    expect((await refusal(engine.bots.get(adaId))).code).toBe("NOT_FOUND");
    // An archived bot frees its name.
    const { bot: again } = await engine.bots.create({ name: ada });
    expect(again.id).not.toBe(adaId);
    await until(
      () =>
        hints.some(
          (hint) => hint.type === "tasks.changed" && hint.taskId === task.id,
        ) &&
        hints.some(
          (hint) => hint.type === "bots.changed" && hint.botId === adaId,
        ),
      { what: "workspace hints" },
    );
    await stop();
  });
});
