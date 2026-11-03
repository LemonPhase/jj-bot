import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TaskView } from "@jj/contracts";
import { secrets as secretsTable, sessionEntries } from "@jj/db";
import { ModelRegistry } from "@jj/runtime";
import { LocalSandboxDriver } from "@jj/sandbox";
import type { AcquireRequest } from "@jj/sandbox/contract";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDriverRegistry } from "./drivers";
import { DomainError } from "./errors";
import type { EngineDriver } from "./ports";
import { REDACTED } from "./redact";
import { createKeyring } from "./secrets/keyring";
import { SecretStore } from "./secrets/store";
import { said } from "./testing/fake-executor";
import {
  OPEN_TIMEOUT,
  openTestDatabase,
  quietLogger,
  type TestDatabase,
  type TestEngine,
  testEngine,
  untilTask,
} from "./testing/harness";
import { createTeam, lastResult } from "./testing/scenarios";

let db: TestDatabase;
let current: TestEngine | undefined;
let roots: string[] = [];

beforeAll(async () => {
  db = await openTestDatabase();
}, OPEN_TIMEOUT);
afterEach(async () => {
  await current?.dispose();
  current = undefined;
  // Each test starts from an empty store.
  await db.database.db.delete(secretsTable);
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
  roots = [];
});
afterAll(async () => {
  await db?.close();
});

const TOKEN = "ghp_secretTokenValue0123456789abcdefXYZ";
const API_TOKEN = "api-token-0123456789abcdefghijklmn";
const LONG_DB_PASSWORD = "db-password-0123456789abcdef";
const PROVIDER_KEY = "sk-stored-0123456789abcdefghijklmnopqrstuv";
const ENV_KEY = "sk-env-0123456789abcdefghijklmnopqrstuvwxyz";

const store = (master = randomBytes(32), previous: Buffer[] = []) =>
  new SecretStore({
    db: db.database.db,
    keyring: createKeyring(master, previous),
  });

/** A local driver that records what each acquisition was given. */
async function recordingDriver() {
  const root = await mkdtemp(join(tmpdir(), "jj-secrets-"));
  roots.push(root);
  const inner = new LocalSandboxDriver({ root, killGraceMs: 200 });
  const requests: AcquireRequest[] = [];
  const driver: EngineDriver = {
    id: inner.id,
    capabilities: inner.capabilities,
    validateSpec: (spec) => inner.validateSpec(spec),
    probe: () => inner.probe(),
    acquire(request) {
      requests.push(request);
      return inner.acquire(request);
    },
  };
  return { driver, requests };
}

async function rejection(promise: Promise<unknown>): Promise<DomainError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("Expected a refusal.");
}

/** Everything a task persisted: events with full previews, transcripts, the view, spilled output. */
async function persisted(engine: TestEngine["engine"], view: TaskView) {
  const page = await engine.tasks.events(view.task.id);
  const entries = await Promise.all(
    view.sessions.map((session) =>
      db.database.db
        .select({ entry: sessionEntries.entry })
        .from(sessionEntries)
        .where(eq(sessionEntries.sessionId, session.id)),
    ),
  );
  const spills = await Promise.all(
    view.artifacts
      .filter((artifact) => artifact.kind === "output")
      .map(async (artifact) =>
        Buffer.from(
          (await engine.tasks.artifactContent(view.task.id, artifact.id))
            .content,
        ).toString(),
      ),
  );
  return [
    JSON.stringify(page.events),
    JSON.stringify(entries),
    JSON.stringify(view),
    ...spills,
  ];
}

describe("sandbox secrets", () => {
  it("are refused without a master key, and listed as unavailable", async () => {
    current = await testEngine(db.database, { start: false });
    const { engine } = current;
    expect(await engine.secrets.list()).toEqual({
      available: false,
      secrets: [],
    });
    const refused = await rejection(
      engine.secrets.put("GITHUB_TOKEN", { value: TOKEN }),
    );
    expect(refused.code).toBe("SECRET_STORE_UNAVAILABLE");
    expect(refused.message).toContain("openssl rand -base64 32");
    expect((await engine.bootstrap()).capabilities.secretStore).toBe(false);
  });

  it("are stored encrypted and write-only: answers carry the last four characters, never the value", async () => {
    current = await testEngine(db.database, {
      start: false,
      secretStore: store(),
    });
    const { engine } = current;
    expect((await engine.bootstrap()).capabilities.secretStore).toBe(true);
    const first = await engine.secrets.put("GITHUB_TOKEN", { value: TOKEN });
    expect(first.created).toBe(true);
    expect(first.secret).toMatchObject({
      name: "GITHUB_TOKEN",
      hint: TOKEN.slice(-4),
      readable: true,
    });
    const replaced = await engine.secrets.put("GITHUB_TOKEN", {
      value: `  ${TOKEN}-v2  `,
    });
    expect(replaced.created).toBe(false);
    expect(replaced.secret.hint).toBe(`${TOKEN}-v2`.slice(-4));
    const listed = await engine.secrets.list();
    expect(listed.secrets.map((secret) => secret.name)).toEqual([
      "GITHUB_TOKEN",
    ]);
    const answers = JSON.stringify([
      first,
      replaced,
      listed,
      await engine.bootstrap(),
      await engine.profiles.list(),
    ]);
    expect(answers).not.toContain(TOKEN);
    // The database holds only ciphertext.
    const rows = await db.database.db.select().from(secretsTable);
    expect(rows).toHaveLength(1);
    const stored = JSON.stringify(rows, (_key, value) =>
      value instanceof Uint8Array
        ? Buffer.from(value).toString("latin1")
        : value,
    );
    expect(stored).not.toContain(TOKEN.slice(0, 12));
    await engine.secrets.delete("GITHUB_TOKEN");
    expect((await engine.secrets.list()).secrets).toEqual([]);
    expect((await rejection(engine.secrets.delete("GITHUB_TOKEN"))).code).toBe(
      "NOT_FOUND",
    );
  });

  it("refuses bad names and values without repeating the value", async () => {
    current = await testEngine(db.database, {
      start: false,
      secretStore: store(),
      secrets: [
        { name: "OPENAI_API_KEY", value: ENV_KEY },
        { name: "API_TOKEN", value: API_TOKEN },
        { name: "the DATABASE_URL password", value: "postgres", inUrl: true },
        {
          name: "the DATABASE_URL password",
          value: LONG_DB_PASSWORD,
          inUrl: true,
        },
      ],
    });
    const { engine } = current;
    const cases: [string, string, RegExp][] = [
      ["GITHUB_TOKEN", "short-value", /at least 16 characters/],
      ["GITHUB_TOKEN", `${TOKEN}\nsecond line`, /one line/],
      ["github_token", TOKEN, /environment variable name/],
      ["PATH", TOKEN, /reserved/],
      ["HTTPS_PROXY", TOKEN, /reserved/],
      ["JJ_ANYTHING", TOKEN, /reserved/],
      ["LD_PRELOAD", TOKEN, /reserved/],
      ["OPENAI_KEY_COPY", ENV_KEY, /OPENAI_API_KEY, a server secret/],
      // Containing a server secret, or part of one, is refused too.
      ["AUTH_HEADER", `Bearer ${ENV_KEY}`, /OPENAI_API_KEY, a server secret/],
      [
        "NPMRC_LINE",
        `//registry.npmjs.org/:_authToken=${API_TOKEN}`,
        /API_TOKEN, a server secret/,
      ],
      ["KEY_PIECE", ENV_KEY.slice(3, 30), /OPENAI_API_KEY, a server secret/],
      // The database password: equal at any length, contained when long.
      ["DB_PASSWORD", LONG_DB_PASSWORD, /DATABASE_URL password/],
      [
        "PG_URL",
        `postgresql://jj:${LONG_DB_PASSWORD}@db/jj`,
        /DATABASE_URL password/,
      ],
    ];
    for (const [name, value, message] of cases) {
      const refused = await rejection(engine.secrets.put(name, { value }));
      expect(refused.code).toBe("VALIDATION_FAILED");
      expect(refused.message).toMatch(message);
      const text = JSON.stringify([refused.message, refused.details]);
      expect(text).not.toContain(value.slice(0, 10));
    }
    expect((await engine.secrets.list()).secrets).toEqual([]);
    // A short database password is an ordinary word: containing it is fine.
    await engine.secrets.put("PLAIN_TOKEN", {
      value: "postgres-ghp_0123456789abcdef",
    });
    expect((await engine.secrets.list()).secrets).toHaveLength(1);
  });

  it("are granted by name to stored secrets only, without clashing with sandbox.env, and removal drops the grants", async () => {
    current = await testEngine(db.database, {
      start: false,
      secretStore: store(),
    });
    const { engine } = current;
    const sandbox = { driver: "local", network: { mode: "open" as const } };
    const unknown = await rejection(
      engine.profiles.create({
        name: "Git",
        sandbox,
        secrets: ["GITHUB_TOKEN"],
      }),
    );
    expect(unknown.code).toBe("VALIDATION_FAILED");
    expect(unknown.message).toContain("no sandbox secret named GITHUB_TOKEN");
    await engine.secrets.put("GITHUB_TOKEN", { value: TOKEN });
    await engine.secrets.put("NPM_TOKEN", { value: `${TOKEN}-npm` });
    const clash = await rejection(
      engine.profiles.create({
        name: "Git",
        sandbox: { ...sandbox, env: { GITHUB_TOKEN: "plain" } },
        secrets: ["GITHUB_TOKEN"],
      }),
    );
    expect(clash.message).toContain("also set in sandbox.env");
    const { profile } = await engine.profiles.create({
      name: "Git",
      sandbox,
      secrets: ["GITHUB_TOKEN", "NPM_TOKEN"],
    });
    expect(profile.secrets).toEqual(["GITHUB_TOKEN", "NPM_TOKEN"]);
    const envClash = await rejection(
      engine.profiles.update(profile.id, {
        sandbox: { env: { NPM_TOKEN: "plain" } },
      }),
    );
    expect(envClash.message).toContain("NPM_TOKEN is also set in sandbox.env");
    await engine.secrets.delete("GITHUB_TOKEN");
    expect((await engine.profiles.get(profile.id)).profile.secrets).toEqual([
      "NPM_TOKEN",
    ]);
    const updated = await engine.profiles.update(profile.id, { secrets: [] });
    expect(updated.profile.secrets).toEqual([]);
  });

  it("reach every command of a task whose coordinator's profile grants them, redacted from everything the task persists", async () => {
    const recording = await recordingDriver();
    current = await testEngine(db.database, {
      registry: createDriverRegistry([
        { driver: recording.driver, label: "Local (unisolated)" },
      ]),
      secretStore: store(),
      secrets: [{ name: "OPENAI_API_KEY", value: ENV_KEY }],
      config: { outputCapBytes: 1024 },
    });
    const { engine, executor } = current;
    await engine.secrets.put("GITHUB_TOKEN", { value: TOKEN });
    const { profile } = await engine.profiles.create({
      name: uniqueProfile("Git"),
      sandbox: { driver: "local", network: { mode: "open" } },
      secrets: ["GITHUB_TOKEN"],
    });
    const team = await createTeam(engine, ["Ada"]);
    const [ada] = team.names as [string];
    await engine.bots.update(team.byName[ada] as string, {
      runtimeProfileId: profile.id,
    });
    const prefix = ENV_KEY.slice(0, 12);
    executor.brain(ada, (view) => {
      switch (said.turns(view)) {
        case 0:
          return {
            calls: [
              { name: "bash", args: { command: 'echo "got $GITHUB_TOKEN"' } },
            ],
          };
        case 1:
          // Over the output cap, so it is spilled to an artifact.
          return {
            calls: [
              {
                name: "bash",
                args: {
                  command: 'for i in $(seq 200); do echo "$GITHUB_TOKEN"; done',
                },
              },
            ],
          };
        case 2:
          // The server's model key is never among them.
          return {
            calls: [
              {
                name: "bash",
                args: {
                  command: `if env | grep -q ${prefix}; then echo model-key-leaked; else echo model-key-absent; fi`,
                },
              },
            ],
          };
        default:
          return lastResult(view)?.name === "complete_task"
            ? { text: "Done." }
            : {
                calls: [
                  {
                    name: "complete_task",
                    args: { result: `The token is ${TOKEN}.` },
                  },
                ],
              };
      }
    });
    const { task } = await engine.tasks.create({
      goal: "Use the token",
      coordinatorBotId: team.byName[ada] as string,
    });
    const view = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed" || v.task.status === "failed",
    );
    expect(view.task.status).toBe("completed");
    expect(recording.requests).toHaveLength(1);
    expect(recording.requests[0]?.secrets).toEqual({ GITHUB_TOKEN: TOKEN });
    const page = await engine.tasks.events(task.id);
    const outputs = page.events.flatMap((event) =>
      event.type === "tool.finished" ? [event.payload.output ?? ""] : [],
    );
    expect(outputs[0]).toBe(`got ${REDACTED}\n`);
    expect(outputs).toContain("model-key-absent\n");
    expect(view.task.result).toBe(`The token is ${REDACTED}.`);
    const stored = await persisted(engine, view);
    expect(stored.length).toBeGreaterThanOrEqual(4);
    for (const text of stored) expect(text).not.toContain(TOKEN);
    expect(stored.at(-1)).toContain(REDACTED);
  });

  it("are not given to a sandbox whose profile does not grant them", async () => {
    const recording = await recordingDriver();
    current = await testEngine(db.database, {
      registry: createDriverRegistry([
        { driver: recording.driver, label: "Local (unisolated)" },
      ]),
      secretStore: store(),
    });
    const { engine, executor } = current;
    await engine.secrets.put("GITHUB_TOKEN", { value: TOKEN });
    const { profile } = await engine.profiles.create({
      name: uniqueProfile("Plain"),
      sandbox: { driver: "local", network: { mode: "open" } },
    });
    const team = await createTeam(engine, ["Ada"]);
    const [ada] = team.names as [string];
    await engine.bots.update(team.byName[ada] as string, {
      runtimeProfileId: profile.id,
    });
    executor.brain(ada, (view) =>
      said.turns(view) === 0
        ? {
            calls: [
              { name: "bash", args: { command: 'echo "[$GITHUB_TOKEN]"' } },
            ],
          }
        : lastResult(view)?.name === "complete_task"
          ? { text: "Done." }
          : {
              calls: [
                {
                  name: "complete_task",
                  args: { result: lastResult(view)?.text ?? "" },
                },
              ],
            },
    );
    const { task } = await engine.tasks.create({
      goal: "Look for the token",
      coordinatorBotId: team.byName[ada] as string,
    });
    const view = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed",
    );
    expect(recording.requests[0]?.secrets).toBeUndefined();
    expect(view.task.result).toContain("[]");
  });
});

let profileCount = 0;
const uniqueProfile = (base: string) =>
  `${base} ${++profileCount}-${Date.now()}`;

describe("stored secrets under another key", () => {
  it("are listed unreadable, warned about by name, and fail a granted sandbox visibly", async () => {
    const first = store();
    current = await testEngine(db.database, {
      start: false,
      secretStore: first,
    });
    await current.engine.secrets.put("GITHUB_TOKEN", { value: TOKEN });
    const { profile } = await current.engine.profiles.create({
      name: uniqueProfile("Git"),
      sandbox: { driver: "local", network: { mode: "open" } },
      secrets: ["GITHUB_TOKEN"],
    });
    await current.dispose();
    quietLogger.warnings.length = 0;
    // The master key changed and the old one is gone.
    current = await testEngine(db.database, { secretStore: store() });
    const { engine, executor } = current;
    expect(
      quietLogger.warnings.some((line) =>
        line.includes("cannot be decrypted with JJ_SECRET_KEY (GITHUB_TOKEN)"),
      ),
    ).toBe(true);
    expect((await engine.secrets.list()).secrets).toMatchObject([
      { name: "GITHUB_TOKEN", readable: false, hint: TOKEN.slice(-4) },
    ]);
    const team = await createTeam(engine, ["Ada"]);
    const [ada] = team.names as [string];
    await engine.bots.update(team.byName[ada] as string, {
      runtimeProfileId: profile.id,
    });
    executor.brain(ada, () => ({ text: "never runs" }));
    const { task } = await engine.tasks.create({
      goal: "Use the token",
      coordinatorBotId: team.byName[ada] as string,
    });
    const view = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "failed",
    );
    expect(view.sessions[0]?.error).toContain(
      `grants GITHUB_TOKEN, which the current JJ_SECRET_KEY cannot decrypt`,
    );
    // Storing it again under the current key makes it usable.
    await engine.secrets.put("GITHUB_TOKEN", { value: TOKEN });
    expect((await engine.secrets.list()).secrets[0]?.readable).toBe(true);
  });

  it("are re-encrypted at boot when the old key is kept as a previous key", async () => {
    const old = randomBytes(32);
    current = await testEngine(db.database, {
      start: false,
      secretStore: store(old),
    });
    await current.engine.secrets.put("GITHUB_TOKEN", { value: TOKEN });
    const sealedBefore = await db.database.db.select().from(secretsTable);
    await current.dispose();
    const next = randomBytes(32);
    quietLogger.infos.length = 0;
    current = await testEngine(db.database, {
      start: false,
      secretStore: store(next, [old]),
    });
    expect(
      quietLogger.infos.some((line) =>
        line.startsWith("Re-encrypted 1 stored secret"),
      ),
    ).toBe(true);
    const sealedAfter = await db.database.db.select().from(secretsTable);
    expect(sealedAfter[0]?.keyId).not.toBe(sealedBefore[0]?.keyId);
    await current.dispose();
    // The previous key can go now.
    const rotated = store(next);
    current = await testEngine(db.database, {
      start: false,
      secretStore: rotated,
    });
    expect((await current.engine.secrets.list()).secrets[0]?.readable).toBe(
      true,
    );
    expect(await rotated.sandboxValues(["GITHUB_TOKEN"])).toMatchObject({
      values: { GITHUB_TOKEN: TOKEN },
    });
  });

  it("are unavailable, not deleted, without a master key", async () => {
    current = await testEngine(db.database, {
      start: false,
      secretStore: store(),
    });
    await current.engine.secrets.put("GITHUB_TOKEN", { value: TOKEN });
    await current.dispose();
    quietLogger.warnings.length = 0;
    current = await testEngine(db.database, { start: false });
    expect(
      quietLogger.warnings.some((line) =>
        line.startsWith(
          "JJ_SECRET_KEY is not set, so 1 stored secret is unavailable (GITHUB_TOKEN)",
        ),
      ),
    ).toBe(true);
    expect(await current.engine.secrets.list()).toMatchObject({
      available: false,
      secrets: [{ name: "GITHUB_TOKEN", readable: false }],
    });
    // Removing needs no key.
    await current.engine.secrets.delete("GITHUB_TOKEN");
    expect((await current.engine.secrets.list()).secrets).toEqual([]);
  });
});

describe("stored provider keys", () => {
  const registry = (
    secretStore: SecretStore,
    env: Record<string, string> = {},
  ) => new ModelRegistry({ env, storedKeys: secretStore });

  it("configure a provider, resolve per call and are never answered back", async () => {
    const secretStore = store();
    const models = registry(secretStore);
    current = await testEngine(db.database, {
      start: false,
      secretStore,
      models,
    });
    const { engine } = current;
    const before = await engine.models();
    expect(before.providers.find((p) => p.id === "openai")).toMatchObject({
      configured: false,
      keySource: null,
      storedKey: null,
    });
    expect((await engine.bootstrap()).capabilities.agentExecution).toBe(false);
    const view = await engine.putProviderKey("openai", {
      value: PROVIDER_KEY,
    });
    expect(view.providers.find((p) => p.id === "openai")).toMatchObject({
      configured: true,
      keySource: "stored",
      storedKey: { hint: PROVIDER_KEY.slice(-4), readable: true },
    });
    expect(view.defaultModel).toMatch(/^openai\//);
    expect((await engine.bootstrap()).capabilities.agentExecution).toBe(true);
    expect(models.resolve("openai/gpt-6-luna").getApiKey()).toBe(PROVIDER_KEY);
    expect(
      JSON.stringify([view, await engine.models(), await engine.bootstrap()]),
    ).not.toContain(PROVIDER_KEY);
    // A model key never becomes a sandbox secret, whichever comes first.
    const copied = await rejection(
      engine.secrets.put("OPENAI_COPY", { value: PROVIDER_KEY }),
    );
    expect(copied.message).toContain("the stored openai key, a server secret");
    await engine.secrets.put("GITHUB_TOKEN", { value: TOKEN });
    const reused = await rejection(
      engine.putProviderKey("anthropic", { value: TOKEN }),
    );
    expect(reused.message).toContain("the sandbox secret GITHUB_TOKEN");
    const containing = await rejection(
      engine.putProviderKey("anthropic", { value: `sk-ant-${TOKEN}` }),
    );
    expect(containing.message).toContain("the sandbox secret GITHUB_TOKEN");
    const removed = await engine.deleteProviderKey("openai");
    expect(removed.providers.find((p) => p.id === "openai")).toMatchObject({
      configured: false,
      storedKey: null,
    });
    expect((await rejection(engine.deleteProviderKey("openai"))).code).toBe(
      "NOT_FOUND",
    );
  });

  it("lose to the server's variable, and only providers that take a key take one", async () => {
    const secretStore = store();
    current = await testEngine(db.database, {
      start: false,
      secretStore,
      models: registry(secretStore, { OPENAI_API_KEY: ENV_KEY }),
    });
    const { engine } = current;
    const conflict = await rejection(
      engine.putProviderKey("openai", { value: PROVIDER_KEY }),
    );
    expect(conflict.code).toBe("CONFLICT");
    expect(conflict.message).toContain("OPENAI_API_KEY on the server");
    const openai = (await engine.models()).providers.find(
      (p) => p.id === "openai",
    );
    expect(openai).toMatchObject({ keySource: "env", storedKey: null });
    expect(
      (await rejection(engine.putProviderKey("nope", { value: PROVIDER_KEY })))
        .code,
    ).toBe("NOT_FOUND");
  });
});

describe("a sandbox that holds a value the store no longer has", () => {
  for (const change of ["replace", "delete"] as const)
    it(`keeps redacting it after the secret is ${change === "replace" ? "replaced" : "removed"}`, async () => {
      const recording = await recordingDriver();
      current = await testEngine(db.database, {
        registry: createDriverRegistry([
          { driver: recording.driver, label: "Local (unisolated)" },
        ]),
        secretStore: store(),
      });
      const { engine, executor } = current;
      await engine.secrets.put("GH_TOKEN", { value: TOKEN });
      const { profile } = await engine.profiles.create({
        name: uniqueProfile("Tok"),
        sandbox: { driver: "local", network: { mode: "open" } },
        secrets: ["GH_TOKEN"],
      });
      const team = await createTeam(engine, ["Ada"]);
      const [ada] = team.names as [string];
      await engine.bots.update(team.byName[ada] as string, {
        runtimeProfileId: profile.id,
      });
      executor.brain(ada, (view) => {
        if (!said.heard(view, "again"))
          return said.turns(view) === 0
            ? {
                calls: [
                  { name: "bash", args: { command: 'echo "one $GH_TOKEN"' } },
                ],
              }
            : { text: "first pass" };
        if (
          !said.results(view).some((result) => result.text.startsWith("two "))
        )
          return {
            calls: [
              { name: "bash", args: { command: 'echo "two $GH_TOKEN"' } },
            ],
          };
        return lastResult(view)?.name === "complete_task"
          ? { text: "done" }
          : {
              calls: [
                {
                  name: "complete_task",
                  args: { result: lastResult(view)?.text ?? "" },
                },
              ],
            };
      });
      const { task } = await engine.tasks.create({
        goal: "Use the token twice",
        coordinatorBotId: team.byName[ada] as string,
      });
      await untilTask(engine, task.id, (v) => v.task.status === "waiting");
      if (change === "replace")
        await engine.secrets.put("GH_TOKEN", { value: `${TOKEN}-rotated` });
      else await engine.secrets.delete("GH_TOKEN");
      await engine.tasks.postMessage(task.id, { text: "again" });
      const view = await untilTask(
        engine,
        task.id,
        (v) => v.task.status === "completed" || v.task.status === "failed",
      );
      expect(view.task.status).toBe("completed");
      // The same sandbox ran both commands, with the value it started with.
      expect(recording.requests).toHaveLength(1);
      const page = await engine.tasks.events(task.id);
      const outputs = page.events.flatMap((event) =>
        event.type === "tool.finished" && event.payload.tool === "bash"
          ? [event.payload.output ?? ""]
          : [],
      );
      expect(outputs).toEqual([`one ${REDACTED}\n`, `two ${REDACTED}\n`]);
      expect(view.task.result).toBe(`two ${REDACTED}`);
      for (const text of await persisted(engine, view))
        expect(text).not.toContain(TOKEN);
    });

  it("redacts a value stored after the run's redactor was built but before its sandbox started", async () => {
    const recording = await recordingDriver();
    const secretStore = store();
    current = await testEngine(db.database, {
      registry: createDriverRegistry([
        { driver: recording.driver, label: "Local (unisolated)" },
      ]),
      secretStore,
    });
    const { engine, executor } = current;
    await engine.secrets.put("GH_TOKEN", { value: TOKEN });
    const { profile } = await engine.profiles.create({
      name: uniqueProfile("Race"),
      sandbox: { driver: "local", network: { mode: "open" } },
      secrets: ["GH_TOKEN"],
    });
    const team = await createTeam(engine, ["Ada"]);
    const [ada] = team.names as [string];
    await engine.bots.update(team.byName[ada] as string, {
      runtimeProfileId: profile.id,
    });
    // The new value lands as the sandbox starts: after the run built its
    // redactor, before the grants are read.
    const replaced = `${TOKEN}-raced`;
    const read = secretStore.sandboxValues.bind(secretStore);
    secretStore.sandboxValues = async (names, exec) => {
      await engine.secrets.put("GH_TOKEN", { value: replaced });
      return read(names, exec);
    };
    executor.brain(ada, (view) =>
      said.turns(view) === 0
        ? { calls: [{ name: "bash", args: { command: 'echo "v=$GH_TOKEN"' } }] }
        : lastResult(view)?.name === "complete_task"
          ? { text: "done" }
          : {
              calls: [
                {
                  name: "complete_task",
                  args: { result: lastResult(view)?.text ?? "" },
                },
              ],
            },
    );
    const { task } = await engine.tasks.create({
      goal: "Race the token",
      coordinatorBotId: team.byName[ada] as string,
    });
    const view = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed" || v.task.status === "failed",
    );
    expect(recording.requests[0]?.secrets).toEqual({ GH_TOKEN: replaced });
    expect(view.task.result).toBe(`v=${REDACTED}`);
    for (const text of await persisted(engine, view))
      expect(text).not.toContain(replaced);
  });
});

describe("a stored provider key in what a run persists", () => {
  it("is redacted like the server's own keys", async () => {
    const secretStore = store();
    current = await testEngine(db.database, {
      secretStore,
      models: new ModelRegistry({ env: {}, storedKeys: secretStore }),
    });
    const { engine, executor } = current;
    await engine.putProviderKey("openai", { value: PROVIDER_KEY });
    const team = await createTeam(engine, ["Ada"]);
    const [ada] = team.names as [string];
    executor.brain(ada, (view) =>
      lastResult(view)?.name === "complete_task"
        ? { text: `Used ${PROVIDER_KEY}.` }
        : {
            text: `The key is ${PROVIDER_KEY}`,
            calls: [
              {
                name: "complete_task",
                args: { result: `Key ${PROVIDER_KEY} works.` },
              },
            ],
          },
    );
    const { task } = await engine.tasks.create({
      goal: "Say the key",
      coordinatorBotId: team.byName[ada] as string,
    });
    const view = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed" || v.task.status === "failed",
    );
    expect(view.task.result).toBe(`Key ${REDACTED} works.`);
    for (const text of await persisted(engine, view))
      expect(text).not.toContain(PROVIDER_KEY);
  });
});

describe("granting a secret while it is removed", () => {
  it("never leaves a grant to a secret that is gone", async () => {
    current = await testEngine(db.database, {
      start: false,
      secretStore: store(),
    });
    const { engine } = current;
    const { profile } = await engine.profiles.create({
      name: uniqueProfile("Grant race"),
      sandbox: { driver: "local", network: { mode: "open" } },
    });
    for (let round = 0; round < 8; round += 1) {
      await engine.secrets.put("RACE_TOKEN", { value: TOKEN });
      await Promise.allSettled([
        engine.profiles.update(profile.id, { secrets: ["RACE_TOKEN"] }),
        engine.secrets.delete("RACE_TOKEN"),
      ]);
      const granted = (await engine.profiles.get(profile.id)).profile.secrets;
      const stored = (await engine.secrets.list()).secrets.map((s) => s.name);
      for (const name of granted) expect(stored).toContain(name);
      await engine.profiles.update(profile.id, { secrets: [] });
    }
  });
});
