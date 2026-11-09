// MCP servers of runtime profiles: discovery through the worker (the stdio
// fixture in an ephemeral `local` sandbox, a remote server on a local https
// endpoint behind the real guard), its failures, the save-time rules on the
// merged profile, a removed secret, retention and recovery, and that no
// stored record holds a secret value. The docker variant is in docker.test.ts.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type McpDiscovery,
  type McpServerInput,
  type McpToolSnapshot,
  mcpServerSchema,
} from "@jj/contracts";
import {
  jobs,
  mcpDiscoveries,
  mcpToolSnapshots,
  retiredSecrets,
  runtimeProfiles,
  secrets as secretsTable,
} from "@jj/db";
import { McpDiscoverer, type McpEnv } from "@jj/runtime";
import { LocalSandboxDriver } from "@jj/sandbox";
import { isPublicAddress } from "@jj/sandbox/addresses";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { EngineConfigInput } from "./config";
import { createDriverRegistry } from "./drivers";
import type { Engine } from "./engine";
import { DomainError } from "./errors";
import type { ChatReply, ChatReplyInput, EngineDriver } from "./ports";
import { createKeyring } from "./secrets/keyring";
import { SecretStore } from "./secrets/store";
import { MAX_KEPT_DISCOVERIES, mcpConfigHash } from "./services/mcp";
import { FakeChatResponder } from "./testing/fakes";
import {
  OPEN_TIMEOUT,
  openTestDatabase,
  recordingDriver,
  sleep,
  type TestDatabase,
  type TestEngine,
  testEngine,
  uniqueName,
  until,
} from "./testing/harness";
import { mcpFixture } from "./testing/mcp-fixture";

/** Granted as DOCS_SECRET; the fixture gets it as DOCS_TOKEN. */
const TOKEN = "docs-token-0123456789abcdefXYZ";
/** Stored as DOCS_KEY; a remote server's Authorization header sends it. */
const HEADER_TOKEN = "header-token-0123456789abcdefQRS";

let db: TestDatabase;
let current: TestEngine | undefined;
let roots: string[] = [];

// A local https MCP endpoint for remote discovery (a certificate for mcp.test).
let tlsDir: string;
let cert: string;
let endpoint: Server;
let port = 0;
/** What the endpoint received: JSON-RPC methods and the Authorization header. */
const received: { method: string; authorization: string }[] = [];

beforeAll(async () => {
  db = await openTestDatabase();
  tlsDir = mkdtempSync(join(tmpdir(), "jj-mcp-engine-tls-"));
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-subj",
      "/CN=mcp.test",
      "-addext",
      "subjectAltName=DNS:mcp.test",
      "-days",
      "2",
      "-keyout",
      join(tlsDir, "key.pem"),
      "-out",
      join(tlsDir, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  cert = readFileSync(join(tlsDir, "cert.pem"), "utf8");
  const key = readFileSync(join(tlsDir, "key.pem"), "utf8");
  endpoint = createServer({ cert, key }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString();
      const message = body ? JSON.parse(body) : undefined;
      const authorization = String(req.headers.authorization ?? "");
      received.push({
        method: message?.method ?? req.method ?? "",
        authorization,
      });
      if (!message || message.id === undefined) {
        res.writeHead(202).end();
        return;
      }
      const reply = (result: unknown) =>
        res
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      if (message.method === "initialize")
        reply({
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "remote-fixture", version: "2.0.0" },
        });
      else if (message.method === "tools/list")
        reply({
          tools: [
            {
              name: "lookup",
              // A server that echoes what it was sent: stored redacted.
              description: `Looks things up as ${authorization}.`,
              inputSchema: { type: "object" },
            },
          ],
        });
      else
        res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Method not found" },
          }),
        );
    });
  });
  port = await new Promise<number>((resolve) =>
    endpoint.listen(0, "127.0.0.1", () => {
      const address = endpoint.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    }),
  );
}, OPEN_TIMEOUT);

/** Stops the current engine and empties the store, for the next one. */
async function reset() {
  await current?.dispose();
  current = undefined;
  await db.database.db.delete(secretsTable);
  await db.database.db.delete(retiredSecrets);
}

afterEach(async () => {
  await reset();
  await Promise.all(
    roots.map((root) => rm(root, { recursive: true, force: true })),
  );
  roots = [];
  received.length = 0;
});

afterAll(async () => {
  endpoint?.closeAllConnections();
  await new Promise<void>((resolve) => endpoint?.close(() => resolve()));
  rmSync(tlsDir, { recursive: true, force: true });
  await db?.close();
});

/** Loopback stands in for a public address; everything else is judged as in production. */
const allowLoopback = (address: string) =>
  address === "127.0.0.1" || isPublicAddress(address);

/** The local driver, whose sandboxes start once `hold` settles, whatever the signal says. */
function heldLocal(root: string, hold: () => Promise<void>): EngineDriver {
  const inner = new LocalSandboxDriver({ root, killGraceMs: 200 });
  return {
    id: inner.id,
    capabilities: inner.capabilities,
    validateSpec: (spec) => inner.validateSpec(spec),
    probe: () => inner.probe(),
    async acquire(request) {
      await hold();
      const { signal: _ignored, ...rest } = request;
      return inner.acquire(rest);
    },
  };
}

/** A chat responder that takes a while, so steady chat keeps the worker's slots busy. */
class SlowChat extends FakeChatResponder {
  /** When each reply started and finished (`performance.now()`). */
  readonly started: number[] = [];
  readonly finished: number[] = [];

  override async reply(input: ChatReplyInput): Promise<ChatReply> {
    this.started.push(performance.now());
    await sleep(150);
    const reply = await super.reply(input);
    this.finished.push(performance.now());
    return reply;
  }
}

/**
 * Chat replies waiting in the queue: at least two means one waits for a
 * slot whichever bot replies now (a bot's next reply waits for its last).
 */
async function chatRepliesQueued() {
  const queued = await db.database.db
    .select({ id: jobs.id })
    .from(jobs)
    .where(sql`${jobs.kind} = 'chat.reply' and ${jobs.status} = 'queued'`);
  return queued.length;
}

/** Three bots chatting without pause until `stop()`. */
async function chatLoad(engine: Engine, chat: FakeChatResponder) {
  const bots: string[] = [];
  for (const base of ["Ann", "Ben", "Cal"]) {
    const { bot } = await engine.bots.create({ name: uniqueName(base) });
    chat.brain(bot.name, () => ({ text: "ok" }));
    bots.push(bot.id);
  }
  let running = true;
  const sending = (async () => {
    for (let index = 0; running; index += 1) {
      await engine.bots
        .sendMessage(bots[index % bots.length] as string, {
          text: `message ${index}`,
        })
        .catch(() => {});
      await sleep(40);
    }
  })();
  await until(() => chat.inputs.length > 0, { what: "the chat load" });
  return {
    async stop() {
      running = false;
      await sending;
    },
  };
}

async function setup(
  options: {
    spawn?: boolean;
    env?: McpEnv;
    mcp?: false;
    config?: EngineConfigInput;
    slowAcquireMs?: number;
    /** Awaited before each sandbox starts. */
    holdAcquire?: () => Promise<void>;
    chat?: FakeChatResponder;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "jj-mcp-engine-"));
  roots.push(root);
  const { slowAcquireMs, holdAcquire } = options;
  const local = recordingDriver(
    slowAcquireMs
      ? heldLocal(root, () => sleep(slowAcquireMs))
      : holdAcquire
        ? heldLocal(root, holdAcquire)
        : new LocalSandboxDriver({ root, killGraceMs: 200 }),
    { spawn: options.spawn ?? true },
  );
  current = await testEngine(db.database, {
    ...(options.config ? { config: options.config } : {}),
    ...(options.chat ? { chat: options.chat } : {}),
    registry: createDriverRegistry([{ driver: local.driver, label: "Local" }]),
    secretStore: new SecretStore({
      db: db.database.db,
      keyring: createKeyring(randomBytes(32)),
    }),
    ...(options.mcp === false
      ? {}
      : {
          mcp: new McpDiscoverer({
            env: options.env ?? {},
            closeGraceMs: 200,
            guard: {
              ca: cert,
              isAllowedAddress: allowLoopback,
              resolve: async (host) => {
                if (host === "mcp.test") return ["127.0.0.1"];
                if (host === "internal.test") return ["10.0.0.7"];
                throw Object.assign(
                  new Error(`getaddrinfo ENOTFOUND ${host}`),
                  {
                    code: "ENOTFOUND",
                  },
                );
              },
            },
          }),
        }),
  });
  const { engine } = current;
  await engine.secrets.put("DOCS_SECRET", { value: TOKEN });
  await engine.secrets.put("DOCS_KEY", { value: HEADER_TOKEN });
  const { profile } = await engine.profiles.create({
    name: "MCP",
    sandbox: { driver: "local", network: { mode: "open" } },
    secrets: ["DOCS_SECRET"],
  });
  return { engine, profile, acquired: local.acquired };
}

type HttpInput = Extract<McpServerInput, { transport: "http" }>;

const remote = (overrides: Partial<HttpInput> = {}): HttpInput => ({
  name: "remote",
  transport: "http",
  url: `https://mcp.test:${port}/mcp`,
  secretHeaders: { Authorization: { secret: "DOCS_KEY", prefix: "Bearer " } },
  ...overrides,
});

/** Starts a discovery and waits for its end. */
async function discover(
  engine: Engine,
  profileId: string,
  server: McpServerInput,
): Promise<McpDiscovery> {
  const { discovery } = await engine.mcp.startDiscovery(profileId, { server });
  expect(discovery).toMatchObject({
    status: "queued",
    profileId,
    server: server.name,
    snapshot: null,
    finishedAt: null,
  });
  return until(
    async () => {
      const { discovery: now } = await engine.mcp.discovery(discovery.id);
      return now.status === "succeeded" || now.status === "failed"
        ? now
        : undefined;
    },
    { what: `discovery ${discovery.id}`, timeoutMs: 30_000 },
  );
}

/** The snapshot of a discovery that must have succeeded. */
function snapshotOf(discovery: McpDiscovery): McpToolSnapshot {
  expect(discovery.error).toBeNull();
  expect(discovery.status).toBe("succeeded");
  if (!discovery.snapshot) throw new Error("no snapshot");
  return discovery.snapshot;
}

const failure = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
};

/** Every row a discovery or profile save writes, as text: none may hold a secret value. */
async function expectNoSecretStored() {
  const exec = db.database.db;
  const stored = JSON.stringify([
    await exec.select().from(mcpDiscoveries),
    await exec.select().from(mcpToolSnapshots),
    await exec.select().from(jobs),
    await exec.select().from(runtimeProfiles),
  ]);
  expect(stored.length).toBeGreaterThan(100);
  for (const secret of [TOKEN, HEADER_TOKEN])
    for (let at = 0; at + 8 <= secret.length; at += 4)
      expect(stored).not.toContain(secret.slice(at, at + 8));
}

describe("MCP discovery", () => {
  it(
    "discovers a stdio server in an ephemeral sandbox it releases, and stores a redacted snapshot",
    async () => {
      const { engine, profile, acquired } = await setup();
      const server = mcpFixture();
      const discovery = await discover(engine, profile.id, server);
      const snapshot = snapshotOf(discovery);
      expect(snapshot).toMatchObject({
        profileId: profile.id,
        server: "docs",
        configHash: mcpConfigHash(
          mcpServerSchema.parse(server),
          profile.sandbox,
        ),
        serverInfo: {
          name: "docs-fixture",
          version: "1.2.3",
          protocolVersion: "2025-11-25",
        },
        warnings: [],
      });
      expect(
        snapshot.tools.map((tool) => [tool.name, tool.exposedName]),
      ).toEqual([
        ["leaky", "mcp__docs__leaky"],
        ["search", "mcp__docs__search"],
      ]);
      const [leaky, search] = snapshot.tools;
      // secretEnv reached the server inside the sandbox, as DOCS_TOKEN ...
      expect(search?.description).toBe(
        `Searches the docs (a token of ${TOKEN.length} characters).`,
      );
      expect(search?.annotations).toEqual({ readOnlyHint: true });
      // ... and whatever it said with it is stored redacted.
      expect(leaky?.description).toBe("Calls the docs API with [redacted].");
      // The server's instructions are never kept.
      expect(JSON.stringify(snapshot)).not.toContain("Ignore every rule");
      expect(discovery.durationMs).toBeGreaterThanOrEqual(0);
      expect(discovery.finishedAt).not.toBeNull();
      expect((await engine.mcp.snapshot(snapshot.id)).snapshot).toEqual(
        snapshot,
      );

      // One sandbox of its own: the profile's spec, ephemeral, with the
      // profile's grants, and released, its files gone.
      expect(acquired).toHaveLength(1);
      expect(acquired[0]).toMatchObject({
        spec: { driver: "local", workspace: "ephemeral" },
        secrets: ["DOCS_SECRET"],
        released: true,
      });
      expect(existsSync(acquired[0]?.workspaceDir ?? "")).toBe(false);
      await expectNoSecretStored();
    },
    OPEN_TIMEOUT,
  );

  it(
    "fails a server that crashes as it starts, with its exit code and redacted stderr, and releases its sandbox",
    async () => {
      const { engine, profile, acquired } = await setup();
      const discovery = await discover(
        engine,
        profile.id,
        mcpFixture({ mode: "crash" }),
      );
      expect(discovery).toMatchObject({
        status: "failed",
        snapshot: null,
        stderrTail: "fatal: the docs API refused [redacted]",
      });
      expect(discovery.error).toBe(
        "MCP server docs exited with code 3 while it started.",
      );
      expect(acquired.map((entry) => entry.released)).toEqual([true]);
      await expectNoSecretStored();
    },
    OPEN_TIMEOUT,
  );

  it(
    "fails a server that does not answer initialize within its startup timeout, and releases its sandbox",
    async () => {
      const { engine, profile, acquired } = await setup();
      const discovery = await discover(
        engine,
        profile.id,
        mcpFixture({ mode: "silent", startupTimeoutSec: 1 }),
      );
      expect(discovery).toMatchObject({ status: "failed", snapshot: null });
      expect(discovery.error).toBe(
        "MCP server docs did not answer initialize within 1 s; it was stopped.",
      );
      expect(discovery.durationMs).toBeGreaterThanOrEqual(1_000);
      expect(acquired.map((entry) => entry.released)).toEqual([true]);
    },
    OPEN_TIMEOUT,
  );

  it(
    "fails a command that cannot start, and releases its sandbox",
    async () => {
      const { engine, profile, acquired } = await setup();
      const discovery = await discover(engine, profile.id, {
        name: "missing",
        transport: "stdio",
        command: join(tmpdir(), "jj-no-such-command"),
      });
      expect(discovery.status).toBe("failed");
      expect(discovery.error).toMatch(/^MCP server missing /);
      expect(acquired.map((entry) => entry.released)).toEqual([true]);
    },
    OPEN_TIMEOUT,
  );

  it(
    "keeps the tools of a hostile listing it can, and leaves out the rest with warnings",
    async () => {
      const { engine, profile } = await setup();
      const snapshot = snapshotOf(
        await discover(engine, profile.id, mcpFixture({ mode: "hostile" })),
      );
      expect(snapshot.tools.map((tool) => tool.name)).toEqual(["ok", "regex"]);
      const regex = snapshot.tools.find((tool) => tool.name === "regex");
      expect(JSON.stringify(regex?.inputSchema)).not.toContain("pattern");
      expect(snapshot.warnings).toEqual([
        expect.stringMatching(/^deep: left out, since /),
        expect.stringMatching(/^regex: .*pattern/),
      ]);
    },
    OPEN_TIMEOUT,
  );

  it(
    "discovers a remote server through the guard with its secret header, calling only initialize and tools/list",
    async () => {
      const { engine, profile, acquired } = await setup();
      const snapshot = snapshotOf(await discover(engine, profile.id, remote()));
      expect(snapshot).toMatchObject({
        server: "remote",
        serverInfo: { name: "remote-fixture", version: "2.0.0" },
      });
      expect(snapshot.tools).toEqual([
        expect.objectContaining({
          name: "lookup",
          exposedName: "mcp__remote__lookup",
          description: "Looks things up as Bearer [redacted].",
        }),
      ]);
      // The worker called it: no sandbox was started.
      expect(acquired).toEqual([]);
      const posted = received.filter((entry) => entry.method !== "DELETE");
      expect(posted.map((entry) => entry.method)).toEqual([
        "initialize",
        "notifications/initialized",
        "tools/list",
      ]);
      expect(new Set(received.map((entry) => entry.authorization))).toEqual(
        new Set([`Bearer ${HEADER_TOKEN}`]),
      );
      await expectNoSecretStored();
    },
    OPEN_TIMEOUT,
  );

  it(
    "fails a remote server whose name resolves to a private address, without contacting it",
    async () => {
      const { engine, profile } = await setup();
      const discovery = await discover(
        engine,
        profile.id,
        remote({ url: `https://internal.test:${port}/mcp` }),
      );
      expect(discovery.status).toBe("failed");
      expect(discovery.error).toContain("not public");
      expect(received).toEqual([]);
    },
    OPEN_TIMEOUT,
  );

  it("refuses to test what this server cannot run, or a configuration the profile cannot back", async () => {
    const { engine, profile } = await setup();
    const refused = async (server: McpServerInput, code: string) => {
      const error = await failure(
        engine.mcp.startDiscovery(profile.id, { server }),
      );
      expect(error.code).toBe(code);
      return error.message;
    };
    expect(
      await refused(
        mcpFixture({ secretEnv: { DOCS_TOKEN: "OTHER_SECRET" } }),
        "VALIDATION_FAILED",
      ),
    ).toBe(
      "server.secretEnv.DOCS_TOKEN: OTHER_SECRET is not granted by this profile; grant it under secrets first.",
    );
    expect(
      await refused(
        remote({
          secretHeaders: { Authorization: { secret: "MISSING_KEY" } },
        }),
        "VALIDATION_FAILED",
      ),
    ).toBe(
      "server.secretHeaders.Authorization: no sandbox secret named MISSING_KEY is stored. Add it in Settings → Secrets first.",
    );
    await refused(
      { name: "Bad Name", transport: "stdio", command: "x" },
      "VALIDATION_FAILED",
    );
    expect(
      (
        await failure(
          engine.mcp.startDiscovery("prof_missing", { server: mcpFixture() }),
        )
      ).code,
    ).toBe("NOT_FOUND");
    // Nothing was queued by the refusals.
    const queued = await db.database.db
      .select()
      .from(mcpDiscoveries)
      .where(eq(mcpDiscoveries.profileId, profile.id));
    expect(queued).toEqual([]);
  });

  it("refuses servers this server cannot run, in discoveries and profiles", async () => {
    const off = await setup({ env: { JJ_MCP_REMOTE: "off" } });
    const remoteOff = await failure(
      off.engine.mcp.startDiscovery(off.profile.id, { server: remote() }),
    );
    expect(remoteOff.code).toBe("MCP_UNAVAILABLE");
    expect(remoteOff.message).toBe(
      "server: remote is a remote server, and remote MCP servers are turned off on this server (JJ_MCP_REMOTE=off).",
    );
    expect(
      (
        await failure(
          off.engine.profiles.update(off.profile.id, {
            mcpServers: [remote()],
          }),
        )
      ).code,
    ).toBe("MCP_UNAVAILABLE");
    await reset();

    const noSpawn = await setup({ spawn: false });
    const stdio = await failure(
      noSpawn.engine.mcp.startDiscovery(noSpawn.profile.id, {
        server: mcpFixture(),
      }),
    );
    expect(stdio.code).toBe("MCP_UNAVAILABLE");
    expect(stdio.message).toBe(
      "server: docs runs in the task's sandbox, and the local driver cannot start long-lived processes (spawn).",
    );
    expect(
      (
        await failure(
          noSpawn.engine.profiles.update(noSpawn.profile.id, {
            mcpServers: [mcpFixture()],
          }),
        )
      ).message,
    ).toBe(
      "mcpServers.0: docs runs in the task's sandbox, and the local driver cannot start long-lived processes (spawn).",
    );
    // A remote server needs no spawn.
    await noSpawn.engine.profiles.update(noSpawn.profile.id, {
      mcpServers: [remote()],
    });
    await reset();

    const noClient = await setup({ mcp: false });
    // One at a time: each refusal is awaited before the next starts.
    for (const attempt of [
      () =>
        noClient.engine.mcp.startDiscovery(noClient.profile.id, {
          server: remote(),
        }),
      () =>
        noClient.engine.profiles.update(noClient.profile.id, {
          mcpServers: [remote()],
        }),
    ])
      expect((await failure(attempt())).code).toBe("MCP_UNAVAILABLE");
  });

  it(
    "keeps at most one test of a server queued or running, and answers a second test with it",
    async () => {
      const { engine, profile } = await setup();
      await engine.worker.stop();
      const start = async (server: McpServerInput) =>
        (await engine.mcp.startDiscovery(profile.id, { server })).discovery;
      const first = await start(mcpFixture());
      // Another draft of the same server while the first waits: the first.
      expect(await start(mcpFixture({ mode: "hostile" }))).toEqual(first);
      const other = await start(mcpFixture({ name: "docs_two" }));
      expect(other.id).not.toBe(first.id);
      const queued = await db.database.db
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          sql`${jobs.kind} = 'mcp.discover' and ${jobs.status} = 'queued' and ${jobs.payload}->>'discoveryId' in (${first.id}, ${other.id})`,
        );
      expect(queued).toHaveLength(2);
      await engine.worker.start();
      for (const id of [first.id, other.id])
        await until(async () => {
          const { discovery } = await engine.mcp.discovery(id);
          return discovery.status === "succeeded";
        });
      // Once it finished, a new test is a new discovery.
      expect((await start(mcpFixture())).id).not.toBe(first.id);
    },
    OPEN_TIMEOUT,
  );

  for (const concurrency of [2, 1])
    it(
      `runs a discovery under steady chat load, with ${concurrency} slot${concurrency === 1 ? "" : "s"}`,
      async () => {
        const chat = new SlowChat();
        let startedAt = Number.POSITIVE_INFINITY;
        const { engine, profile } = await setup({
          chat,
          config: { concurrency, discoveryMaxWaitMs: 1_000 },
          // With a slot of its own, the discovery holds it until a chat reply
          // starts beside it: it cannot finish unless the chat goes on. (A
          // count of replies over its lifetime failed when it finished
          // before the next reply.)
          holdAcquire: async () => {
            startedAt = performance.now();
            if (concurrency > 1)
              await until(() => chat.started.some((at) => at > startedAt), {
                what: "a chat reply beside the discovery",
                timeoutMs: 20_000,
              });
          },
        });
        const load = await chatLoad(engine, chat);
        try {
          // Steady: chat replies wait for a slot as the discovery is queued.
          await until(async () => (await chatRepliesQueued()) >= 2, {
            what: "chat replies waiting for a slot",
          });
          const queuedAt = performance.now();
          const discovery = await discover(engine, profile.id, mcpFixture());
          // Never starved: it ran, and succeeded.
          expect(discovery).toMatchObject({ status: "succeeded", error: null });
          // The chat kept going meanwhile: with one slot, a reply finished
          // while the discovery waited for the slot; with two, one started
          // beside it.
          const replies =
            concurrency > 1
              ? chat.started.filter((at) => at > startedAt)
              : chat.finished.filter((at) => at > queuedAt && at < startedAt);
          expect(replies.length).toBeGreaterThan(0);
          // With one slot the discovery yields to waiting chat for
          // `discoveryMaxWaitMs`, then takes the slot.
          if (concurrency === 1)
            expect(startedAt - queuedAt).toBeGreaterThanOrEqual(1_000);
        } finally {
          await load.stop();
        }
      },
      OPEN_TIMEOUT,
    );

  it(
    "runs at most one discovery at a time, so session runs and chat replies keep their slots",
    async () => {
      const { engine, profile } = await setup({ config: { concurrency: 2 } });
      const silent = (name: string) =>
        mcpFixture({ name, mode: "silent", startupTimeoutSec: 60 });
      const ids: string[] = [];
      for (const name of ["one", "two", "three"])
        ids.push(
          (
            await engine.mcp.startDiscovery(profile.id, {
              server: silent(name),
            })
          ).discovery.id,
        );
      const statuses = async () =>
        Promise.all(
          ids.map(
            async (id) => (await engine.mcp.discovery(id)).discovery.status,
          ),
        );
      await until(async () => (await statuses()).includes("running"));
      // A chat reply still gets the other slot while the discovery hangs.
      const { bot } = await engine.bots.create({ name: uniqueName("Ada") });
      current?.chat.brain(bot.name, () => ({ text: "Still here." }));
      await engine.bots.sendMessage(bot.id, { text: "hello" });
      await until(
        async () =>
          (await engine.bots.conversation(bot.id)).messages.some(
            (message) =>
              message.role === "assistant" && message.text === "Still here.",
          ),
        { what: "the chat reply", timeoutMs: 15_000 },
      );
      expect(
        (await statuses()).filter((status) => status === "running"),
      ).toHaveLength(1);
      expect(
        (await statuses()).filter((status) => status === "queued"),
      ).toHaveLength(2);
    },
    OPEN_TIMEOUT,
  );

  it(
    "gives up a sandbox that does not start in time, and releases it when it starts late",
    async () => {
      const { engine, profile, acquired } = await setup({
        slowAcquireMs: 1_500,
        config: { discoveryAcquireMs: 300 },
      });
      const discovery = await discover(engine, profile.id, mcpFixture());
      expect(discovery).toMatchObject({
        status: "failed",
        error: "The sandbox could not start: it did not start within 0.3 s",
      });
      expect(discovery.durationMs).toBeLessThan(1_500);
      await until(() => acquired[0]?.released === true, {
        what: "the late sandbox's release",
      });
    },
    OPEN_TIMEOUT,
  );

  it(
    "stops waiting for a sandbox when the worker stops, and releases the one that starts late",
    async () => {
      const { engine, profile, acquired } = await setup({
        slowAcquireMs: 6_000,
      });
      const { discovery } = await engine.mcp.startDiscovery(profile.id, {
        server: mcpFixture(),
      });
      await until(async () =>
        (await engine.mcp.discovery(discovery.id)).discovery.status ===
        "running"
          ? true
          : undefined,
      );
      const stopping = Date.now();
      await engine.worker.stop();
      expect(Date.now() - stopping).toBeLessThan(3_000);
      expect((await engine.mcp.discovery(discovery.id)).discovery.status).toBe(
        "queued",
      );
      await until(() => acquired[0]?.released === true, {
        what: "the late sandbox's release",
      });
    },
    OPEN_TIMEOUT,
  );

  it("refuses a configuration too large to identify", async () => {
    const { engine, profile } = await setup();
    // Each control character is six in canonical JSON: past its 1 Mi limit.
    const env = Object.fromEntries(
      Array.from({ length: 64 }, (_, index) => [
        `V${index}`,
        "\u0001".repeat(4096),
      ]),
    );
    const error = await failure(
      engine.mcp.startDiscovery(profile.id, { server: mcpFixture({ env }) }),
    );
    expect(error.code).toBe("VALIDATION_FAILED");
    expect(error.message).toBe(
      "docs: the configuration is too large to identify; use shorter args, env or headers.",
    );
  });

  it(
    "hands a running discovery back when the worker stops, and releases its sandbox",
    async () => {
      const { engine, profile, acquired } = await setup();
      const { discovery } = await engine.mcp.startDiscovery(profile.id, {
        server: mcpFixture({ mode: "silent", startupTimeoutSec: 60 }),
      });
      await until(async () =>
        (await engine.mcp.discovery(discovery.id)).discovery.status ===
        "running"
          ? true
          : undefined,
      );
      await until(() => acquired.length === 1);
      await engine.worker.stop();
      expect(
        (await engine.mcp.discovery(discovery.id)).discovery,
      ).toMatchObject({ status: "queued", error: null });
      expect(acquired.map((entry) => entry.released)).toEqual([true]);
      const waiting = await db.database.db
        .select()
        .from(jobs)
        .where(
          sql`${jobs.kind} = 'mcp.discover' and ${jobs.status} = 'queued' and ${jobs.payload}->>'discoveryId' = ${discovery.id}`,
        );
      expect(waiting).toHaveLength(1);
    },
    OPEN_TIMEOUT,
  );

  it("fails a discovery whose job's lease ran out too often", async () => {
    const { engine, profile } = await setup();
    await engine.worker.stop();
    const [row] = await db.database.db
      .insert(mcpDiscoveries)
      .values({
        id: "mcpd_given_up",
        profileId: profile.id,
        server: "docs",
        config: mcpServerSchema.parse(mcpFixture()),
        configHash: "0".repeat(64),
        status: "running",
      })
      .returning();
    await db.database.db.insert(jobs).values({
      id: "job_given_up",
      kind: "mcp.discover",
      payload: { discoveryId: row?.id },
      status: "running",
      leaseOwner: "gone",
      leaseUntil: new Date(Date.now() - 60_000),
      attempts: 3,
      maxAttempts: 3,
    });
    await engine.worker.start();
    const failed = await until(async () => {
      const { discovery } = await engine.mcp.discovery("mcpd_given_up");
      return discovery.status === "failed" ? discovery : undefined;
    });
    expect(failed.error).toBe(
      "The worker testing this server stopped too many times; test it again.",
    );
  });
});

describe("profile save-time rules", () => {
  it(
    "pins a snapshot whose configuration matches, and refuses one that does not",
    async () => {
      const { engine, profile } = await setup();
      const server = mcpFixture();
      const snapshot = snapshotOf(await discover(engine, profile.id, server));
      const pinned = { ...server, snapshotId: snapshot.id };
      const { profile: saved } = await engine.profiles.update(profile.id, {
        mcpServers: [pinned],
      });
      expect(saved.mcpServers).toEqual([mcpServerSchema.parse(pinned)]);
      // What does not change what runs keeps the pin.
      await engine.profiles.update(profile.id, {
        mcpServers: [
          {
            ...pinned,
            description: "The docs.",
            timeoutSec: 30,
            enabled: false,
          },
        ],
      });

      const mismatch = async (
        mcpServers: McpServerInput[],
        id = profile.id,
      ) => {
        const error = await failure(engine.profiles.update(id, { mcpServers }));
        expect(error.code).toBe("MCP_SNAPSHOT_MISMATCH");
        expect(error.status).toBe(409);
        return error.message;
      };
      expect(
        await mismatch([{ ...pinned, args: [...pinned.args, "extra"] }]),
      ).toBe(
        `mcpServers.0.snapshotId: ${snapshot.id} was discovered for another configuration of docs, or another sandbox. Test the server again with the new sandbox settings, then save the snapshot it finds together with them.`,
      );
      await mismatch([{ ...pinned, env: { FIXTURE_MODE: "crash" } }]);
      await mismatch([
        {
          ...pinned,
          secretEnv: { DOCS_TOKEN: "DOCS_SECRET", X: "DOCS_SECRET" },
        },
      ]);
      expect(await mismatch([{ ...pinned, name: "docs_two" }])).toBe(
        `mcpServers.0.snapshotId: ${snapshot.id} is not a snapshot of docs_two in this profile. Test the server and pin the snapshot it finds.`,
      );
      await mismatch([{ ...pinned, snapshotId: "mcps_missing" }]);
      // Another profile's snapshot, even of the same configuration.
      const { profile: other } = await engine.profiles.create({
        name: "Other",
        sandbox: { driver: "local", network: { mode: "open" } },
        secrets: ["DOCS_SECRET"],
      });
      await mismatch([pinned], other.id);
      const created = await failure(
        engine.profiles.create({
          name: "New",
          sandbox: { driver: "local", network: { mode: "open" } },
          secrets: ["DOCS_SECRET"],
          mcpServers: [pinned],
        }),
      );
      expect(created.code).toBe("MCP_SNAPSHOT_MISMATCH");
      // A name-only patch never rechecks the servers.
      await engine.profiles.update(profile.id, { name: "Renamed" });
    },
    OPEN_TIMEOUT,
  );

  it(
    "takes a stdio server's snapshot to hold for the sandbox it was discovered in only",
    async () => {
      const { engine, profile } = await setup();
      const server = mcpFixture();
      const snapshot = snapshotOf(await discover(engine, profile.id, server));
      const remoteSnapshot = snapshotOf(
        await discover(engine, profile.id, remote()),
      );
      await engine.profiles.update(profile.id, {
        mcpServers: [
          { ...server, snapshotId: snapshot.id },
          { ...remote(), snapshotId: remoteSnapshot.id },
        ],
      });
      // The sandbox's env can change what a stdio server lists.
      const moved = await failure(
        engine.profiles.update(profile.id, {
          sandbox: { env: { REGION: "eu" } },
        }),
      );
      expect(moved.code).toBe("MCP_SNAPSHOT_MISMATCH");
      expect(moved.message).toBe(
        `mcpServers.0.snapshotId: ${snapshot.id} was discovered for another configuration of docs, or another sandbox. Test the server again with the new sandbox settings, then save the snapshot it finds together with them.`,
      );
      // Limits do not, and the worker calls a remote server whatever the sandbox.
      await engine.profiles.update(profile.id, {
        sandbox: { limits: { execTimeoutMs: 60_000 } },
      });
      await engine.profiles.update(profile.id, {
        mcpServers: [{ ...remote(), snapshotId: remoteSnapshot.id }],
      });
      await engine.profiles.update(profile.id, {
        sandbox: { env: { REGION: "eu" } },
      });
    },
    OPEN_TIMEOUT,
  );

  it(
    "changes the sandbox of a profile with a pinned stdio snapshot: test with the draft, then save both",
    async () => {
      const { engine, profile } = await setup();
      const server = mcpFixture();
      const first = snapshotOf(await discover(engine, profile.id, server));
      await engine.profiles.update(profile.id, {
        mcpServers: [{ ...server, snapshotId: first.id }],
        approvals: [{ tool: "mcp__docs__search" }],
      });
      const sandbox = { env: { REGION: "eu" } };
      const refused = await failure(
        engine.profiles.update(profile.id, { sandbox }),
      );
      expect(refused.code).toBe("MCP_SNAPSHOT_MISMATCH");
      expect(refused.message).toBe(
        `mcpServers.0.snapshotId: ${first.id} was discovered for another configuration of docs, or another sandbox. Test the server again with the new sandbox settings, then save the snapshot it finds together with them.`,
      );
      // The test runs on the draft sandbox, and its snapshot is for it ...
      const draft = { ...profile.sandbox, env: { REGION: "eu" } };
      const { discovery: queued } = await engine.mcp.startDiscovery(
        profile.id,
        { server, sandbox: draft },
      );
      const second = snapshotOf(
        await until(
          async () => {
            const { discovery } = await engine.mcp.discovery(queued.id);
            return discovery.status === "queued" ||
              discovery.status === "running"
              ? undefined
              : discovery;
          },
          { what: "the draft's discovery" },
        ),
      );
      expect(second.configHash).toBe(
        mcpConfigHash(mcpServerSchema.parse(server), draft),
      );
      expect(second.configHash).not.toBe(first.configHash);
      // ... so the change and the new pin save together, the rule kept.
      const { profile: saved } = await engine.profiles.update(profile.id, {
        sandbox,
        mcpServers: [{ ...server, snapshotId: second.id }],
      });
      expect(saved.sandbox.env).toEqual({ REGION: "eu" });
      expect(saved.mcpServers[0]?.snapshotId).toBe(second.id);
      expect(saved.approvals).toEqual([{ tool: "mcp__docs__search" }]);
      // A draft the driver cannot enforce is refused before anything queues.
      const unsupported = await failure(
        engine.mcp.startDiscovery(profile.id, {
          server,
          sandbox: { ...draft, network: { mode: "none" } },
        }),
      );
      expect(unsupported.code).toBe("PROFILE_UNSUPPORTED");
    },
    OPEN_TIMEOUT,
  );

  it(
    "checks exact approval rules against the pinned snapshot, on the merged profile",
    async () => {
      const { engine, profile } = await setup();
      const server = mcpFixture();
      const snapshot = snapshotOf(await discover(engine, profile.id, server));
      const pinned = { ...server, snapshotId: snapshot.id };
      const ruled = await engine.profiles.update(profile.id, {
        mcpServers: [pinned],
        approvals: [{ tool: "mcp__docs__search" }, { tool: "mcp__docs__*" }],
      });
      expect(ruled.profile.approvals).toEqual([
        { tool: "mcp__docs__search" },
        { tool: "mcp__docs__*" },
      ]);
      const unknown = await failure(
        engine.profiles.update(profile.id, {
          approvals: [{ tool: "bash" }, { tool: "mcp__docs__nope" }],
        }),
      );
      expect(unknown.code).toBe("VALIDATION_FAILED");
      expect(unknown.message).toBe(
        "approvals.1.tool: mcp__docs__nope names no tool of its MCP server's pinned snapshot. Exact names hold only within a snapshot; mcp__<server>__* covers every tool of a server.",
      );
      // Unpinning the snapshot leaves the stored rule naming nothing.
      const unpinned = await failure(
        engine.profiles.update(profile.id, {
          mcpServers: [{ ...server, snapshotId: null }],
        }),
      );
      expect(unpinned.message).toMatch(
        /^approvals\.0\.tool: mcp__docs__search names no tool/,
      );
      // Without the server, only the server-wide rule may stay.
      await engine.profiles.update(profile.id, {
        mcpServers: [],
        approvals: [{ tool: "mcp__docs__*" }],
      });
      expect(
        (
          await failure(
            engine.profiles.create({
              name: "Exact",
              sandbox: { driver: "local", network: { mode: "open" } },
              approvals: [{ tool: "mcp__docs__search" }],
            }),
          )
        ).code,
      ).toBe("VALIDATION_FAILED");
    },
    OPEN_TIMEOUT,
  );

  it("requires each secretEnv secret to be granted, and each secretHeaders secret stored, on the merged profile", async () => {
    const { engine, profile } = await setup();
    const ungranted = await failure(
      engine.profiles.update(profile.id, {
        mcpServers: [mcpFixture({ secretEnv: { DOCS_TOKEN: "DOCS_KEY" } })],
      }),
    );
    expect(ungranted.code).toBe("VALIDATION_FAILED");
    expect(ungranted.message).toBe(
      "mcpServers.0.secretEnv.DOCS_TOKEN: DOCS_KEY is not granted by this profile; grant it under secrets first.",
    );
    await engine.profiles.update(profile.id, { mcpServers: [mcpFixture()] });
    // Taking the grant away from a server that uses it is refused.
    const revoked = await failure(
      engine.profiles.update(profile.id, { secrets: [] }),
    );
    expect(revoked.message).toBe(
      "mcpServers.0.secretEnv.DOCS_TOKEN: DOCS_SECRET is not granted by this profile; grant it under secrets first.",
    );
    const missing = await failure(
      engine.profiles.update(profile.id, {
        mcpServers: [
          remote({ secretHeaders: { "X-Key": { secret: "MISSING_KEY" } } }),
        ],
      }),
    );
    expect(missing.code).toBe("VALIDATION_FAILED");
    expect(missing.message).toBe(
      "mcpServers.0.secretHeaders.X-Key: no sandbox secret named MISSING_KEY is stored. Add it in Settings → Secrets first.",
    );
    // Sent by the worker, a header's secret needs no grant.
    const { profile: saved } = await engine.profiles.update(profile.id, {
      mcpServers: [mcpFixture(), remote()],
    });
    expect(saved.mcpServers.map((server) => server.name)).toEqual([
      "docs",
      "remote",
    ]);
    expect(saved.secrets).toEqual(["DOCS_SECRET"]);
    // Skills are still refused.
    expect(
      (await failure(engine.profiles.update(profile.id, { skills: ["pdf"] })))
        .code,
    ).toBe("MCP_UNAVAILABLE");
  });

  it(
    "refuses a profile that would declare more than 64 MCP tools",
    async () => {
      const { engine, profile } = await setup();
      const server = mcpFixture({ mode: "many:70" });
      const snapshot = snapshotOf(await discover(engine, profile.id, server));
      expect(snapshot.tools).toHaveLength(70);
      const pinned = { ...server, snapshotId: snapshot.id };
      const over = await failure(
        engine.profiles.update(profile.id, { mcpServers: [pinned] }),
      );
      expect(over.code).toBe("VALIDATION_FAILED");
      expect(over.message).toBe(
        "mcpServers: this profile would declare 70 MCP tools, over the limit of 64. Set some servers or tools to hidden, or disable a server.",
      );
      // Hidden by default, with 64 shown, it fits; so does a disabled server.
      const shown = Object.fromEntries(
        snapshot.tools
          .slice(0, 64)
          .map((tool) => [tool.name, "direct" as const]),
      );
      await engine.profiles.update(profile.id, {
        mcpServers: [{ ...pinned, exposure: "hidden", toolExposure: shown }],
      });
      await engine.profiles.update(profile.id, {
        mcpServers: [{ ...pinned, enabled: false }],
      });
    },
    OPEN_TIMEOUT,
  );

  it(
    "leaves disabled servers out of what only running servers need, and checks them once enabled",
    async () => {
      // With remote servers off, a disabled remote server still saves ...
      const off = await setup({ env: { JJ_MCP_REMOTE: "off" } });
      await off.engine.profiles.update(off.profile.id, {
        mcpServers: [{ ...remote(), enabled: false }],
      });
      // Also beside an enabled server that can run here.
      await off.engine.profiles.update(off.profile.id, {
        mcpServers: [mcpFixture(), { ...remote(), enabled: false }],
      });
      expect(
        (
          await failure(
            off.engine.profiles.update(off.profile.id, {
              mcpServers: [remote()],
            }),
          )
        ).code,
      ).toBe("MCP_UNAVAILABLE");
      // ... and testing a disabled draft checks it as it would run.
      expect(
        (
          await failure(
            off.engine.mcp.startDiscovery(off.profile.id, {
              server: { ...remote(), enabled: false },
            }),
          )
        ).code,
      ).toBe("MCP_UNAVAILABLE");
      const ungranted = await failure(
        off.engine.mcp.startDiscovery(off.profile.id, {
          server: mcpFixture({
            enabled: false,
            secretEnv: { DOCS_TOKEN: "DOCS_KEY" },
          }),
        }),
      );
      expect(ungranted.message).toBe(
        "server.secretEnv.DOCS_TOKEN: DOCS_KEY is not granted by this profile; grant it under secrets first.",
      );
      await reset();

      // A disabled server's pin does not stop a sandbox change; enabling it
      // checks the pin against the new sandbox.
      const { engine, profile } = await setup();
      const unstored = await failure(
        engine.mcp.startDiscovery(profile.id, {
          server: {
            ...remote({
              secretHeaders: { "X-Key": { secret: "MISSING_KEY" } },
            }),
            enabled: false,
          },
        }),
      );
      expect(unstored.message).toBe(
        "server.secretHeaders.X-Key: no sandbox secret named MISSING_KEY is stored. Add it in Settings → Secrets first.",
      );
      const server = mcpFixture();
      const snapshot = snapshotOf(await discover(engine, profile.id, server));
      await engine.profiles.update(profile.id, {
        mcpServers: [{ ...server, snapshotId: snapshot.id, enabled: false }],
        approvals: [{ tool: "mcp__docs__search" }],
      });
      await engine.profiles.update(profile.id, {
        sandbox: { env: { REGION: "eu" } },
      });
      expect(
        (
          await failure(
            engine.profiles.update(profile.id, {
              mcpServers: [{ ...server, snapshotId: snapshot.id }],
            }),
          )
        ).code,
      ).toBe("MCP_SNAPSHOT_MISMATCH");
    },
    OPEN_TIMEOUT,
  );

  it("disables the servers that use a secret when it is removed", async () => {
    const { engine, profile } = await setup();
    await engine.profiles.update(profile.id, {
      mcpServers: [mcpFixture(), remote()],
    });
    await engine.secrets.delete("DOCS_SECRET");
    let { profile: stored } = await engine.profiles.get(profile.id);
    expect(stored.secrets).toEqual([]);
    expect(
      stored.mcpServers.map((server) => [server.name, server.enabled]),
    ).toEqual([
      ["docs", false],
      ["remote", true],
    ]);
    await engine.secrets.delete("DOCS_KEY");
    ({ profile: stored } = await engine.profiles.get(profile.id));
    expect(stored.mcpServers.map((server) => server.enabled)).toEqual([
      false,
      false,
    ]);
    // The profile still saves, its servers and grants included: disabled
    // servers keep their references, and the secret rules skip them.
    await engine.profiles.update(profile.id, { name: "Still here" });
    await engine.profiles.update(profile.id, { secrets: [] });
    await engine.profiles.update(profile.id, {
      mcpServers: stored.mcpServers,
    });
    // Enabling one again checks it, and says what it lacks.
    const [stdio, http] = stored.mcpServers;
    const again = await failure(
      engine.profiles.update(profile.id, {
        mcpServers: [{ ...(stdio as McpServerInput), enabled: true }],
      }),
    );
    expect(again.message).toBe(
      "mcpServers.0.secretEnv.DOCS_TOKEN: DOCS_SECRET is not granted by this profile; grant it under secrets first.",
    );
    const remoteAgain = await failure(
      engine.profiles.update(profile.id, {
        mcpServers: [{ ...(http as McpServerInput), enabled: true }],
      }),
    );
    expect(remoteAgain.message).toBe(
      "mcpServers.0.secretHeaders.Authorization: no sandbox secret named DOCS_KEY is stored. Add it in Settings → Secrets first.",
    );
    // The contract's check skips them too: a patch carrying both lists, and
    // a create, save the disabled servers ...
    await engine.profiles.update(profile.id, {
      secrets: [],
      mcpServers: stored.mcpServers,
    });
    const sandbox = { driver: "local", network: { mode: "open" as const } };
    const { profile: copy } = await engine.profiles.create({
      name: "Copy",
      sandbox,
      secrets: [],
      mcpServers: stored.mcpServers,
    });
    expect(copy.mcpServers.map((server) => server.enabled)).toEqual([
      false,
      false,
    ]);
    // ... and refuse one enabled without its grant, in both.
    for (const attempt of [
      () =>
        engine.profiles.update(profile.id, {
          secrets: [],
          mcpServers: [{ ...(stdio as McpServerInput), enabled: true }],
        }),
      () =>
        engine.profiles.create({
          name: "Enabled copy",
          sandbox,
          secrets: [],
          mcpServers: [{ ...(stdio as McpServerInput), enabled: true }],
        }),
    ]) {
      const refused = await failure(attempt());
      expect(refused.code).toBe("VALIDATION_FAILED");
      expect(refused.message).toBe(
        "mcpServers.0.secretEnv.DOCS_TOKEN: DOCS_SECRET is not granted by this profile; grant it under secrets first.",
      );
    }
  });
});

describe("discovery retention", () => {
  it(
    "keeps a profile's newest finished discoveries, every unfinished one, and the snapshots it pins or they hold",
    async () => {
      const { engine, profile } = await setup();
      await engine.worker.stop();
      const exec = db.database.db;
      const config = mcpServerSchema.parse(mcpFixture());
      const snapshot = (id: string) =>
        exec.insert(mcpToolSnapshots).values({
          id,
          profileId: profile.id,
          server: "docs",
          configHash: mcpConfigHash(config, profile.sandbox),
          serverInfo: { name: "x", version: "1", protocolVersion: "1" },
          tools: [],
        });
      // The oldest finished discovery's snapshot is pinned; the second's is not.
      await snapshot("mcps_pinned");
      await snapshot("mcps_dropped");
      await snapshot("mcps_kept");
      const finished = MAX_KEPT_DISCOVERIES + 2;
      for (let index = 0; index < finished; index++)
        await exec.insert(mcpDiscoveries).values({
          id: `mcpd_old_${String(index).padStart(2, "0")}`,
          profileId: profile.id,
          server: "docs",
          config,
          configHash: mcpConfigHash(config, profile.sandbox),
          status: index === 3 ? "failed" : "succeeded",
          snapshotId:
            index === 0
              ? "mcps_pinned"
              : index === 1
                ? "mcps_dropped"
                : index === finished - 1
                  ? "mcps_kept"
                  : null,
          createdAt: new Date(Date.now() - (100 - index) * 60_000),
        });
      // Older than all of them, and still running: a client may poll it.
      await exec.insert(mcpDiscoveries).values({
        id: "mcpd_running",
        profileId: profile.id,
        server: "other",
        config: { ...config, name: "other" },
        configHash: mcpConfigHash(config, profile.sandbox),
        status: "running",
        createdAt: new Date(Date.now() - 200 * 60_000),
      });
      await engine.profiles.update(profile.id, {
        mcpServers: [{ ...config, snapshotId: "mcps_pinned" }],
      });
      // A new test prunes the finished ones to the newest 20: the oldest two go.
      await engine.mcp.startDiscovery(profile.id, { server: config });
      const kept = (
        await exec
          .select({ id: mcpDiscoveries.id })
          .from(mcpDiscoveries)
          .where(eq(mcpDiscoveries.profileId, profile.id))
      ).map((row) => row.id);
      expect(kept).toHaveLength(MAX_KEPT_DISCOVERIES + 2);
      expect(kept).not.toContain("mcpd_old_00");
      expect(kept).not.toContain("mcpd_old_01");
      expect(kept).toContain("mcpd_old_02");
      expect(kept).toContain("mcpd_running");
      const snapshots = await exec
        .select({ id: mcpToolSnapshots.id })
        .from(mcpToolSnapshots)
        .where(eq(mcpToolSnapshots.profileId, profile.id));
      expect(snapshots.map((row) => row.id).sort()).toEqual([
        "mcps_kept",
        "mcps_pinned",
      ]);
      // A profile's discoveries and snapshots go with it.
      await engine.profiles.update(profile.id, { mcpServers: [] });
      await engine.profiles.delete(profile.id);
      expect(
        await exec
          .select()
          .from(mcpDiscoveries)
          .where(eq(mcpDiscoveries.profileId, profile.id)),
      ).toEqual([]);
      expect(
        await exec
          .select()
          .from(mcpToolSnapshots)
          .where(eq(mcpToolSnapshots.profileId, profile.id)),
      ).toEqual([]);
    },
    OPEN_TIMEOUT,
  );
});
