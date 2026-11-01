import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskView } from "@jj/contracts";
import { sessionEntries } from "@jj/db";
import { ModelRegistry, PiSessionExecutor } from "@jj/runtime";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@jj/runtime/testing";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createRedactor, REDACTED, tooShortToRedact } from "./redact";
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

beforeAll(async () => {
  db = await openTestDatabase();
}, OPEN_TIMEOUT);
afterEach(async () => {
  await current?.dispose();
  current = undefined;
});
afterAll(async () => {
  await db?.close();
});

const KEY = "sk-test-ghjkmnpqrstvwxyzGHJKMNPQ";
const MIDDLE = KEY.slice(8, 24);
const TOKEN = "instance-token-0123456789";

/** Everything a task persisted that a reader can see: events with full previews, transcripts, the view, spilled output. */
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
  return {
    events: JSON.stringify(page.events),
    transcript: JSON.stringify(entries),
    view: JSON.stringify(view),
    spills,
  };
}

describe("redactor", () => {
  it("replaces long secrets anywhere in a value, longest first", () => {
    const redact = createRedactor([
      { name: "A", value: KEY },
      { name: "B", value: KEY.slice(0, 20) },
    ]);
    expect(
      redact({ a: [`x ${KEY} y`, 3, null], b: { c: `${KEY.slice(0, 20)}!` } }),
    ).toEqual({ a: [`x ${REDACTED} y`, 3, null], b: { c: `${REDACTED}!` } });
  });

  it("redacts a database password only as a URL password, never as a word", () => {
    const redact = createRedactor([
      { name: "the DATABASE_URL password", value: "postgres", inUrl: true },
    ]);
    expect(redact("Use postgres 17; the postgres user owns it.")).toBe(
      "Use postgres 17; the postgres user owns it.",
    );
    expect(redact("DATABASE_URL=postgresql://u:postgres@h:5432/postgres")).toBe(
      `DATABASE_URL=postgresql://u:${REDACTED}@h:5432/postgres`,
    );
  });

  it("leaves a short bare secret alone and names it for a warning", () => {
    const short = { name: "SHORT_KEY", value: "0123456789" };
    expect(createRedactor([short])("key 0123456789")).toBe("key 0123456789");
    expect(
      tooShortToRedact([
        short,
        { name: "LONG_KEY", value: KEY },
        { name: "the DATABASE_URL password", value: "pw", inUrl: true },
      ]),
    ).toEqual(["SHORT_KEY"]);
  });
});

describe("redaction", () => {
  it("warns at boot about a secret too short to redact, without printing it", async () => {
    quietLogger.warnings.length = 0;
    current = await testEngine(db.database, {
      secrets: [{ name: "SHORT_KEY", value: "0123456789" }],
      start: false,
    });
    const warning = quietLogger.warnings.find((line) =>
      line.startsWith("SHORT_KEY is shorter than 16 characters"),
    );
    expect(warning).toContain("is not redacted from task history");
    expect(quietLogger.warnings.join("\n")).not.toContain("0123456789");
  });

  it("keeps the server's secrets out of events, transcripts, messages and spilled output", async () => {
    current = await testEngine(db.database, {
      secrets: [
        { name: "OPENAI_API_KEY", value: KEY },
        { name: "the generated API token", value: TOKEN },
        { name: "the DATABASE_URL password", value: "postgres", inUrl: true },
      ],
      config: { outputCapBytes: 1024 },
    });
    const { engine, executor } = current;
    const team = await createTeam(engine, ["Ada"]);
    const [ada] = team.names as [string];
    executor.brain(ada, (view) => {
      switch (said.turns(view)) {
        case 0:
          return {
            calls: [
              {
                name: "write",
                args: {
                  path: ".env",
                  content: `OPENAI_API_KEY=${KEY}\nAPI_TOKEN=${TOKEN}\nDATABASE_URL=postgresql://jj:postgres@db/jj\n`,
                },
              },
            ],
          };
        case 1:
          return { calls: [{ name: "bash", args: { command: "cat .env" } }] };
        case 2:
          // Over the output cap, so the engine spills it as an artifact.
          return {
            calls: [
              {
                name: "bash",
                args: { command: "for i in $(seq 40); do cat .env; done" },
              },
            ],
          };
        default:
          return lastResult(view)?.name === "complete_task"
            ? { text: `Done; the key was ${KEY}.` }
            : {
                text: `I found ${KEY}`,
                calls: [
                  {
                    name: "complete_task",
                    args: {
                      result: `The key is ${KEY}, the token ${TOKEN}; the database is postgres.`,
                    },
                  },
                ],
              };
      }
    });
    const { task } = await engine.tasks.create({
      goal: "Read the env file",
      coordinatorBotId: team.byName[ada] as string,
    });
    const view = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed",
    );
    const stored = await persisted(engine, view);
    expect(stored.spills).toHaveLength(1);
    for (const text of [
      stored.events,
      stored.transcript,
      stored.view,
      ...stored.spills,
    ]) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain("jj:postgres@");
      expect(text).toContain(REDACTED);
    }
    // The password is redacted in its URL, and the word itself is left alone.
    expect(view.task.result).toBe(
      `The key is ${REDACTED}, the token ${REDACTED}; the database is postgres.`,
    );
    const page = await engine.tasks.events(task.id);
    const cat = page.events.find(
      (e) => e.type === "tool.finished" && e.payload.summary === "cat .env",
    );
    expect(cat?.type === "tool.finished" && cat.payload.output).toBe(
      `OPENAI_API_KEY=${REDACTED}\nAPI_TOKEN=${REDACTED}\nDATABASE_URL=postgresql://jj:${REDACTED}@db/jj\n`,
    );
    // Files in the workspace are the user's and stay as written.
    expect(
      await readFile(
        join(current.workspaceRoot, "task", task.id, ".env"),
        "utf8",
      ),
    ).toContain(KEY);
  });

  it("redacts an error that fails the run", async () => {
    current = await testEngine(db.database, {
      secrets: [{ name: "OPENAI_API_KEY", value: KEY }],
    });
    const { engine, executor } = current;
    const team = await createTeam(engine, ["Ada"]);
    const [ada] = team.names as [string];
    executor.brain(ada, () => {
      throw new Error(`The provider rejected ${KEY}`);
    });
    const { task } = await engine.tasks.create({
      goal: "Fail",
      coordinatorBotId: team.byName[ada] as string,
    });
    const view = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "failed",
    );
    expect(view.sessions[0]?.error).toBe(`The provider rejected ${REDACTED}`);
    const stored = await persisted(engine, view);
    expect(stored.events).not.toContain(KEY);
    expect(stored.view).not.toContain(KEY);
  });

  it("leaves no fragment of a key that the runtime's caps and clips cut", async () => {
    const faux = fauxProvider();
    const registry = new ModelRegistry({
      env: {},
      extraProviders: [faux.provider],
    });
    current = await testEngine(db.database, {
      runExecutor: new PiSessionExecutor({
        models: registry,
        outputCapBytes: 1024,
      }),
      secrets: [{ name: "OPENAI_API_KEY", value: KEY }],
      config: { outputCapBytes: 1024 },
    });
    const { engine } = current;
    const team = await createTeam(engine, ["Ada"]);
    const [ada] = team.names as [string];
    // Keys around both cuts, and filler so the output stays over the cap
    // once the keys are redacted (so it is still capped and spilled).
    const keys = KEY.repeat(80);
    const output = `${keys}${"z".repeat(3000)}${keys}`;
    const call = (name: string, args: Record<string, string>) =>
      fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
    faux.setResponses([
      // Two outputs a half key apart at each end: whatever the cuts' offsets,
      // one of them has a key straddling each cut.
      call("write", { path: "a.txt", content: output }),
      call("write", {
        path: "b.txt",
        content: `${"x".repeat(16)}${output}${"x".repeat(16)}`,
      }),
      call("bash", { command: "cat a.txt" }),
      call("bash", { command: "cat b.txt" }),
      // A summary clipped at 300 characters, inside the key.
      call("bash", { command: `echo ${"x".repeat(265)}${KEY} > /dev/null` }),
      // Model text clipped at 2000 characters, inside the key.
      fauxAssistantMessage(
        [
          fauxText(`${"y".repeat(1970)}${KEY} and more`),
          fauxToolCall("complete_task", { result: `Done with ${KEY}.` }),
        ],
        { stopReason: "toolUse" },
      ),
    ]);
    const { task } = await engine.tasks.create({
      goal: "Cut keys",
      coordinatorBotId: team.byName[ada] as string,
    });
    const view = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed" || v.task.status === "failed",
    );
    expect(view.task.status).toBe("completed");
    const stored = await persisted(engine, view);
    expect(stored.spills).toHaveLength(2);
    const page = await engine.tasks.events(task.id);
    expect(
      page.events.some(
        (e) =>
          e.type === "tool.started" &&
          e.payload.summary.startsWith(`echo ${"x".repeat(265)}${REDACTED}`),
      ),
    ).toBe(true);
    expect(
      page.events.some(
        (e) =>
          e.type === "model.finished" &&
          e.payload.text?.startsWith(`${"y".repeat(1970)}${REDACTED}`),
      ),
    ).toBe(true);
    for (const text of [
      stored.events,
      stored.transcript,
      stored.view,
      ...stored.spills,
    ]) {
      // Not one character run of the key's middle 16 survives.
      for (let start = 0; start + 4 <= MIDDLE.length; start += 1)
        expect(text).not.toContain(MIDDLE.slice(start, start + 4));
    }
  });
});
