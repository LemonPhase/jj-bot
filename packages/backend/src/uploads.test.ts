// Uploads: staged bytes attached to a task, placed in its workspace by its
// runs. The placement scenario also runs on docker (docker.test.ts).
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StagedUpload } from "@jj/contracts";
import { artifacts, jobs, runs, stagedUploads } from "@jj/db";
import { LocalSandboxDriver } from "@jj/sandbox";
import type { Sandbox } from "@jj/sandbox/contract";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDriverRegistry } from "./drivers";
import { DomainError } from "./errors";
import type { EngineDriver } from "./ports";
import { type Brain, said } from "./testing/fake-executor";
import {
  OPEN_TIMEOUT,
  openTestDatabase,
  sleep,
  type TestDatabase,
  type TestEngine,
  testEngine,
  until,
  untilTask,
} from "./testing/harness";
import { createTeam, lastResult } from "./testing/scenarios";
import {
  bodyOf,
  notices,
  placementScenario,
  sha256Hex,
  stage,
  uploadsOf,
} from "./testing/uploads";
import { placementNotice, settleUpload } from "./worker/uploads";

let db: TestDatabase;
const engines: TestEngine[] = [];
const roots: string[] = [];

beforeAll(async () => {
  db = await openTestDatabase();
}, OPEN_TIMEOUT);
afterEach(async () => {
  for (const engine of engines.splice(0).reverse()) await engine.dispose();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
afterAll(async () => {
  await db?.close();
});

async function engineWith(options: Parameters<typeof testEngine>[1] = {}) {
  const engine = await testEngine(db.database, options);
  engines.push(engine);
  return engine;
}

/** The refusal `promise` rejects with. */
async function refusal(promise: Promise<unknown>): Promise<DomainError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(DomainError);
  return error as DomainError;
}

/** A body that fails the test if anything reads it. */
const unread = {
  [Symbol.asyncIterator]() {
    throw new Error("The body was read.");
  },
} as AsyncIterable<Uint8Array>;

/** A coordinator that completes at once. */
const quick: Brain = (view) =>
  lastResult(view)?.name === "complete_task"
    ? { text: "done" }
    : { calls: [{ name: "complete_task", args: { result: "ok" } }] };

const sessionRuns = async (taskId: string) =>
  (await db.database.db.select().from(runs).where(eq(runs.taskId, taskId)))
    .length;

describe("placement", () => {
  it("places uploads before the coordinator's first model call, and at a boundary of a running task without waking anything", async () => {
    const { engine, executor } = await engineWith();
    const view = await placementScenario(engine, executor);
    // One run did all of it: the uploads into the running task woke nothing.
    expect(await sessionRuns(view.task.id)).toBe(1);
    const [announced] = view.messages.filter(
      (message) => message.authorKind === "user",
    );
    expect(announced).toMatchObject({
      intent: "notification",
      recipientBotIds: [],
      text: "Uploaded 2 files: uploads/a.csv (20 B), uploads/b.bin (8 B)",
    });
    expect(
      uploadsOf(view)
        .filter((artifact) => artifact.path.match(/uploads\/[ab]\./))
        .map((artifact) => artifact.upload?.messageId),
    ).toEqual([announced?.id, announced?.id]);
  });

  it("starts nothing for an upload into a completed task; the next message continues it and places the file first", async () => {
    const { engine, executor } = await engineWith();
    const team = await createTeam(engine, ["Ada"]);
    const [ada] = team.names as [string];
    let continued = false;
    executor.brain(ada, (view) => {
      if (!said.heard(view, "Message from the user")) return quick(view);
      if (!continued) {
        continued = true;
        return {
          calls: [{ name: "bash", args: { command: "cat uploads/notes.md" } }],
        };
      }
      return lastResult(view)?.name === "complete_task"
        ? { text: "done" }
        : {
            calls: [
              {
                name: "complete_task",
                args: { result: lastResult(view)?.text.trim() ?? "" },
              },
            ],
          };
    });
    const { task } = await engine.tasks.create({
      goal: "Finish quickly",
      coordinatorBotId: team.byName[ada] as string,
    });
    await untilTask(engine, task.id, (v) => v.task.status === "completed");
    const before = await sessionRuns(task.id);
    const notes = await stage(engine, "notes.md", "# Notes\nfrom the user\n");
    const { artifacts: attached, message } = await engine.tasks.upload(
      task.id,
      { files: [{ uploadId: notes.id }] },
    );
    expect(message.text).toBe("Uploaded 1 file: uploads/notes.md (22 B)");
    await sleep(300);
    const waiting = await engine.tasks.get(task.id);
    expect(waiting.task.status).toBe("completed");
    expect(await sessionRuns(task.id)).toBe(before);
    expect(uploadsOf(waiting)[0]?.upload?.state).toBe("pending");
    expect(attached[0]?.upload?.state).toBe("pending");
    const queued = await db.database.db
      .select()
      .from(jobs)
      .where(and(eq(jobs.taskId, task.id), eq(jobs.status, "queued")));
    expect(queued).toHaveLength(0);

    await engine.tasks.postMessage(task.id, { text: "Read my notes" });
    const view = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed" && continued,
      "the continued task",
    );
    expect(view.task.result).toBe("# Notes\nfrom the user");
    expect(uploadsOf(view)[0]?.upload).toMatchObject({ state: "placed" });
  });

  it("places again after a crash between the move and its record: one notice, no second artifact", async () => {
    const root = await mkdtemp(join(tmpdir(), "jj-upload-crash-"));
    roots.push(root);
    const crash = { armed: true, engine: undefined as TestEngine | undefined };
    const local = new LocalSandboxDriver({ root, killGraceMs: 200 });
    // The first move of a part file lands, then the worker dies at once.
    const crashing: EngineDriver = {
      id: local.id,
      capabilities: local.capabilities,
      validateSpec: (spec) => local.validateSpec(spec),
      probe: () => local.probe(),
      async acquire(request) {
        const sandbox = await local.acquire(request);
        const fs = {
          ...sandbox.fs,
          async move(from: string, to: string) {
            await sandbox.fs.move(from, to);
            if (crash.armed && from.includes(".jj-upload-")) {
              crash.armed = false;
              void crash.engine?.engine.worker.abandon();
            }
          },
        };
        return new Proxy(sandbox, {
          get: (target, key) =>
            key === "fs" ? fs : Reflect.get(target, key, target),
        }) as Sandbox;
      },
    };
    const first = await engineWith({
      workspaceRoot: root,
      registry: createDriverRegistry([{ driver: crashing, label: "Local" }]),
      config: { leaseMs: 1_000 },
    });
    crash.engine = first;
    const team = await createTeam(first.engine, ["Ada"]);
    const [ada] = team.names as [string];
    const reader: Brain = (view) =>
      said.turns(view) === 0
        ? { calls: [{ name: "bash", args: { command: "cat uploads/x.txt" } }] }
        : lastResult(view)?.name === "complete_task"
          ? { text: "done" }
          : {
              calls: [
                {
                  name: "complete_task",
                  args: { result: lastResult(view)?.text.trim() ?? "" },
                },
              ],
            };
    first.executor.brain(ada, reader);
    const x = await stage(first.engine, "x.txt", "crash-proof\n");
    const { task } = await first.engine.tasks.create({
      goal: "Read x",
      coordinatorBotId: team.byName[ada] as string,
      uploads: [{ uploadId: x.id }],
    });
    await until(() => !crash.armed, { what: "the crash" });
    const second = await engineWith({
      workspaceRoot: root,
      config: { leaseMs: 1_000 },
    });
    second.executor.brain(ada, reader);
    const view = await untilTask(
      second.engine,
      task.id,
      (v) => v.task.status === "completed",
      "the recovered task",
    );
    expect(view.task.result).toBe("crash-proof");
    expect(first.executor.inputs).toHaveLength(0);
    expect(view.artifacts.map((artifact) => artifact.path)).toEqual([
      "uploads/x.txt",
    ]);
    expect(uploadsOf(view)[0]?.upload?.state).toBe("placed");
    expect(await notices(second.engine, task.id)).toHaveLength(1);
    expect(
      view.events.filter((event) => event.type === "artifact.updated"),
    ).toHaveLength(1);
  });

  it("replaces a symlink at the target that points out of the workspace, and fails a file whose folder leads out", async () => {
    const outside = await mkdtemp(join(tmpdir(), "jj-upload-outside-"));
    roots.push(outside);
    const victim = join(outside, "victim.txt");
    await writeFile(victim, "untouched\n");
    const { engine, executor, workspaceRoot } = await engineWith();
    const team = await createTeam(engine, ["Ada"]);
    const [ada] = team.names as [string];
    executor.brain(ada, (view) => {
      switch (said.turns(view)) {
        case 0:
          return {
            calls: [
              {
                name: "bash",
                args: {
                  command: `mkdir -p uploads && ln -s ${victim} uploads/a.txt && ln -s ${outside} out`,
                },
              },
            ],
          };
        case 1:
          return { calls: [{ name: "gate", args: { name: `${ada}-out` } }] };
        case 2:
          return {
            calls: [
              {
                name: "bash",
                args: {
                  command:
                    "test -L uploads/a.txt && echo link || cat uploads/a.txt",
                },
              },
            ],
          };
        default:
          return lastResult(view)?.name === "complete_task"
            ? { text: "done" }
            : {
                calls: [
                  {
                    name: "complete_task",
                    args: { result: lastResult(view)?.text.trim() ?? "" },
                  },
                ],
              };
      }
    });
    const { task } = await engine.tasks.create({
      goal: "Links",
      coordinatorBotId: team.byName[ada] as string,
    });
    await executor.gate(`${ada}-out`).reached;
    const a = await stage(engine, "a.txt", "from the user\n");
    const b = await stage(engine, "b.txt", "escape attempt\n");
    await engine.tasks.upload(task.id, {
      files: [{ uploadId: a.id }, { uploadId: b.id, path: "out/b.txt" }],
    });
    executor.gate(`${ada}-out`).open();
    const view = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed",
    );
    expect(await readFile(victim, "utf8")).toBe("untouched\n");
    await expect(readFile(join(outside, "b.txt"))).rejects.toThrow();
    expect(view.task.result).toBe("from the user");
    expect(
      Object.fromEntries(
        uploadsOf(view).map((artifact) => [
          artifact.path,
          [artifact.upload?.state, artifact.upload?.error],
        ]),
      ),
    ).toEqual({
      "uploads/a.txt": ["placed", null],
      "out/b.txt": [
        "failed",
        "its folder leads out of the workspace (a symbolic link)",
      ],
    });
    expect(workspaceRoot).toBeTruthy();
  });
});

describe("limits and refusals", () => {
  it("checks a file's size, the uploads in flight and the staging space before reading a byte", async () => {
    const { engine } = await engineWith({
      start: false,
      config: {
        uploads: { maxFileBytes: 1024, maxInFlight: 1, maxStagedBytes: 1500 },
      },
    });
    const big = await refusal(
      engine.uploads.stage({ name: "big.bin", sizeBytes: 2048, body: unread }),
    );
    expect(big.code).toBe("UPLOAD_TOO_LARGE");
    expect(big.status).toBe(413);
    expect(big.message).toBe("big.bin is 2 KB; a file can be at most 1 KB.");
    const huge = await refusal(
      engine.uploads.stage({
        name: "huge.bin",
        sizeBytes: 2 ** 50,
        body: unread,
      }),
    );
    expect(huge.code).toBe("UPLOAD_TOO_LARGE");

    // One upload in flight: a second is refused until it ends.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* slow() {
      await held;
      yield Buffer.alloc(1000, 1);
    }
    const first = engine.uploads.stage({
      name: "slow.bin",
      sizeBytes: 1000,
      body: slow(),
    });
    const busy = await refusal(
      engine.uploads.stage({ name: "next.bin", sizeBytes: 10, body: unread }),
    );
    expect(busy.code).toBe("RATE_LIMITED");
    release();
    await first;
    // 1000 bytes staged: 600 more would pass the 1500 of staging space.
    const full = await refusal(
      engine.uploads.stage({ name: "more.bin", sizeBytes: 600, body: unread }),
    );
    expect(full.code).toBe("UPLOAD_TOO_LARGE");
    expect(full.message).toMatch(/staging space is full/);
    await stage(engine, "fits.bin", Buffer.alloc(500));
  });

  it("refuses bad names, other extensions and bodies that differ from their length", async () => {
    const { engine } = await engineWith({
      start: false,
      config: { uploads: { extensions: [".csv", ".txt"] } },
    });
    for (const name of [
      undefined,
      "",
      "../etc/passwd",
      "a/b.txt",
      "..",
      "-rf.txt",
      "nul\u0000.txt",
      "line\nbreak.txt",
      `rtl${String.fromCodePoint(0x202e)}txt.csv`,
      "trailing.txt ",
      "back\\slash.txt",
    ]) {
      const error = await refusal(
        engine.uploads.stage({ name, sizeBytes: 1, body: unread }),
      );
      expect(error.code, String(name)).toBe("VALIDATION_FAILED");
    }
    const other = await refusal(
      engine.uploads.stage({ name: "run.sh", sizeBytes: 1, body: unread }),
    );
    expect(other.message).toBe(
      "This server takes only files ending in .csv, .txt.",
    );
    const short = await refusal(
      engine.uploads.stage({
        name: "short.csv",
        sizeBytes: 10,
        body: bodyOf(Buffer.from("abc")),
      }),
    );
    expect(short.message).toBe(
      "The body holds 3 bytes; its Content-Length says 10.",
    );
    const long = await refusal(
      engine.uploads.stage({
        name: "long.csv",
        sizeBytes: 2,
        body: bodyOf(Buffer.from("abc")),
      }),
    );
    expect(long.message).toBe("The body is longer than its Content-Length.");
    // A name in NFD is stored in NFC.
    const nfd = await stage(
      engine,
      `cafe${String.fromCodePoint(0x301)}.txt`,
      "x",
    );
    expect(nfd.name).toBe(`caf${String.fromCodePoint(0xe9)}.txt`);
    // Nothing refused was stored.
    const stored = await db.database.db
      .select({ name: stagedUploads.name })
      .from(stagedUploads)
      .where(eq(stagedUploads.name, "short.csv"));
    expect(stored).toHaveLength(0);
  });

  it("refuses commands over the limits, unknown, expired or reused uploads, clashing paths and stopped tasks", async () => {
    let now = Date.now();
    const { engine, executor } = await engineWith({
      clock: () => new Date(now),
      config: {
        uploads: { maxFiles: 2, maxTaskBytes: 100, maxCommandBytes: 60 },
      },
    });
    const team = await createTeam(engine, ["Ada"]);
    const [ada] = team.names as [string];
    executor.brain(ada, quick);
    const { task } = await engine.tasks.create({
      goal: "Hold uploads",
      coordinatorBotId: team.byName[ada] as string,
    });
    await untilTask(engine, task.id, (v) => v.task.status === "completed");
    const upload = (files: { uploadId: string; path?: string }[]) =>
      engine.tasks.upload(task.id, { files });
    const thirty = () => stage(engine, "t.txt", "x".repeat(30));

    const three = await Promise.all([thirty(), thirty(), thirty()]);
    const many = await refusal(
      upload(
        three.map((staged, index) => ({
          uploadId: staged.id,
          path: `p${index}.txt`,
        })),
      ),
    );
    expect(many.code).toBe("UPLOAD_TOO_LARGE");
    expect(many.message).toBe(
      "A command attaches at most 2 files; this one has 3.",
    );
    const [one, two] = three as unknown as [StagedUpload, StagedUpload];
    const big = await stage(engine, "big.txt", "y".repeat(41));
    const command = await refusal(
      upload([{ uploadId: one.id }, { uploadId: big.id }]),
    );
    expect(command.message).toMatch(/one command attaches at most 60 B/);
    // Same name, no path: both would land on uploads/t.txt.
    const clash = await refusal(
      upload([{ uploadId: one.id }, { uploadId: two.id }]),
    );
    expect(clash.code).toBe("VALIDATION_FAILED");
    expect(clash.message).toMatch(/Two uploads go to uploads\/t\.txt/);

    // Pending at uploads/t.txt (the task is completed, so nothing places it).
    await upload([{ uploadId: one.id }]);
    const again = await refusal(upload([{ uploadId: one.id }]));
    expect(again.code).toBe("CONFLICT");
    expect(again.message).toMatch(/^Already attached: /);
    const pending = await refusal(
      upload([{ uploadId: two.id, path: "Uploads/T.TXT" }]),
    );
    expect(pending.code).toBe("CONFLICT");
    expect(pending.message).toMatch(/already goes to uploads\/t\.txt/);
    await upload([{ uploadId: two.id, path: "elsewhere/t.txt" }]);
    // 60 of the task's 100 bytes are taken.
    const task100 = await refusal(upload([{ uploadId: big.id }]));
    expect(task100.message).toMatch(/would pass its limit of 100 B/);

    const unknown = await refusal(upload([{ uploadId: "upl_missing" }]));
    expect(unknown.code).toBe("NOT_FOUND");
    for (const path of [
      "../escape.txt",
      "/etc/passwd",
      ".git/hooks/x",
      ".JJ/x",
      "a//b",
    ]) {
      const bad = await refusal(
        engine.tasks.upload(task.id, {
          files: [{ uploadId: big.id, path }],
        }),
      );
      expect(bad.code, path).toBe("VALIDATION_FAILED");
    }

    // An hour on, the staged upload is gone; the sweep deletes it.
    now += 61 * 60_000;
    const expired = await refusal(upload([{ uploadId: big.id }]));
    expect(expired.code).toBe("NOT_FOUND");
    await expect(engine.uploads.delete(big.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const { sweepStagedUploads } = await import("./services/uploads");
    expect(await sweepStagedUploads(engine.context)).toBeGreaterThan(0);
    expect(
      await db.database.db
        .select({ id: stagedUploads.id })
        .from(stagedUploads)
        .where(eq(stagedUploads.id, big.id)),
    ).toHaveLength(0);

    const late = await stage(engine, "late.txt", "z");
    await engine.tasks.stop(task.id).catch(() => undefined);
    const live = await engine.tasks.create({
      goal: "Stopped",
      coordinatorBotId: team.byName[ada] as string,
    });
    await engine.tasks.stop(live.task.id);
    const stopped = await refusal(
      engine.tasks.upload(live.task.id, { files: [{ uploadId: late.id }] }),
    );
    expect(stopped.code).toBe("TASK_TERMINAL");
    // A refused command leaves the staged upload to attach elsewhere.
    await engine.uploads.delete(late.id);
  });

  it("answers NOT_FOUND everywhere, and reports no capability, when uploads are off", async () => {
    const { engine } = await engineWith({
      start: false,
      config: { uploads: null },
    });
    expect((await engine.bootstrap()).capabilities.uploads).toBeNull();
    const off = await refusal(
      engine.uploads.stage({ name: "a.txt", sizeBytes: 1, body: unread }),
    );
    expect(off.code).toBe("NOT_FOUND");
    const team = await createTeam(engine, ["Ada"]);
    const create = await refusal(
      engine.tasks.create({
        goal: "x",
        coordinatorBotId: team.byName[team.names[0] as string] as string,
        uploads: [{ uploadId: "upl_x" }],
      }),
    );
    expect(create.code).toBe("NOT_FOUND");
    const on = await engineWith({ start: false });
    expect((await on.engine.bootstrap()).capabilities.uploads).toEqual({
      maxFileBytes: 16 * 1024 * 1024,
      maxFiles: 20,
      maxTaskBytes: 128 * 1024 * 1024,
    });
  });
});

describe("a draining worker", () => {
  it("places nothing in a run it is handing back, even where the turn has ended", async () => {
    const { engine, executor } = await engineWith();
    const team = await createTeam(engine, ["Ada"]);
    const [ada] = team.names as [string];
    let answer = () => {};
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    let thinking = () => {};
    const started = new Promise<void>((resolve) => {
      thinking = resolve;
    });
    // The model's only turn ends with text, while the worker drains.
    executor.brain(ada, async () => {
      thinking();
      await answered;
      return { text: "Which format do you want?" };
    });
    const { task } = await engine.tasks.create({
      goal: "Ask first",
      coordinatorBotId: team.byName[ada] as string,
    });
    await started;
    const staged = await stage(engine, "late.txt", "late");
    await engine.tasks.upload(task.id, { files: [{ uploadId: staged.id }] });
    const drained = engine.worker.drain(600_000);
    answer();
    await drained;
    const view = await engine.tasks.get(task.id);
    expect(view.task.status).toBe("waiting");
    expect(uploadsOf(view)[0]?.upload?.state).toBe("pending");
    expect(await notices(engine, task.id)).toHaveLength(0);
  });
});

describe("settling an upload", () => {
  it("records its outcome once: a later attempt changes nothing, emits nothing and tells nothing", async () => {
    const { engine, executor } = await engineWith();
    const team = await createTeam(engine, ["Ada"]);
    const [ada] = team.names as [string];
    executor.brain(ada, quick);
    const { task } = await engine.tasks.create({
      goal: "Hold an upload",
      coordinatorBotId: team.byName[ada] as string,
    });
    await untilTask(engine, task.id, (v) => v.task.status === "completed");
    const staged = await stage(engine, "a.txt", "one");
    await engine.tasks.upload(task.id, { files: [{ uploadId: staged.id }] });
    const settle = (
      outcome: Parameters<typeof settleUpload>[4],
    ): Promise<boolean> =>
      engine.context.db.transaction((tx) =>
        settleUpload(tx, engine.context, task.id, staged.id, outcome, {}),
      );
    expect(await settle({ kind: "placed" })).toBe(true);
    expect(
      await settle({ kind: "failed", error: "a directory is in the way" }),
    ).toBe(false);
    expect(await settle({ kind: "placed" })).toBe(false);
    const view = await engine.tasks.get(task.id);
    expect(uploadsOf(view)[0]?.upload).toMatchObject({
      state: "placed",
      error: null,
    });
    expect(
      view.events.filter((event) => event.type === "artifact.updated"),
    ).toHaveLength(1);
    expect(await notices(engine, task.id)).toHaveLength(1);
  });
});

describe("secrets in names", () => {
  it("stages a name holding a server secret redacted, and places the file under that name", async () => {
    const key = "sk-staged-name-secret-0123456789";
    const { engine, executor } = await engineWith({
      secrets: [{ name: "OPENAI_API_KEY", value: key }],
    });
    const staged = await stage(engine, `${key}.csv`, "a,b\n");
    expect(staged.name).toBe("[redacted].csv");
    // The content type still comes from the real name.
    expect(staged.contentType).toBe("text/csv; charset=utf-8");
    const rows = await db.database.db
      .select({ name: stagedUploads.name })
      .from(stagedUploads)
      .where(eq(stagedUploads.id, staged.id));
    expect(rows).toEqual([{ name: "[redacted].csv" }]);
    const team = await createTeam(engine, ["Ada"]);
    const [ada] = team.names as [string];
    executor.brain(ada, (view) =>
      said.turns(view) === 0
        ? { calls: [{ name: "bash", args: { command: "ls uploads" } }] }
        : lastResult(view)?.name === "complete_task"
          ? { text: "done" }
          : {
              calls: [
                {
                  name: "complete_task",
                  args: { result: lastResult(view)?.text.trim() ?? "" },
                },
              ],
            },
    );
    const { task } = await engine.tasks.create({
      goal: "List the uploads",
      coordinatorBotId: team.byName[ada] as string,
      uploads: [{ uploadId: staged.id }],
    });
    const view = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed",
    );
    expect(view.task.result).toBe("[redacted].csv");
    expect(uploadsOf(view)[0]?.path).toBe("uploads/[redacted].csv");
  });
});

describe("paths that differ only in case", () => {
  /** A finished task with no run left to place what it is given. */
  async function idleTask() {
    const { engine, executor } = await engineWith();
    const team = await createTeam(engine, ["Ada"]);
    const [ada] = team.names as [string];
    executor.brain(ada, quick);
    const { task } = await engine.tasks.create({
      goal: "Hold uploads",
      coordinatorBotId: team.byName[ada] as string,
    });
    await untilTask(engine, task.id, (v) => v.task.status === "completed");
    return { engine, taskId: task.id };
  }

  it("refuses a second pending upload at a non-ASCII path with 409, as the database folds case", async () => {
    const { engine, taskId } = await idleTask();
    const dotted = `uploads/${String.fromCodePoint(0x130)}.txt`;
    const first = await stage(engine, "a.txt", "one");
    await engine.tasks.upload(taskId, {
      files: [{ uploadId: first.id, path: dotted }],
    });
    const second = await stage(engine, "b.txt", "two");
    const again = await refusal(
      engine.tasks.upload(taskId, {
        files: [{ uploadId: second.id, path: dotted }],
      }),
    );
    expect(again.code).toBe("CONFLICT");
    expect(again.message).toMatch(/already goes to/);
  });

  it("refuses two uploads of one command that the database folds to one path", async () => {
    const { engine, taskId } = await idleTask();
    // JavaScript folds a final capital sigma to ς, the database to σ.
    const capital = `uploads/a${String.fromCodePoint(0x3a3)}`;
    const small = `uploads/a${String.fromCodePoint(0x3c3)}`;
    const [folded] = (
      (await db.database.db.execute(
        sql`select lower(${capital}) as capital, lower(${small}) as small`,
      )) as unknown as { rows: { capital: string; small: string }[] }
    ).rows;
    const a = await stage(engine, "a.txt", "one");
    const b = await stage(engine, "b.txt", "two");
    const both = engine.tasks.upload(taskId, {
      files: [
        { uploadId: a.id, path: capital },
        { uploadId: b.id, path: small },
      ],
    });
    if (folded?.capital === folded?.small) {
      const error = await refusal(both);
      expect(["CONFLICT", "VALIDATION_FAILED"]).toContain(error.code);
    } else await both;
  });
});

describe("records", () => {
  it("lists uploads in task_state and the announcement as the user's in task_log, and starts templates with uploads", async () => {
    const { engine, executor } = await engineWith();
    const team = await createTeam(engine, ["Ada"]);
    const [ada] = team.names as [string];
    executor.brain(ada, (view) => {
      switch (said.turns(view)) {
        case 0:
          return { calls: [{ name: "task_state", args: {} }] };
        case 1:
          return { calls: [{ name: "task_log", args: { kind: "user" } }] };
        default:
          return lastResult(view)?.name === "complete_task"
            ? { text: "done" }
            : {
                calls: [
                  {
                    name: "complete_task",
                    args: {
                      result: said
                        .results(view)
                        .map((result) => result.text)
                        .join("\n---\n"),
                    },
                  },
                ],
              };
      }
    });
    const { template } = await engine.templates.create({
      title: "Read data",
      goal: "Read the data",
      coordinatorBotId: team.byName[ada] as string,
    });
    const data = await stage(engine, "data.csv", "a,b\n1,2\n");
    const { task } = await engine.templates.start(template.id, {
      uploads: [{ uploadId: data.id, path: "in/data.csv" }],
    });
    expect(task.templateId).toBe(template.id);
    const view = await untilTask(
      engine,
      task.id,
      (v) => v.task.status === "completed",
    );
    const [state, log] = (view.task.result ?? "").split("\n---\n");
    expect(state).toContain(
      "Files the user uploaded, oldest first:\n- in/data.csv (8 B): in the workspace",
    );
    expect(log).toMatch(
      /\[user\] user: Uploaded 1 file: in\/data\.csv \(8 B\)/,
    );
    expect(uploadsOf(view)[0]?.sha256).toBe(sha256Hex("a,b\n1,2\n"));
    // Stored once: the staged row moved into the task.
    expect(
      await db.database.db
        .select({ id: artifacts.id })
        .from(artifacts)
        .where(eq(artifacts.id, data.id)),
    ).toHaveLength(1);
  });

  it("words the notice for placed and refused files", () => {
    const row = (path: string, state: string, error: string | null = null) => ({
      path,
      sizeBytes: 1200,
      uploadState: state,
      uploadError: error,
    });
    expect(placementNotice("msg_1", [row("uploads/a.csv", "placed")])).toBe(
      "[Uploads] Now in the workspace: uploads/a.csv (1.2 KB). The user uploaded these files (task log entry msg_1).",
    );
    expect(
      placementNotice("msg_2", [
        row("uploads/b", "failed", "a directory is in the way"),
      ]),
    ).toBe(
      "[Uploads] Not placed: uploads/b (a directory is in the way). The user uploaded these files (task log entry msg_2).",
    );
  });
});
