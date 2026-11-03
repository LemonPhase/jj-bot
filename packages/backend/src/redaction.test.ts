import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { TaskView } from "@jj/contracts";
import { sessionEntries, verificationChecks } from "@jj/db";
import { ModelRegistry, PiSessionExecutor } from "@jj/runtime";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@jj/runtime/testing";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createRedactor,
  MIN_CUT_FRAGMENT_LENGTH,
  REDACTED,
  tooShortToRedact,
} from "./redact";
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

  it("masks what a cut left of a secret at the edge it names, from the documented minimum on", () => {
    const redact = createRedactor([{ name: "OPENAI_API_KEY", value: KEY }]);
    for (let length = 1; length < KEY.length; length += 1) {
      const head = KEY.slice(0, length);
      const tail = KEY.slice(-length);
      const masked = length >= MIN_CUT_FRAGMENT_LENGTH;
      // The output a limit stopped keeping ends inside the key.
      expect(redact(`key=${head}`, { end: true })).toBe(
        masked ? `key=${REDACTED}` : `key=${head}`,
      );
      // A rolling tail starts inside it.
      expect(redact(`${tail}\nnext`, { start: true })).toBe(
        masked ? `${REDACTED}\nnext` : `${tail}\nnext`,
      );
      // Only at a cut edge: the same text elsewhere is ordinary text.
      expect(redact(`key=${head}`)).toBe(`key=${head}`);
      expect(redact(`${tail}\nnext`, { end: true })).toBe(`${tail}\nnext`);
    }
    // Whole keys are replaced as always, both edges at once.
    expect(
      redact(`${KEY.slice(-9)} ${KEY} ${KEY.slice(0, 9)}`, {
        start: true,
        end: true,
      }),
    ).toBe(`${REDACTED} ${REDACTED} ${REDACTED}`);
    // A cut through a multi-byte character decodes to a replacement character.
    expect(redact(`${KEY.slice(0, 9)}\uFFFD`, { end: true })).toBe(REDACTED);
    expect(redact(`\uFFFD${KEY.slice(-9)}!`, { start: true })).toBe(
      `${REDACTED}!`,
    );
  });

  it("masks a cut database password next to the colon or @ that frames it", () => {
    const redact = createRedactor([
      { name: "the DATABASE_URL password", value: "postgres", inUrl: true },
    ]);
    expect(redact("DATABASE_URL=postgresql://u:pos", { end: true })).toBe(
      `DATABASE_URL=postgresql://u:${REDACTED}`,
    );
    expect(redact("gres@h:5432/postgres", { start: true })).toBe(
      `${REDACTED}@h:5432/postgres`,
    );
    // Not as a word, nor away from a cut.
    expect(redact("Use pos", { end: true })).toBe("Use pos");
    expect(redact("u:pos")).toBe("u:pos");
  });

  it("masks the piece a cut left of a secret that holds another secret", () => {
    // A credentials file holding a key, both stored: the cut goes through
    // the file after the key.
    const key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const token = "FwoGZXIvYXdzEJr//////////wEaDOpK3hBZ5a9TokenToken";
    const file = `[default] aws_secret_access_key=${key} aws_session_token=${token}`;
    const redact = createRedactor([
      { name: "AWS_SECRET_ACCESS_KEY", value: key },
      { name: "AWS_CREDENTIALS", value: file },
    ]);
    const cut = file.indexOf(token) + 30;
    expect(redact(`cat:\n${file.slice(0, cut)}`, { end: true })).toBe(
      `cat:\n${REDACTED}`,
    );
    // A rolling tail that starts in the file before the key.
    const from = file.indexOf(key) - 5;
    expect(redact(`${file.slice(from)}\nok`, { start: true })).toBe(
      `${REDACTED}\nok`,
    );
  });

  it("masks the piece a cut left of a secret that starts or ends with another", () => {
    const short = "ghp_abcdefghijklmnop";
    const long = `${short}qrstuvwxyz0123456789`;
    const redact = createRedactor([
      { name: "SHORT", value: short },
      { name: "LONG", value: long },
    ]);
    expect(redact(`t=${long.slice(0, short.length + 10)}`, { end: true })).toBe(
      `t=${REDACTED}`,
    );
    const ending = `0123456789${short}`;
    const both = createRedactor([
      { name: "SHORT", value: short },
      { name: "ENDING", value: ending },
    ]);
    expect(both(`${ending.slice(4)} t`, { start: true })).toBe(`${REDACTED} t`);
  });

  it("masks all of a whole secret whose end a cut piece of another starts in", () => {
    const whole = "tok_0123456789abcdefWXYZ";
    const next = "WXYZ_another_secret_0123";
    const redact = createRedactor([
      { name: "WHOLE", value: whole },
      { name: "NEXT", value: next },
    ]);
    expect(redact(`a ${whole}`, { end: true })).toBe(`a ${REDACTED}`);
    expect(redact(`${next} b`, { start: true })).toBe(`${REDACTED} b`);
    // The secrets around it are left as they are.
    expect(redact(`${whole} and WXYZ`, { end: true })).toBe(
      `${REDACTED} and ${REDACTED}`,
    );
  });

  it("masks the longest piece at a cut, a database password's included", () => {
    const redact = createRedactor([
      {
        name: "the DATABASE_URL password",
        value: "correct-horse-battery-staple",
        inUrl: true,
      },
      { name: "TOKEN", value: "staple0123456789abcdef" },
    ]);
    expect(
      redact("postgres://app:correct-horse-battery-staple", { end: true }),
    ).toBe(`postgres://app:${REDACTED}`);
    expect(redact("horse-battery-staple@db:5432/app", { start: true })).toBe(
      `${REDACTED}@db:5432/app`,
    );
  });

  it("masks a text cut at both ends that lies inside a secret", () => {
    const redact = createRedactor([{ name: "OPENAI_API_KEY", value: KEY }]);
    expect(redact(MIDDLE, { start: true, end: true })).toBe(REDACTED);
    // Cut at one end only, a middle piece is ordinary text.
    expect(redact(MIDDLE, { end: true })).toBe(MIDDLE);
  });

  it("masks no piece of a secret too short to redact", () => {
    const redact = createRedactor([{ name: "SHORT_KEY", value: "0123456789" }]);
    expect(redact("key 012345678", { end: true })).toBe("key 012345678");
    expect(redact("123456789 key", { start: true })).toBe("123456789 key");
  });

  it("finds a piece at a cut edge in time linear in the secret, whatever the text", () => {
    // Secrets of the longest stored length that almost match everywhere.
    const redact = createRedactor([
      { name: "HEAD", value: `${"a".repeat(4000)}b` },
      { name: "TAIL", value: `b${"a".repeat(4000)}` },
    ]);
    const text = "a".repeat(2_000_000);
    const started = performance.now();
    expect(redact(text, { start: true, end: true })).toBe(
      `${REDACTED}${"a".repeat(2_000_000 - 2 * 4000)}${REDACTED}`,
    );
    expect(performance.now() - started).toBeLessThan(2_000);
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

  /** A bot on a profile whose sandbox keeps at most `maxOutputBytes` of a command's output. */
  async function limitedBot(
    engine: TestEngine["engine"],
    maxOutputBytes: number,
  ) {
    const { profile } = await engine.profiles.create({
      name: `Limited ${maxOutputBytes} ${Date.now()}`,
      sandbox: {
        driver: "local",
        network: { mode: "open" },
        limits: { maxOutputBytes },
      },
    });
    const team = await createTeam(engine, ["Ada"]);
    const [ada] = team.names as [string];
    const id = team.byName[ada] as string;
    await engine.bots.update(id, { runtimeProfileId: profile.id });
    return { name: ada, id };
  }

  const PREFIX = KEY.slice(0, MIN_CUT_FRAGMENT_LENGTH);
  const SUFFIX = KEY.slice(-MIN_CUT_FRAGMENT_LENGTH);
  const fill = (bytes: number, char: string) =>
    `head -c ${bytes} /dev/zero | tr '\\0' ${char}`;

  it("stores no piece of a key that a sandbox's output limit cut through (driver path)", async () => {
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
    const limit = 2048;
    const bot = await limitedBot(engine, limit);
    const call = (name: string, args: Record<string, string>) =>
      fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" });
    faux.setResponses([
      call("write", { path: "key.txt", content: KEY }),
      // The limit cuts 9 characters into the key.
      call("bash", { command: `${fill(limit - 9, "x")}; cat key.txt` }),
      fauxAssistantMessage(fauxToolCall("complete_task", { result: "Done." }), {
        stopReason: "toolUse",
      }),
    ]);
    const { task } = await engine.tasks.create({
      goal: "Print past the limit",
      coordinatorBotId: bot.id,
    });
    const view = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed" || v.task.status === "failed",
    );
    expect(view.task.status).toBe("completed");
    const stored = await persisted(engine, view);
    // The cut output was spilled whole: the cut is masked there too.
    expect(stored.spills).toHaveLength(1);
    expect(stored.spills[0]).toContain(
      `xxxxxxxx${REDACTED}\n\n[Output was cut`,
    );
    for (const text of [
      stored.events,
      stored.transcript,
      stored.view,
      ...stored.spills,
    ])
      expect(text).not.toContain(PREFIX);
  });

  it("stores no piece of a key that a check's output limit cut through (check path)", async () => {
    current = await testEngine(db.database, {
      secrets: [{ name: "OPENAI_API_KEY", value: KEY }],
      config: { maxVerificationAttempts: 1 },
    });
    const { engine, executor } = current;
    // The collector keeps the first and the last 2048 bytes.
    const limit = 4096;
    const bot = await limitedBot(engine, limit);
    executor.brain(bot.name, (view) =>
      said.turns(view) === 0
        ? {
            calls: [{ name: "write", args: { path: "key.txt", content: KEY } }],
          }
        : lastResult(view)?.name === "complete_task"
          ? { text: "Checked." }
          : { calls: [{ name: "complete_task", args: { result: "done" } }] },
    );
    const command = [
      // The head ends 9 characters into a key, the tail starts 9 before the end of one.
      fill(limit / 2 - 9, "x"),
      "cat key.txt",
      fill(5000, "y"),
      "cat key.txt",
      fill(limit / 2 - (KEY.length - 9), "z"),
      "exit 1",
    ].join("; ");
    const { task } = await engine.tasks.create({
      goal: "Fail a check past the limit",
      coordinatorBotId: bot.id,
      verificationPlan: [
        {
          id: "cut",
          description: "Prints a key on both sides of the cut",
          method: "command",
          command,
        },
      ],
    });
    const view = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "waiting" || v.task.status === "failed",
    );
    const [row] = await db.database.db
      .select()
      .from(verificationChecks)
      .where(eq(verificationChecks.taskId, task.id));
    expect(row?.outcome).toBe("failed");
    expect(row?.output).toContain(`xxxxxxxx${REDACTED}\n[…`);
    expect(row?.output).toContain(`\n${REDACTED}zzzzzzzz`);
    const told = executor.inputs.flatMap((input) => input.inputs).join("\n");
    expect(told).toContain(`${REDACTED}zzzzzzzz`);
    const stored = await persisted(engine, view);
    for (const text of [
      row?.output ?? "",
      told,
      stored.events,
      stored.transcript,
      ...stored.spills,
    ]) {
      expect(text).not.toContain(PREFIX);
      expect(text).not.toContain(SUFFIX);
    }
  });
});
