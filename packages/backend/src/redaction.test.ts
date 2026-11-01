import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { sessionEntries } from "@jj/db";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createRedactor, REDACTED } from "./redact";
import { said } from "./testing/fake-executor";
import {
  OPEN_TIMEOUT,
  openTestDatabase,
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

const KEY = "sk-test-FAKE0123456789abcdef";
const TOKEN = "instance-token-0123456789";

describe("redaction", () => {
  it("replaces secrets anywhere in a value, longest first, and ignores short ones", () => {
    const redact = createRedactor(() => [KEY, "sk-test", "ab", undefined]);
    expect(
      redact({ a: [`x ${KEY} y`, 3, null], b: { c: "sk-test-other" } }),
    ).toEqual({
      a: [`x ${REDACTED} y`, 3, null],
      b: { c: `${REDACTED}-other` },
    });
    expect(redact("ab cd")).toBe("ab cd");
  });

  it("keeps the server's secrets out of events, transcripts, messages and spilled output", async () => {
    current = await testEngine(db.database, {
      secrets: [KEY, TOKEN],
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
                  content: `OPENAI_API_KEY=${KEY}\nAPI_TOKEN=${TOKEN}\n`,
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
                    args: { result: `The key is ${KEY}, the token ${TOKEN}.` },
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
    const page = await engine.tasks.events(task.id);
    const entries = await db.database.db
      .select({ entry: sessionEntries.entry })
      .from(sessionEntries)
      .where(eq(sessionEntries.sessionId, view.sessions[0]?.id as string));
    const spilled = view.artifacts.filter((a) => a.kind === "output");
    expect(spilled).toHaveLength(1);
    const spilledText = Buffer.from(
      (await engine.tasks.artifactContent(task.id, spilled[0]?.id as string))
        .content,
    ).toString();
    for (const persisted of [
      JSON.stringify(page.events),
      JSON.stringify(entries),
      JSON.stringify(view),
      spilledText,
    ]) {
      expect(persisted).not.toContain(KEY);
      expect(persisted).not.toContain(TOKEN);
      expect(persisted).toContain(REDACTED);
    }
    expect(view.task.result).toBe(
      `The key is ${REDACTED}, the token ${REDACTED}.`,
    );
    const cat = page.events.find(
      (e) => e.type === "tool.finished" && e.payload.summary === "cat .env",
    );
    expect(cat?.type === "tool.finished" && cat.payload.output).toBe(
      `OPENAI_API_KEY=${REDACTED}\nAPI_TOKEN=${REDACTED}\n`,
    );
    // Files in the workspace are the user's and stay as written.
    expect(
      await readFile(
        join(current.workspaceRoot, "task", task.id, ".env"),
        "utf8",
      ),
    ).toContain(KEY);
  });
});
