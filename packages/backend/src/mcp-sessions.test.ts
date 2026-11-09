// MCP servers in sessions, end to end on the pi runtime: a session pins its
// toolset at its first run and declares it byte for byte on every run; a
// call reaches its server through the worker's connections (the stdio
// fixture in the task's `local` sandbox, a remote server on a local https
// endpoint behind the real guard), is reviewed like any call, and its
// result comes back redacted; a profile edit can only take a tool away; a
// crash is reported and restarts within the budget; a worker crash never
// runs a call twice. Also the bootstrap capabilities, and the discovery and
// worker refinements that came with this step.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Approval,
  activityFromEvent,
  bootstrapSchema,
  type McpDiscovery,
  type McpServerInput,
  type McpToolSnapshot,
  mcpServerSchema,
  type TaskEvent,
  type TaskView,
} from "@jj/contracts";
import {
  JOB_KINDS,
  jobs,
  mcpDiscoveries,
  retiredSecrets,
  secrets as secretsTable,
  sessionEntries,
  sessionToolsets,
} from "@jj/db";
import {
  INTERRUPTED_BY_RESTART,
  McpDiscoverer,
  type McpEnv,
  ModelRegistry,
  PiSessionExecutor,
} from "@jj/runtime";
import {
  callTool,
  conversation,
  declaredTools,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  say,
  textOf,
} from "@jj/runtime/testing";
import { LocalSandboxDriver } from "@jj/sandbox";
import { isPublicAddress } from "@jj/sandbox/addresses";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { EngineConfigInput } from "./config";
import { createDriverRegistry } from "./drivers";
import type { Engine } from "./engine";
import { DomainError } from "./errors";
import { createKeyring } from "./secrets/keyring";
import { SecretStore } from "./secrets/store";
import { mcpConfigHash } from "./services/mcp";
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
  untilTask,
} from "./testing/harness";
import { mcpFixture } from "./testing/mcp-fixture";
import { CLAIM_CLASSES } from "./worker/worker";

/** Granted as DOCS_SECRET; the stdio fixture gets it as DOCS_TOKEN and puts it in its output. */
const TOKEN = "docs-token-0123456789abcdefXYZ";
/** Stored as DOCS_KEY; the remote server's Authorization header sends it, and the server echoes it. */
const HEADER_TOKEN = "header-token-0123456789abcdefQRS";

let db: TestDatabase;
const engines: TestEngine[] = [];
const roots: string[] = [];

// A local https MCP endpoint (a certificate for mcp.test), reached through the guard.
let tlsDir: string;
let cert: string;
let endpoint: Server;
let port = 0;
/** What the endpoint received: JSON-RPC methods, tool calls and the Authorization header. */
const received: { method: string; tool?: string; authorization: string }[] = [];

beforeAll(async () => {
  db = await openTestDatabase();
  tlsDir = mkdtempSync(join(tmpdir(), "jj-mcp-sessions-tls-"));
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
        ...(message?.method === "tools/call"
          ? { tool: message.params?.name }
          : {}),
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
              description: "Looks a record up.",
              inputSchema: {
                type: "object",
                properties: { id: { type: "string" } },
              },
            },
          ],
        });
      else if (message.method === "tools/call")
        reply({
          content: [
            {
              type: "text",
              text: `Record ${message.params?.arguments?.id}, fetched with ${authorization}.`,
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

afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.dispose();
  await db.database.db.delete(secretsTable);
  await db.database.db.delete(retiredSecrets);
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
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

type Step = Parameters<
  ReturnType<typeof fauxProvider>["setResponses"]
>[0][number];

async function workspace() {
  const root = await mkdtemp(join(tmpdir(), "jj-mcp-sessions-"));
  roots.push(root);
  return root;
}

/**
 * An engine on the pi runtime, the `local` driver under `root`, a secrets
 * store and the runtime's MCP client: the scripted model, or a faux one
 * answering `steps`.
 */
async function start(
  root: string,
  options: {
    steps?: Step[];
    scripted?: boolean;
    env?: McpEnv;
    config?: EngineConfigInput;
    start?: boolean;
    keyring?: Buffer;
  } = {},
) {
  const faux = fauxProvider();
  faux.setResponses(options.steps ?? []);
  const models = options.scripted
    ? new ModelRegistry({ env: {}, enableScripted: true })
    : new ModelRegistry({ env: {}, extraProviders: [faux.provider] });
  const engine = await testEngine(db.database, {
    runExecutor: new PiSessionExecutor({ models }),
    workspaceRoot: root,
    ...(options.start === false ? { start: false } : {}),
    secretStore: new SecretStore({
      db: db.database.db,
      keyring: createKeyring(options.keyring ?? KEY),
    }),
    mcp: new McpDiscoverer({
      env: options.env ?? {},
      closeGraceMs: 200,
      guard: {
        ca: cert,
        isAllowedAddress: allowLoopback,
        resolve: async (host) => {
          if (host === "mcp.test") return ["127.0.0.1"];
          throw Object.assign(new Error(`getaddrinfo ENOTFOUND ${host}`), {
            code: "ENOTFOUND",
          });
        },
      },
    }),
    ...(options.config ? { config: options.config } : {}),
  });
  engines.push(engine);
  return { ...engine, faux };
}

/** One master key for every engine of a test, so a second one reads what the first stored. */
const KEY = randomBytes(32);

type HttpInput = Extract<McpServerInput, { transport: "http" }>;

const remote = (overrides: Partial<HttpInput> = {}): HttpInput => ({
  name: "remote",
  transport: "http",
  url: `https://mcp.test:${port}/mcp`,
  secretHeaders: { Authorization: { secret: "DOCS_KEY", prefix: "Bearer " } },
  ...overrides,
});

/** The stdio fixture with its session tools. */
const docs = (overrides: Parameters<typeof mcpFixture>[0] = {}) =>
  mcpFixture({ mode: "session", ...overrides });

/** Starts a discovery and waits for its end. */
async function discover(
  engine: Engine,
  profileId: string,
  server: McpServerInput,
): Promise<McpDiscovery> {
  const { discovery } = await engine.mcp.startDiscovery(profileId, { server });
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

function snapshotOf(discovery: McpDiscovery): McpToolSnapshot {
  expect(discovery.error).toBeNull();
  if (!discovery.snapshot) throw new Error("no snapshot");
  return discovery.snapshot;
}

/**
 * A profile with `servers` tested and their snapshots pinned, and a bot on
 * it. The secrets are stored and DOCS_SECRET granted.
 */
async function mcpBot(
  engine: Engine,
  servers: McpServerInput[],
  extra: { approvals?: { tool: string; match?: string }[] } = {},
) {
  await engine.secrets.put("DOCS_SECRET", { value: TOKEN });
  await engine.secrets.put("DOCS_KEY", { value: HEADER_TOKEN });
  const { profile } = await engine.profiles.create({
    name: uniqueName("MCP"),
    sandbox: { driver: "local", network: { mode: "open" } },
    secrets: ["DOCS_SECRET"],
  });
  const pinned: McpServerInput[] = [];
  const snapshots: McpToolSnapshot[] = [];
  for (const server of servers) {
    const snapshot = snapshotOf(await discover(engine, profile.id, server));
    snapshots.push(snapshot);
    pinned.push({ ...server, snapshotId: snapshot.id });
  }
  const { profile: saved } = await engine.profiles.update(profile.id, {
    mcpServers: pinned,
    ...(extra.approvals ? { approvals: extra.approvals as never } : {}),
  });
  const { bot } = await engine.bots.create({
    name: uniqueName("Ada"),
    runtimeProfileId: profile.id,
  });
  return { profile: saved, bot, snapshots, servers: pinned };
}

const taskDir = (root: string, taskId: string) => join(root, "task", taskId);

async function lines(path: string): Promise<string[]> {
  try {
    return (await readFile(path, "utf8")).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

const mcpEvents = (view: Pick<TaskView, "events">) =>
  view.events.filter(
    (event): event is Extract<TaskEvent, { type: "mcp.server" }> =>
      event.type === "mcp.server",
  );

const finished = (view: Pick<TaskView, "events">, tool: string) =>
  view.events.filter(
    (event): event is Extract<TaskEvent, { type: "tool.finished" }> =>
      event.type === "tool.finished" && event.payload.tool === tool,
  );

/** The MCP declarations of a request, as the provider received them. */
const mcpDeclarations = (
  context: Parameters<Extract<Step, (...args: never[]) => unknown>>[0],
) =>
  JSON.stringify(
    declaredTools(context).filter((tool) => tool.name.startsWith("mcp__")),
  );

/** The result the model received for one call. */
const resultOf = (
  context: Parameters<Extract<Step, (...args: never[]) => unknown>>[0],
  toolCallId: string,
) =>
  conversation(context).find(
    (message) =>
      message.role === "toolResult" && message.toolCallId === toolCallId,
  );

/** A model turn that calls one tool, with the call id `id`. */
const call = (name: string, args: Record<string, unknown>, id: string) =>
  fauxAssistantMessage(fauxToolCall(name, args as never, { id }), {
    stopReason: "toolUse",
  });

/** Every row a run writes, as text: none may hold a secret value. */
async function expectNoSecretStored(taskId: string) {
  const exec = db.database.db;
  const view = JSON.stringify(await exec.select().from(sessionEntries));
  const events = JSON.stringify(
    (await engines.at(-1)?.engine.tasks.events(taskId))?.events ?? [],
  );
  for (const stored of [view, events])
    for (const secret of [TOKEN, HEADER_TOKEN])
      for (let at = 0; at + 8 <= secret.length; at += 4)
        expect(stored).not.toContain(secret.slice(at, at + 8));
}

describe("MCP servers in sessions", () => {
  it("runs a scripted task that calls a stdio and a remote server, holds the remote call for approval and stores redacted output", async () => {
    const root = await workspace();
    const { engine } = await start(root, { scripted: true });
    const { bot, snapshots, profile } = await mcpBot(engine, [
      docs(),
      remote(),
    ]);
    const { task } = await engine.tasks.create({
      goal: 'Look things up: call `mcp__docs__search {"query":"intro"}`, then call `mcp__remote__lookup {"id":"42"}`.',
      coordinatorBotId: bot.id,
    });
    // The remote server asks unless a tool is marked read-only (its
    // default), so its call is held; the stdio one ran already.
    const held = await untilTask(
      engine,
      task.id,
      (view) =>
        view.task.status === "waiting" &&
        view.approvals.some((approval) => approval.status === "pending"),
      "the held remote call",
    );
    const approval = held.approvals[0] as Approval;
    expect(approval).toMatchObject({
      tool: "mcp__remote__lookup",
      rule: { tool: "mcp__remote__lookup" },
      args: { id: "42" },
      summary: 'remote/lookup {"id":"42"}',
    });
    expect(received.filter((entry) => entry.method === "tools/call")).toEqual(
      [],
    );
    const [search] = finished(
      await engine.tasks.events(task.id),
      "mcp__docs__search",
    );
    expect(search?.payload).toMatchObject({ ok: true });
    // The fixture put DOCS_TOKEN in its answer: stored redacted.
    expect(search?.payload.output).toBe(
      'Results for "intro": docs/intro.md (searched as [redacted])',
    );

    await engine.tasks.decideApproval(task.id, approval.id, {
      decision: "approve",
    });
    const done = await untilTask(
      engine,
      task.id,
      (view) => view.task.status === "completed",
      "the completed task",
    );
    // The approved call ran once, with the stored secret header.
    expect(received.filter((entry) => entry.method === "tools/call")).toEqual([
      {
        method: "tools/call",
        tool: "lookup",
        authorization: `Bearer ${HEADER_TOKEN}`,
      },
    ]);
    const page = await engine.tasks.events(task.id);
    const [lookup] = finished(page, "mcp__remote__lookup");
    expect(lookup?.payload).toMatchObject({ ok: true });
    expect(lookup?.payload.output).toBe(
      "Record 42, fetched with Bearer [redacted].",
    );
    expect(done.approvals[0]).toMatchObject({
      status: "approved",
      outcome: { ok: true },
    });
    expect(done.task.result).toContain("MCP results:");
    expect(done.task.result).toContain("[redacted]");

    // Each server started once, in the task, attributed to the session
    // whose call started it; the events drive its activity line.
    const events = mcpEvents(page);
    expect(
      events.map((event) => [event.payload.server, event.payload.state]),
    ).toEqual([
      ["docs", "starting"],
      ["docs", "ready"],
      ["remote", "starting"],
      ["remote", "ready"],
    ]);
    for (const event of events) {
      expect(event.payload.profileId).toBe(profile.id);
      expect(event.sessionId).toBe(done.sessions[0]?.id);
      expect(event.payload.drift).toBeUndefined();
    }
    expect(events.map((event) => activityFromEvent(event)?.text)).toEqual([
      "Starting MCP server docs",
      "Using MCP server docs",
      "Starting MCP server remote",
      "Using MCP server remote",
    ]);

    // The session pinned what its profile declared at its first run.
    const [pinned] = await db.database.db
      .select()
      .from(sessionToolsets)
      .where(eq(sessionToolsets.sessionId, done.sessions[0]?.id as string));
    expect(pinned?.mcp).toEqual([
      {
        server: "docs",
        profileId: profile.id,
        snapshotId: snapshots[0]?.id,
        tools: snapshots[0]?.tools,
      },
      {
        server: "remote",
        profileId: profile.id,
        snapshotId: snapshots[1]?.id,
        tools: snapshots[1]?.tools,
      },
    ]);
    await expectNoSecretStored(task.id);

    // The task finished, so its sandbox was released and the stdio
    // server with it: stopped first, so its end is no crash to report.
    const [pid] = await lines(
      join(taskDir(root, task.id), "fixture-starts.log"),
    );
    expect(pid).toBeDefined();
    await until(
      () => {
        try {
          process.kill(Number(pid), 0);
          return false;
        } catch {
          return true;
        }
      },
      { what: "the stdio server to stop with its sandbox" },
    );
    await sleep(300);
    expect(
      mcpEvents(await engine.tasks.events(task.id)).map(
        (event) => event.payload.state,
      ),
    ).toEqual(["starting", "ready", "starting", "ready"]);
  }, 60_000);
});

/** Waits until the task's coordinator has ended its turn and waits for the user. */
const waitingForUser = (engine: Engine, taskId: string, what: string) =>
  untilTask(
    engine,
    taskId,
    (view) =>
      view.task.status === "waiting" && view.sessions[0]?.waitingFor === "user",
    what,
  );

describe("a session's pinned toolset", () => {
  it("declares the same bytes on every run; a profile edit only takes a tool away, refused with its reason, and an added tool reaches new sessions only", async () => {
    const root = await workspace();
    const declarations: string[] = [];
    let refused: ReturnType<typeof resultOf>;
    let startsWhenRefused: string[] = [];
    let taskId = "";
    const { engine, faux } = await start(root);
    const { bot, profile, servers } = await mcpBot(engine, [
      docs({ toolExposure: { slow: "hidden" } }),
    ]);
    faux.setResponses([
      // Run 1: the toolset is pinned; the session waits for the user.
      (context) => {
        declarations.push(mcpDeclarations(context));
        return say("Which tool should I use?");
      },
      // Run 2, after the profile hid leaky and exposed slow.
      (context) => {
        declarations.push(mcpDeclarations(context));
        return call("mcp__docs__leaky", {}, "leaky_1");
      },
      async (context) => {
        declarations.push(mcpDeclarations(context));
        refused = resultOf(context, "leaky_1");
        startsWhenRefused = await lines(
          join(taskDir(root, taskId), "fixture-starts.log"),
        );
        return call("mcp__docs__search", { query: "intro" }, "search_1");
      },
      (context) => {
        declarations.push(mcpDeclarations(context));
        return callTool("complete_task", { result: "Searched." });
      },
      // A new session of the same bot.
      (context) => {
        declarations.push(mcpDeclarations(context));
        return say("Ready.");
      },
    ]);
    const { task } = await engine.tasks.create({
      goal: "Search the docs",
      coordinatorBotId: bot.id,
    });
    taskId = task.id;
    await waitingForUser(engine, task.id, "the first run");
    const [docsServer] = servers as [McpServerInput];
    await engine.profiles.update(profile.id, {
      mcpServers: [
        { ...docsServer, toolExposure: { slow: "direct", leaky: "hidden" } },
      ],
    });
    await engine.tasks.postMessage(task.id, { text: "Use leaky." });
    const done = await untilTask(
      engine,
      task.id,
      (view) => view.task.status === "completed",
      "the second run",
    );

    // Byte for byte the same on every request of the session: leaky
    // stays declared, slow is not added.
    expect(declarations).toHaveLength(4);
    expect(new Set(declarations).size).toBe(1);
    const names = (json: string) =>
      (JSON.parse(json) as { name: string }[]).map((tool) => tool.name);
    expect(names(declarations[0] as string)).toEqual([
      "mcp__docs__explode",
      "mcp__docs__leaky",
      "mcp__docs__search",
    ]);
    // The hidden tool's call was refused with the reason, before its
    // server was started.
    expect(refused?.role === "toolResult" && refused.isError).toBe(true);
    expect(textOf(refused)).toBe(
      "mcp__docs__leaky was hidden in this bot's profile after this session started, so it can no longer be called.",
    );
    expect(startsWhenRefused).toEqual([]);
    const page = await engine.tasks.events(task.id);
    expect(finished(page, "mcp__docs__leaky")[0]?.payload).toMatchObject({
      ok: false,
    });
    expect(finished(page, "mcp__docs__search")[0]?.payload).toMatchObject({
      ok: true,
    });
    expect(done.task.result).toBe("Searched.");

    // A new session declares the profile as it is now.
    const { task: next } = await engine.tasks.create({
      goal: "Again",
      coordinatorBotId: bot.id,
    });
    await waitingForUser(engine, next.id, "the new session");
    expect(names(declarations[4] as string)).toEqual([
      "mcp__docs__explode",
      "mcp__docs__search",
      "mcp__docs__slow",
    ]);
  }, 60_000);

  it("reports drift when the running server lists other tools, and keeps declaring the snapshot's", async () => {
    const root = await workspace();
    let taskId = "";
    let declared = "";
    let answered: ReturnType<typeof resultOf>;
    const { engine, faux } = await start(root);
    const { bot, snapshots } = await mcpBot(engine, [docs()]);
    faux.setResponses([
      async () => {
        // The server sees this file as it starts, after the snapshot was taken.
        await writeFile(join(taskDir(root, taskId), "fixture-drift"), "");
        return call("mcp__docs__search", { query: "intro" }, "search_1");
      },
      (context) => {
        declared = mcpDeclarations(context);
        answered = resultOf(context, "search_1");
        return callTool("complete_task", { result: "Searched." });
      },
    ]);
    const { task } = await engine.tasks.create({
      goal: "Search the docs",
      coordinatorBotId: bot.id,
    });
    taskId = task.id;
    await untilTask(
      engine,
      task.id,
      (view) => view.task.status === "completed",
      "the task",
    );
    const ready = mcpEvents(await engine.tasks.events(task.id)).find(
      (event) => event.payload.state === "ready",
    );
    expect(ready?.payload.drift).toEqual(["extra: new", "search: changed"]);
    // Calls still go to the server, and the model keeps the snapshot's definitions.
    expect(textOf(answered)).toContain('Results for "intro"');
    const search = (
      JSON.parse(declared) as { name: string; description: string }[]
    ).find((tool) => tool.name === "mcp__docs__search");
    expect(search?.description).toBe(
      snapshots[0]?.tools.find((tool) => tool.name === "search")?.description,
    );
  }, 60_000);
});

describe("MCP calls", () => {
  it("applies the profile's exact and server-wide approval rules to MCP tools", async () => {
    const root = await workspace();
    const { engine, faux } = await start(root);
    const { bot } = await mcpBot(engine, [docs()], {
      approvals: [
        { tool: "mcp__docs__*", match: "secret plan" },
        { tool: "mcp__docs__leaky" },
      ],
    });
    faux.setResponses([
      call("mcp__docs__search", { query: "public notes" }, "open_1"),
      call("mcp__docs__search", { query: "the secret plan" }, "plan_1"),
      call("mcp__docs__leaky", {}, "leaky_1"),
      callTool("complete_task", { result: "Done." }),
    ]);
    const { task } = await engine.tasks.create({
      goal: "Search",
      coordinatorBotId: bot.id,
    });
    const pendingOf = (view: TaskView) =>
      view.approvals.find((approval) => approval.status === "pending");
    const first = await untilTask(
      engine,
      task.id,
      (view) => pendingOf(view) !== undefined,
      "the first held call",
    );
    expect(pendingOf(first)).toMatchObject({
      tool: "mcp__docs__search",
      args: { query: "the secret plan" },
      rule: { tool: "mcp__docs__*", match: "secret plan" },
    });
    await engine.tasks.decideApproval(task.id, pendingOf(first)?.id as string, {
      decision: "deny",
      reason: "Not that one.",
    });
    const second = await untilTask(
      engine,
      task.id,
      (view) => pendingOf(view)?.tool === "mcp__docs__leaky",
      "the second held call",
    );
    expect(pendingOf(second)?.rule).toEqual({ tool: "mcp__docs__leaky" });
    await engine.tasks.decideApproval(
      task.id,
      pendingOf(second)?.id as string,
      { decision: "deny" },
    );
    await untilTask(
      engine,
      task.id,
      (view) => view.task.status === "completed",
      "the task",
    );
    const page = await engine.tasks.events(task.id);
    // Only the call no rule matched reached the server.
    expect(
      finished(page, "mcp__docs__search").map(
        (event) => event.payload.toolCallId,
      ),
    ).toEqual(["open_1"]);
    expect(finished(page, "mcp__docs__leaky")).toEqual([]);
  }, 60_000);

  it("reports a crash mid-call as unknown, restarts the server at the next call, and stops at the start budget", async () => {
    const root = await workspace();
    const results: ReturnType<typeof resultOf>[] = [];
    const { engine, faux } = await start(root);
    const { bot } = await mcpBot(engine, [docs()]);
    faux.setResponses([
      call("mcp__docs__explode", {}, "boom_1"),
      (context) => {
        results.push(resultOf(context, "boom_1"));
        return call("mcp__docs__explode", {}, "boom_2");
      },
      (context) => {
        results.push(resultOf(context, "boom_2"));
        return call("mcp__docs__explode", {}, "boom_3");
      },
      (context) => {
        results.push(resultOf(context, "boom_3"));
        return call("mcp__docs__explode", {}, "boom_4");
      },
      (context) => {
        results.push(resultOf(context, "boom_4"));
        return callTool("complete_task", { result: "Gave up." });
      },
    ]);
    const { task } = await engine.tasks.create({
      goal: "Blow it up",
      coordinatorBotId: bot.id,
    });
    await untilTask(
      engine,
      task.id,
      (view) => view.task.status === "completed",
      "the task",
    );
    const page = await engine.tasks.events(task.id);
    const calls = finished(page, "mcp__docs__explode").map(
      (event) => event.payload,
    );
    // Each of the first three was in flight when the server exited.
    for (const index of [0, 1, 2]) {
      expect(calls[index]).toMatchObject({
        ok: false,
        interrupted: "unknown",
      });
      expect(textOf(results[index])).toContain(
        "MCP server docs exited with code 4 while the MCP call explode ran; whether it took effect is unknown.",
      );
      expect(textOf(results[index])).toContain("fatal: lost [redacted]");
    }
    // The fourth was never sent: three starts in ten minutes is the budget.
    expect(calls[3]?.ok).toBe(false);
    expect(calls[3]?.interrupted).toBeUndefined();
    expect(textOf(results[3])).toMatch(
      /^MCP server docs was started 3 times in 10 minutes, so it is not started again before .* and the call did not run\. Its last error: MCP server docs exited with code 4\./,
    );
    expect(
      await lines(join(taskDir(root, task.id), "fixture-starts.log")),
    ).toHaveLength(3);
    const states = await until(
      async () => {
        const events = mcpEvents(await engine.tasks.events(task.id));
        return events.filter((event) => event.payload.state === "exited")
          .length === 3
          ? events
          : undefined;
      },
      { what: "three exits" },
    );
    expect(
      states.filter((event) => event.payload.state === "starting"),
    ).toHaveLength(3);
    for (const exited of states.filter(
      (event) => event.payload.state === "exited",
    ))
      expect(exited.payload).toMatchObject({
        error: "MCP server docs exited with code 4.",
        stderrTail: "fatal: lost [redacted]",
      });
    await expectNoSecretStored(task.id);
  }, 60_000);

  it("cancels a call at the server when the task is stopped, and reports it as unknown", async () => {
    const root = await workspace();
    const { engine, faux } = await start(root);
    const { bot } = await mcpBot(engine, [docs()]);
    faux.setResponses([call("mcp__docs__slow", { ms: 30_000 }, "slow_1")]);
    const { task } = await engine.tasks.create({
      goal: "Wait",
      coordinatorBotId: bot.id,
    });
    const dir = taskDir(root, task.id);
    await until(async () => (await lines(join(dir, "slow-calls.log"))).length, {
      what: "the slow call to reach the server",
    });
    await engine.tasks.stop(task.id);
    await untilTask(
      engine,
      task.id,
      (view) => view.task.status === "cancelled",
      "the stopped task",
    );
    const page = await engine.tasks.events(task.id);
    expect(finished(page, "mcp__docs__slow")[0]?.payload).toMatchObject({
      ok: false,
      interrupted: "unknown",
    });
    await until(
      async () => (await lines(join(dir, "slow-cancelled.log"))).length,
      { what: "notifications/cancelled at the server" },
    );
  }, 60_000);

  it("never runs a call again after a worker crash cut it off: it is repaired as unknown", async () => {
    const root = await workspace();
    const first = await start(root, {
      steps: [call("mcp__docs__slow", { ms: 30_000 }, "slow_1")],
      config: { leaseMs: 1_000 },
    });
    const { bot } = await mcpBot(first.engine, [docs()]);
    const { task } = await first.engine.tasks.create({
      goal: "Wait",
      coordinatorBotId: bot.id,
    });
    const dir = taskDir(root, task.id);
    await until(async () => (await lines(join(dir, "slow-calls.log"))).length, {
      what: "the slow call to reach the server",
    });
    await first.engine.worker.abandon();

    let seen: ReturnType<typeof resultOf>;
    const second = await start(root, {
      steps: [
        (context) => {
          seen = resultOf(context, "slow_1");
          return say("I will check the workspace first.");
        },
      ],
      config: { leaseMs: 1_000 },
    });
    await waitingForUser(second.engine, task.id, "the resumed session");
    expect(textOf(seen)).toBe(INTERRUPTED_BY_RESTART);
    expect(await lines(join(dir, "slow-calls.log"))).toHaveLength(1);
    // The resumed run never started the server again.
    expect(await lines(join(dir, "fixture-starts.log"))).toHaveLength(1);
  }, 60_000);

  it("ends a remote connection after its idle time, and a stdio one when its configuration changes", async () => {
    const root = await workspace();
    const { engine, faux } = await start(root, {
      config: { mcpIdleMs: 300 },
    });
    const { bot, profile, servers } = await mcpBot(engine, [
      docs(),
      remote({ askUnlessReadOnly: false }),
    ]);
    faux.setResponses([
      call("mcp__remote__lookup", { id: "1" }, "lookup_1"),
      call("mcp__docs__search", { query: "one" }, "search_1"),
      say("Waiting."),
      call("mcp__docs__search", { query: "two" }, "search_2"),
      callTool("complete_task", { result: "Searched twice." }),
    ]);
    const { task } = await engine.tasks.create({
      goal: "Search",
      coordinatorBotId: bot.id,
    });
    await waitingForUser(engine, task.id, "the first run");
    // Idle past mcpIdleMs, the remote connection ends.
    await until(
      async () =>
        mcpEvents(await engine.tasks.events(task.id)).some(
          (event) =>
            event.payload.server === "remote" &&
            event.payload.state === "exited",
        ),
      { what: "the idle remote connection to end" },
    );

    // A new configuration of docs, tested and pinned: its tools are the same.
    const [docsServer, remoteServer] = servers as [
      McpServerInput,
      McpServerInput,
    ];
    const changed = {
      ...docsServer,
      env: {
        ...(docsServer as { env?: Record<string, string> }).env,
        FIXTURE_LABEL: "two",
      },
    };
    const snapshot = snapshotOf(
      await discover(engine, profile.id, { ...changed, snapshotId: null }),
    );
    await engine.profiles.update(profile.id, {
      mcpServers: [{ ...changed, snapshotId: snapshot.id }, remoteServer],
    });
    await engine.tasks.postMessage(task.id, { text: "Again." });
    await untilTask(
      engine,
      task.id,
      (view) => view.task.status === "completed",
      "the second run",
    );
    const pids = await lines(
      join(taskDir(root, task.id), "fixture-starts.log"),
    );
    expect(pids).toHaveLength(2);
    // The first process was stopped before the new configuration started.
    expect(() => process.kill(Number(pids[0]), 0)).toThrow();
    const states = mcpEvents(await engine.tasks.events(task.id))
      .filter((event) => event.payload.server === "docs")
      .map((event) => event.payload.state);
    expect(states).toEqual([
      "starting",
      "ready",
      "exited",
      "starting",
      "ready",
    ]);
  }, 60_000);
});

describe("bootstrap capabilities", () => {
  it("reports MCP per kind only where sessions can use it", async () => {
    const root = await workspace();
    const capabilities = async (options: Parameters<typeof testEngine>[1]) => {
      const engine = await testEngine(db.database, {
        workspaceRoot: root,
        start: false,
        ...options,
      });
      engines.push(engine);
      return bootstrapSchema.parse(await engine.engine.bootstrap()).capabilities
        .mcp;
    };
    expect(await capabilities({ mcp: new McpDiscoverer({ env: {} }) })).toEqual(
      { stdio: true, remote: true },
    );
    expect(
      await capabilities({
        mcp: new McpDiscoverer({ env: { JJ_MCP_REMOTE: "off" } }),
      }),
    ).toEqual({ stdio: true, remote: false });
    // No driver here can spawn a process.
    expect(
      await capabilities({
        mcp: new McpDiscoverer({ env: {} }),
        registry: createDriverRegistry([
          {
            driver: recordingDriver(
              new LocalSandboxDriver({ root, killGraceMs: 200 }),
              { spawn: false },
            ).driver,
            label: "Local",
          },
        ]),
      }),
    ).toEqual({ stdio: false, remote: true });
    // No MCP client at all.
    expect(await capabilities({})).toEqual({ stdio: false, remote: false });
  });
});

describe("discovery and worker refinements", () => {
  it("refuses a disabled server pinning a snapshot of another profile, or none at all", async () => {
    const root = await workspace();
    const { engine } = await start(root);
    const { servers, snapshots } = await mcpBot(engine, [docs()]);
    const [docsServer] = servers as [McpServerInput];
    const { profile: other } = await engine.profiles.create({
      name: uniqueName("Other"),
      sandbox: { driver: "local", network: { mode: "open" } },
      secrets: ["DOCS_SECRET"],
    });
    for (const snapshotId of [snapshots[0]?.id as string, "snap_missing"]) {
      const error = await engine.profiles
        .update(other.id, {
          mcpServers: [{ ...docsServer, enabled: false, snapshotId }],
        })
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );
      expect(error).toBeInstanceOf(DomainError);
      expect(error).toMatchObject({ code: "MCP_SNAPSHOT_MISMATCH" });
      expect((error as Error).message).toContain(
        `${snapshotId} is not a snapshot of docs in this profile`,
      );
    }
  });

  it("answers a second test of the same configuration with the running one, and refuses another configuration while it runs", async () => {
    const root = await workspace();
    const { engine } = await start(root);
    await engine.secrets.put("DOCS_SECRET", { value: TOKEN });
    const { profile } = await engine.profiles.create({
      name: uniqueName("Testing"),
      sandbox: { driver: "local", network: { mode: "open" } },
      secrets: ["DOCS_SECRET"],
    });
    const silent = mcpFixture({ mode: "silent", startupTimeoutSec: 30 });
    const { discovery } = await engine.mcp.startDiscovery(profile.id, {
      server: silent,
    });
    expect(discovery.configHash).toBe(
      mcpConfigHash(mcpServerSchema.parse(silent), profile.sandbox),
    );
    // The same configuration, described differently: the same test.
    const again = await engine.mcp.startDiscovery(profile.id, {
      server: { ...silent, description: "Edited" },
    });
    expect(again.discovery.id).toBe(discovery.id);
    // Another configuration while it runs: refused, naming it.
    const error = await engine.mcp
      .startDiscovery(profile.id, {
        server: { ...silent, env: { ...silent.env, OTHER: "1" } },
      })
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(error).toMatchObject({
      code: "CONFLICT",
      details: { discoveryId: discovery.id, configHash: discovery.configHash },
    });
    expect((error as Error).message).toContain(
      "A test of docs with another configuration or sandbox is",
    );
    const rows = await db.database.db
      .select()
      .from(mcpDiscoveries)
      .where(eq(mcpDiscoveries.profileId, profile.id));
    expect(rows).toHaveLength(1);
  });

  it("lists every job kind in the worker's claim classes", () => {
    expect(Object.keys(CLAIM_CLASSES).sort()).toEqual([...JOB_KINDS].sort());
    expect(CLAIM_CLASSES["mcp.discover"]).toBe("discovery");
  });
});
