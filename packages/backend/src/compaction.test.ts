import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runs, sessionEntries, usage } from "@jj/db";
import {
  createScriptedProvider,
  ModelRegistry,
  type PiMessage,
  PiSessionExecutor,
  parseTranscript,
  repairTranscript,
  viewTranscript,
} from "@jj/runtime";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { promptBot } from "./testing/fake-executor";
import {
  OPEN_TIMEOUT,
  openTestDatabase,
  type TestDatabase,
  type TestEngine,
  testEngine,
  untilTask,
} from "./testing/harness";
import { createTeam, delegatingCoordinator } from "./testing/scenarios";
import { BRIEF_HEADING, briefPointer } from "./worker/prompts";

let db: TestDatabase;
let current: TestEngine | undefined;
const engines: TestEngine[] = [];
let root: string | undefined;

beforeAll(async () => {
  db = await openTestDatabase();
}, OPEN_TIMEOUT);
afterEach(async () => {
  await current?.dispose();
  current = undefined;
  for (const engine of engines.splice(0).reverse()) await engine.dispose();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});
afterAll(async () => {
  await db?.close();
});

/** The scripted model with a 24k-token window, so a long session must compact. */
function smallWindowExecutor() {
  return new PiSessionExecutor({
    models: new ModelRegistry({
      env: {},
      extraProviders: [createScriptedProvider({ contextWindow: 24_000 })],
    }),
  });
}

const tally = (count: number, from = 0) =>
  Array.from(
    { length: count },
    (_, i) => `seq ${(from + i) * 800 + 1} ${(from + i + 1) * 800}`,
  );
const commands = tally(20);
const goalFor = (list: string[]) =>
  `Tally the numbers into notes-tally.md: ${list.map((command) => `run \`${command}\``).join(", ")}.`;

async function storedTranscript(sessionId: string) {
  const rows = await db.database.db
    .select({ entry: sessionEntries.entry })
    .from(sessionEntries)
    .where(eq(sessionEntries.sessionId, sessionId))
    .orderBy(asc(sessionEntries.seq));
  return parseTranscript(rows.map((row) => row.entry));
}

/** Tool call ids and result ids of a context, in order. */
function callsAndResults(messages: readonly PiMessage[]) {
  const calls: string[] = [];
  const results: string[] = [];
  for (const message of messages) {
    if (message.role === "toolResult") results.push(message.toolCallId);
    if (message.role !== "assistant") continue;
    for (const block of message.content)
      if (block.type === "toolCall") calls.push(block.id);
  }
  return { calls, results };
}

describe("context compaction in the engine", () => {
  it("keeps a worker's brief in its prompt, where compaction cannot reach it", async () => {
    current = await testEngine(db.database);
    const { engine, executor } = current;
    const team = await createTeam(engine, ["Ada", "Bob"]);
    const [ada, bob] = team.names as [string, string];
    const brief =
      "Write bob.txt with three penguin facts.\n\n## Notes\nCite one source.";
    executor
      .brain(
        ada,
        delegatingCoordinator([bob], () => brief),
      )
      .brain(bob, () => ({ text: "Wrote bob.txt." }));
    const { task } = await engine.tasks.create({
      goal: "Penguin facts",
      coordinatorBotId: team.byName[ada] as string,
      participantBotIds: team.ids,
    });
    const view = await untilTask(engine, task.id, (next) =>
      ["completed", "failed"].includes(next.task.status),
    );
    expect(view.task.status).toBe("completed");
    const runs = executor.inputs.filter(
      (input) => promptBot(input.systemPrompt) === bob,
    );
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs)
      expect(
        run.systemPrompt.endsWith(`${BRIEF_HEADING} (from ${ada})\n${brief}`),
      ).toBe(true);
    // The session starts on a pointer, so the brief is not sent twice ...
    expect(runs[0]?.inputs).toEqual([briefPointer(ada)]);
    // ... while the task chat still shows the assignment as written.
    expect(
      view.messages.find((message) => message.intent === "assignment")?.text,
    ).toBe(brief);
    const coordinatorRuns = executor.inputs.filter(
      (input) => promptBot(input.systemPrompt) === ada,
    );
    expect(coordinatorRuns[0]?.systemPrompt).not.toContain(BRIEF_HEADING);
  });

  it("compacts a long session, accounts for the summary calls and resumes from the checkpoint", async () => {
    current = await testEngine(db.database, {
      runExecutor: smallWindowExecutor(),
    });
    const { engine } = current;
    const team = await createTeam(engine, ["Ada"]);
    const [ada] = team.names as [string];
    const { task } = await engine.tasks.create({
      goal: goalFor(commands),
      coordinatorBotId: team.byName[ada] as string,
    });
    const view = await untilTask(engine, task.id, (next) =>
      ["completed", "failed"].includes(next.task.status),
    );
    expect(view.task.status).toBe("completed");
    const session = view.sessions[0];
    expect(session).toBeDefined();
    const sessionId = session?.id as string;

    // The checkpoint is a transcript entry like any other; the full history stays stored.
    const rows = await db.database.db
      .select({ entry: sessionEntries.entry, runId: sessionEntries.runId })
      .from(sessionEntries)
      .where(eq(sessionEntries.sessionId, sessionId))
      .orderBy(asc(sessionEntries.seq));
    const checkpoints = rows.filter((row) => row.entry.role === "compaction");
    expect(checkpoints.length).toBeGreaterThanOrEqual(1);
    expect(checkpoints[0]?.entry).toMatchObject({
      keptEntries: expect.any(Number),
      tokensBefore: expect.any(Number),
      summary: expect.stringContaining("Tally the numbers"),
    });
    expect(rows.filter((row) => row.entry.role === "assistant").length).toBe(
      commands.length + 3, // the notes, the commands, ls and complete_task
    );

    // Every model call has a usage row, the summary calls included, and the view counts them.
    const page = await engine.tasks.events(task.id);
    const finished = page.events.filter(
      (event) => event.type === "model.finished",
    );
    const summaries = finished.filter(
      (event) =>
        event.type === "model.finished" &&
        event.payload.text?.startsWith("Context compaction"),
    );
    expect(summaries.length).toBeGreaterThanOrEqual(checkpoints.length);
    const usageRows = await db.database.db
      .select()
      .from(usage)
      .where(eq(usage.taskId, task.id));
    expect(usageRows).toHaveLength(finished.length);
    const summary = summaries[0];
    expect(
      usageRows.filter(
        (row) =>
          summary?.type === "model.finished" &&
          row.runId === summary.runId &&
          row.sessionId === sessionId &&
          row.botId === team.byName[ada] &&
          row.model === "scripted/team" &&
          row.inputTokens === summary.payload.usage.inputTokens &&
          row.outputTokens === summary.payload.usage.outputTokens,
      ),
    ).toHaveLength(1);
    expect(view.usage.total.modelCalls).toBe(finished.length);
    expect(
      finished.every(
        (event) =>
          event.type === "model.finished" &&
          event.payload.stopReason !== "error",
      ),
    ).toBe(true);

    // Each command ran once.
    const bash = () =>
      page.events.flatMap((event) =>
        event.type === "tool.started" && event.payload.tool === "bash"
          ? [event.payload.summary]
          : [],
      );
    expect(bash()).toEqual([...commands, "ls -la"]);

    // A follow-up continues from the compacted state without redoing the work.
    await engine.tasks.postMessage(task.id, { text: "Thanks, that is all." });
    const again = await untilTask(
      engine,
      task.id,
      (next) =>
        next.task.status === "completed" && next.cursor > view.cursor + 5,
    );
    expect(again.task.result).toMatch(/^Done: I wrote notes-tally\.md/);
    const later = await engine.tasks.events(task.id, { after: view.cursor });
    expect(
      later.events
        .filter((event) => event.type === "tool.started")
        .map((event) => event.type === "tool.started" && event.payload.tool),
    ).toEqual(["complete_task"]);
    const resumed = await db.database.db
      .select({ entry: sessionEntries.entry })
      .from(sessionEntries)
      .where(
        and(
          eq(sessionEntries.sessionId, sessionId),
          eq(
            sessionEntries.runId,
            later.events.find((e) => e.runId)?.runId ?? "",
          ),
        ),
      );
    expect(resumed.map((row) => row.entry.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
    ]);
  });

  it("recovers a crash after a compaction without re-running or losing a tool call", async () => {
    root = await mkdtemp(join(tmpdir(), "jj-compaction-"));
    const worker = async () => {
      const engine = await testEngine(db.database, {
        runExecutor: smallWindowExecutor(),
        workspaceRoot: root,
        config: { leaseMs: 1_000 },
      });
      engines.push(engine);
      return engine.engine;
    };
    // A long command after the session has compacted, where the crash lands.
    const list = [...tally(14), "sleep 30", ...tally(3, 14)];
    const first = await worker();
    const team = await createTeam(first, ["Ada"]);
    const [ada] = team.names as [string];
    const { task } = await first.tasks.create({
      goal: goalFor(list),
      coordinatorBotId: team.byName[ada] as string,
    });
    const running = await untilTask(
      first,
      task.id,
      (view) =>
        view.events.some(
          (e) => e.type === "tool.started" && e.payload.summary === "sleep 30",
        ),
      "the long command",
    );
    const sessionId = running.sessions[0]?.id as string;
    expect(
      (await storedTranscript(sessionId)).some(
        (entry) => entry.role === "compaction",
      ),
    ).toBe(true);
    await engines[0]?.engine.worker.abandon();

    const second = await worker();
    const view = await untilTask(
      second,
      task.id,
      (next) => ["completed", "failed"].includes(next.task.status),
      "the resumed task",
      20_000,
    );
    expect(view.task.status).toBe("completed");
    const runRows = await db.database.db
      .select()
      .from(runs)
      .where(eq(runs.taskId, task.id))
      .orderBy(asc(runs.number));
    expect(runRows.map((run) => [run.reason, run.status])).toEqual([
      ["start", "failed"],
      ["recovery", "completed"],
    ]);
    // Every command started once; the cut one is reported interrupted, never re-run.
    const page = await second.tasks.events(task.id);
    expect(
      page.events.flatMap((event) =>
        event.type === "tool.started" && event.payload.tool === "bash"
          ? [event.payload.summary]
          : [],
      ),
    ).toEqual([...list, "ls -la"]);
    expect(
      page.events.find(
        (e) => e.type === "tool.finished" && e.payload.summary === "sleep 30",
      )?.payload,
    ).toMatchObject({ ok: false, interrupted: "unknown" });
    // The stored transcript loads as a valid compacted context: each call
    // answered exactly once, the interrupted one included.
    const context = repairTranscript(
      viewTranscript(await storedTranscript(sessionId)).messages,
    );
    const { calls, results } = callsAndResults(context);
    expect(new Set(calls).size).toBe(calls.length);
    expect(results).toEqual(calls);
  });
});
