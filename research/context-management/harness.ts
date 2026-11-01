// Research harness for issue #68 (not product code). Boots the real engine
// in-process on a temporary PGlite directory with the local sandbox driver,
// wraps the model registry's stream function to record exactly what every
// model call receives, runs one scenario, and writes a JSON report.
//
//   node --import tsx research/context-management/harness.ts [scenario] [model]
//
// The model defaults to the scripted test model. A real model needs its key in
// the environment; the report includes the provider-reported usage and cost.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadServerConfig } from "@jj/api/config";
import { openServices } from "@jj/api/wiring";
import { sessionEntries, sessions, usage } from "@jj/db";
import { scenarios } from "./scenarios";

export interface CallRecord {
  index: number;
  sessionId: string | null;
  at: number;
  systemChars: number;
  toolsChars: number;
  messages: number;
  byRole: Record<string, number>;
  /** Characters of user messages that are inbox deliveries (briefs, results, messages, steering). */
  totalChars: number;
}

const chars = (value: unknown) =>
  typeof value === "string" ? value.length : JSON.stringify(value ?? "").length;

async function main() {
  const scenarioName = process.argv[2] ?? "baseline";
  const model = process.argv[3] ?? "scripted/team";
  const scenario = scenarios[scenarioName];
  if (!scenario) throw new Error(`Unknown scenario ${scenarioName}`);
  const dir = await mkdtemp(join(tmpdir(), "jj-ctx-"));
  const env: Record<string, string | undefined> = {
    ...process.env,
    JJ_DATABASE_PATH: join(dir, "db"),
    JJ_SANDBOX_DRIVERS: "local",
    JJ_SANDBOX_ROOT: join(dir, "sandboxes"),
    JJ_ENABLE_SCRIPTED_MODEL: "true",
    JJ_DEFAULT_MODEL: model,
    API_PORT: "0",
  };
  const config = loadServerConfig(env);
  const quiet = { info() {}, warn() {}, error: console.error, debug() {} };
  const services = await openServices(config, env, quiet as never);
  const calls: CallRecord[] = [];
  const original = services.models.streamFn;
  Object.defineProperty(services.models, "streamFn", {
    value: (m: unknown, context: any, options: any) => {
      const byRole: Record<string, number> = {};
      let toolDecl = 0;
      let systemChars = chars(context.systemPrompt);
      for (const message of context.messages ?? []) {
        const size = chars(message.content);
        if (message.role === "system") {
          systemChars += size;
          toolDecl += chars(message.toolsAdded ?? message.tools ?? []);
        } else byRole[message.role] = (byRole[message.role] ?? 0) + size;
      }
      const toolsChars = toolDecl + (context.tools ? chars(context.tools) : 0);
      calls.push({
        index: calls.length,
        sessionId: options?.sessionId ?? null,
        at: Date.now(),
        systemChars,
        toolsChars,
        messages: (context.messages ?? []).length,
        byRole,
        totalChars:
          systemChars +
          toolsChars +
          Object.values(byRole).reduce((a, b) => a + b, 0),
      });
      return (original as any)(m, context, options);
    },
  });
  const { engine, database } = services;
  await engine.worker.start();
  const started = Date.now();
  let outcome: unknown;
  try {
    outcome = await scenario.run({ engine, model, root: join(dir, "sandboxes") });
  } finally {
    await engine.worker.stop?.();
  }
  const wallMs = Date.now() - started;
  const db = database.db;
  const sessionRows = await db.select().from(sessions);
  const usageRows = await db.select().from(usage);
  const entryRows = await db.select().from(sessionEntries);
  const bots = (await engine.bots.list()).bots;
  const botName = new Map(bots.map((b) => [b.id, b.name]));
  const perSession = sessionRows.map((s) => {
    const mine = usageRows.filter((u) => u.sessionId === s.id);
    const myCalls = calls.filter((c) => c.sessionId === s.id);
    return {
      id: s.id,
      bot: botName.get(s.botId),
      role: s.parentSessionId ? "worker" : "coordinator",
      status: s.status,
      runs: s.runCount,
      entries: entryRows.filter((e) => e.sessionId === s.id).length,
      modelCalls: myCalls.length,
      estInputTokens: Math.round(
        myCalls.reduce((a, c) => a + c.totalChars, 0) / 4,
      ),
      maxContextTokens: Math.round(
        Math.max(0, ...myCalls.map((c) => c.totalChars)) / 4,
      ),
      usage: {
        input: mine.reduce((a, u) => a + u.inputTokens, 0),
        output: mine.reduce((a, u) => a + u.outputTokens, 0),
        cacheRead: mine.reduce((a, u) => a + u.cacheReadTokens, 0),
        costUsd: mine.reduce((a, u) => a + u.costUsd, 0),
      },
    };
  });
  const chatUsage = usageRows.filter((u) => u.sessionId === null);
  // Tool calls per bot and tool, from the durable task events.
  const toolCalls: Record<string, number> = {};
  for (const { id } of (await engine.tasks.list()).tasks) {
    let after = 0;
    for (;;) {
      const page = await engine.tasks.events(id, { after, limit: 500 });
      for (const event of page.events)
        if (event.type === "tool.started") {
          const key = `${botName.get(event.botId ?? "") ?? "?"}:${(event.payload as { tool: string }).tool}`;
          toolCalls[key] = (toolCalls[key] ?? 0) + 1;
        }
      if (page.events.length < 500) break;
      after = page.events.at(-1)?.sequence ?? after;
    }
  }
  const report = {
    scenario: scenarioName,
    model,
    wallMs,
    outcome,
    totals: {
      modelCalls: calls.length,
      estInputTokens: Math.round(
        calls.reduce((a, c) => a + c.totalChars, 0) / 4,
      ),
      usage: {
        input: usageRows.reduce((a, u) => a + u.inputTokens, 0),
        output: usageRows.reduce((a, u) => a + u.outputTokens, 0),
        cacheRead: usageRows.reduce((a, u) => a + u.cacheReadTokens, 0),
        costUsd: usageRows.reduce((a, u) => a + u.costUsd, 0),
      },
      chatCalls: chatUsage.length,
    },
    toolCalls,
    flags: Object.fromEntries(
      Object.entries(process.env).filter(([k]) => k.startsWith("JJ_EXP_")),
    ),
    sessions: perSession,
    calls,
  };
  const out = join(import.meta.dirname, "results");
  await mkdir(out, { recursive: true });
  const file = join(
    out,
    `${scenarioName}${process.env.JJ_EXP_LABEL ? `.${process.env.JJ_EXP_LABEL}` : ""}-${model.replace(/[^a-z0-9]+/gi, "_")}-${Date.now()}.json`,
  );
  await writeFile(file, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ ...report, calls: undefined, file }, null, 2));
  await database.close();
  await rm(dir, { recursive: true, force: true });
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
