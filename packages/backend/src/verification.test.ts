import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isVerified,
  type TaskView,
  type VerificationPlan,
  verificationSummary,
} from "@jj/contracts";
import { sessions, verificationChecks } from "@jj/db";
import { and, asc, eq, isNull } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { type Brain, said } from "./testing/fake-executor";
import {
  OPEN_TIMEOUT,
  openTestDatabase,
  type TestDatabase,
  type TestEngine,
  testEngine,
  until,
  untilTask,
} from "./testing/harness";
import { createTeam } from "./testing/scenarios";

let db: TestDatabase;
const engines: TestEngine[] = [];

beforeAll(async () => {
  db = await openTestDatabase();
}, OPEN_TIMEOUT);
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.dispose();
});
afterAll(async () => {
  await db?.close();
});

async function setup(options: Parameters<typeof testEngine>[1] = {}) {
  const engine = await testEngine(db.database, options);
  engines.push(engine);
  return engine;
}

const status = (value: string) => (view: TaskView) =>
  view.task.status === value;

const VERIFICATION_HEADER = "Verification of goal version";

/**
 * A coordinator that runs `work` (bash commands, one per turn), then calls
 * complete_task; told that verification failed, it runs `fix` and completes
 * again; refused, it ends its turn saying so.
 */
function coordinator(
  work: string[],
  fix: string[] = [],
  result = "Done: out.txt written",
): Brain {
  return (view) => {
    const last = view.messages.at(-1);
    if (last?.role === "tool" && last.name === "complete_task")
      return { text: last.isError ? `Cannot complete: ${last.text}` : "Done." };
    const ran = said
      .results(view)
      .filter((message) => message.name === "bash").length;
    const failures = said
      .inputs(view)
      .filter((text) => text.startsWith(VERIFICATION_HEADER)).length;
    const plan = [...work, ...(failures > 0 ? fix : [])];
    const next = plan[ran];
    if (next !== undefined)
      return { calls: [{ name: "bash", args: { command: next } }] };
    return { calls: [{ name: "complete_task", args: { result } }] };
  };
}

async function planned(
  engine: TestEngine["engine"],
  brain: Brain,
  executor: TestEngine["executor"],
  plan: VerificationPlan,
  goal = "Write out.txt",
) {
  const team = await createTeam(engine, ["Ada"]);
  const [ada] = team.names as [string];
  executor.brain(ada, brain);
  const { task } = await engine.tasks.create({
    goal,
    coordinatorBotId: team.byName[ada] as string,
    verificationPlan: plan,
  });
  return { task, ada, adaId: team.byName[ada] as string };
}

const summaryOf = (view: TaskView) =>
  verificationSummary(view.task, view.verificationChecks);

describe("verification gate", () => {
  it("accepts a plan and completes only after every check passes, recording each one's evidence", async () => {
    const { engine, executor } = await setup();
    const plan: VerificationPlan = [
      {
        id: "runs",
        description: "out.txt says hello, in the task workspace",
        method: "command",
        command: "cat out.txt && pwd",
      },
      {
        id: "file",
        description: "out.txt greets",
        method: "file",
        path: "out.txt",
        expect: "matches",
        value: "^hel+o$",
        flags: "m",
      },
      {
        id: "result",
        description: "The result names the file",
        method: "result",
        expect: "contains",
        value: "out.txt",
      },
    ];
    const { task } = await planned(
      engine,
      coordinator(["echo hello > out.txt"]),
      executor,
      plan,
    );
    expect(task.verificationPlan).toEqual(plan);
    const view = await untilTask(engine, task.id, status("completed"));
    expect(view.verificationChecks.map((check) => check.outcome)).toEqual([
      "passed",
      "passed",
      "passed",
    ]);
    const [command, file, result] = view.verificationChecks;
    expect(command).toMatchObject({
      criterionId: "runs",
      method: "command",
      goalVersion: 1,
      attempt: 1,
      exitCode: 0,
      interrupted: "no",
      truncated: false,
    });
    // It ran in the task's own workspace, where the coordinator wrote out.txt.
    expect(command?.output).toContain("hello");
    expect(command?.output).toContain(task.id);
    expect(file?.detail).toContain("matches /^hel+o$/m at line 1");
    expect(result?.detail).toContain('contains "out.txt"');
    expect(isVerified(view.task, summaryOf(view))).toBe(true);
    const types = view.events.map((event) => event.type);
    expect(types.filter((type) => type.startsWith("verification."))).toEqual([
      "verification.started",
      "verification.checked",
      "verification.checked",
      "verification.checked",
      "verification.finished",
    ]);
    // The checks ran after the turn ended and before the task completed.
    expect(types.indexOf("verification.finished")).toBeLessThan(
      types.indexOf("task.finished"),
    );
    expect(
      view.messages.find((message) => message.authorKind === "system")?.text,
    ).toBe(
      "Verification passed: all 3 checks passed (goal version 1, attempt 1).",
    );
    const [summary] = (await engine.tasks.list()).tasks.filter(
      (entry) => entry.id === task.id,
    );
    expect(summary?.verification).toMatchObject({
      state: "passed",
      passed: 3,
      total: 3,
    });
    // The coordinator saw the plan in its prompt.
    expect(executor.inputs[0]?.systemPrompt).toContain("## Verification plan");
    expect(executor.inputs[0]?.systemPrompt).toContain(
      "- runs: out.txt says hello, in the task workspace (the command `cat out.txt && pwd` exits with code 0)",
    );
  });

  it("refuses completion on a failing command, gives the coordinator the outcome, and completes once it fixes the work", async () => {
    const { engine, executor } = await setup();
    const { task } = await planned(
      engine,
      coordinator([], ["echo fixed > fixed.txt"]),
      executor,
      [
        {
          id: "fixed",
          description: "fixed.txt exists",
          method: "command",
          command: "cat fixed.txt",
        },
      ],
    );
    const view = await untilTask(engine, task.id, status("completed"));
    const rows = await db.database.db
      .select()
      .from(verificationChecks)
      .where(eq(verificationChecks.taskId, task.id))
      .orderBy(asc(verificationChecks.attempt));
    expect(rows.map((row) => [row.attempt, row.outcome, row.exitCode])).toEqual(
      [
        [1, "failed", 1],
        [2, "passed", 0],
      ],
    );
    expect(rows[0]?.detail).toMatch(/^Exited with code 1 in /);
    expect(rows[0]?.output).toContain("fixed.txt");
    // The view keeps the latest attempt; the coordinator was told the failure.
    expect(view.verificationChecks.map((check) => check.attempt)).toEqual([2]);
    const told = executor.inputs
      .flatMap((input) => input.inputs)
      .find((text) => text.startsWith(VERIFICATION_HEADER));
    expect(told).toContain(
      "Verification of goal version 1, attempt 1: 0 of 1 checks passed, so the task did not complete.",
    );
    expect(told).toContain(
      "- fixed (fixed.txt exists): FAILED. `cat fixed.txt` Exited with code 1",
    );
    expect(told).toContain("> cat: ");
    expect(told).toContain("2 more attempts in this run");
    // The task finished once, completed, after the passing attempt.
    const page = await engine.tasks.events(task.id);
    expect(
      page.events
        .filter((event) => event.type === "task.finished")
        .map((event) => event.type === "task.finished" && event.payload.status),
    ).toEqual(["completed"]);
    expect(
      page.events
        .filter((event) => event.type === "verification.finished")
        .map(
          (event) =>
            event.type === "verification.finished" && event.payload.outcome,
        ),
    ).toEqual(["failed", "passed"]);
    expect(executor.executed.map((entry) => entry.command)).toEqual([
      "echo fixed > fixed.txt",
    ]);
  });

  it("never completes with a failed check: after the last attempt the task waits for the user, unverified", async () => {
    const secret = "sk-verification-secret-0123456789";
    const { engine, executor } = await setup({
      config: { maxVerificationAttempts: 2 },
      secrets: [{ name: "OPENAI_API_KEY", value: secret }],
    });
    const { task } = await planned(engine, coordinator([]), executor, [
      {
        id: "never",
        description: "Never passes",
        method: "command",
        command: `echo token ${secret}; exit 3`,
      },
    ]);
    const view = await untilTask(engine, task.id, status("waiting"));
    expect(view.task.result).toBeNull();
    expect(view.events.some((event) => event.type === "task.finished")).toBe(
      false,
    );
    const summary = summaryOf(view);
    expect(summary).toMatchObject({ state: "failed", attempt: 2, failed: 1 });
    expect(isVerified(view.task, summary)).toBe(false);
    const rows = await db.database.db
      .select()
      .from(verificationChecks)
      .where(eq(verificationChecks.taskId, task.id));
    expect(rows.map((row) => [row.attempt, row.exitCode])).toEqual([
      [1, 3],
      [2, 3],
    ]);
    // Output is redacted before it is stored or shown to the model.
    for (const row of rows) {
      expect(row.output).toContain("token [redacted]");
      expect(row.output).not.toContain(secret);
    }
    const inputs = executor.inputs.flatMap((input) => input.inputs);
    expect(inputs.join("\n")).not.toContain(secret);
    expect(inputs.at(-1)).toContain(
      "No verification attempts are left in this run",
    );
    // A third complete_task is refused, and the coordinator's own words reach the user.
    const refusals = (await engine.tasks.events(task.id)).events.filter(
      (event) =>
        event.type === "tool.finished" &&
        event.payload.tool === "complete_task" &&
        !event.payload.ok,
    );
    expect(refusals).toHaveLength(1);
    expect(view.messages.at(-1)).toMatchObject({
      authorKind: "bot",
      intent: "discussion",
    });
    expect(view.messages.at(-1)?.text).toContain(
      "No verification attempts are left",
    );
  });

  it("blocks completion on inconclusive checks and counts a timeout as failed", async () => {
    const { engine, executor, workspaceRoot } = await setup({
      config: { maxVerificationAttempts: 1 },
    });
    const { task } = await planned(
      engine,
      coordinator(["head -c 1100000 /dev/zero > big.bin"]),
      executor,
      [
        {
          id: "big",
          description: "big.bin is JSON",
          method: "file",
          path: "big.bin",
          expect: "json",
        },
        {
          id: "slow",
          description: "A slow command",
          method: "command",
          command: "sleep 5",
          timeoutSeconds: 1,
        },
        {
          id: "missing",
          description: "missing.txt exists",
          method: "file",
          path: "missing.txt",
          expect: "exists",
        },
      ],
    );
    const view = await untilTask(engine, task.id, status("waiting"));
    expect(
      view.verificationChecks.map((check) => [
        check.criterionId,
        check.outcome,
      ]),
    ).toEqual([
      ["big", "inconclusive"],
      ["slow", "failed"],
      ["missing", "failed"],
    ]);
    expect(view.verificationChecks[0]?.detail).toContain("more than the 1 MiB");
    expect(view.verificationChecks[1]?.detail).toBe("Timed out after 1 s.");
    expect(view.verificationChecks[2]?.detail).toBe(
      "`missing.txt` does not exist.",
    );
    expect(isVerified(view.task, summaryOf(view))).toBe(false);
    expect(workspaceRoot).toBeTruthy();
  });

  it("keeps a long output's head and tail and stores it whole as an artifact", async () => {
    const { engine, executor } = await setup();
    const { task } = await planned(engine, coordinator([]), executor, [
      {
        id: "long",
        description: "Prints a lot",
        method: "command",
        command: "seq 1 20000",
      },
    ]);
    const view = await untilTask(engine, task.id, status("completed"));
    const [check] = view.verificationChecks;
    expect(check).toMatchObject({ outcome: "passed", truncated: true });
    expect(Buffer.byteLength(check?.output ?? "")).toBeLessThanOrEqual(
      8 * 1024,
    );
    expect(check?.output?.startsWith("1\n2\n3\n")).toBe(true);
    expect(check?.output?.trimEnd().endsWith("19999\n20000")).toBe(true);
    const artifact = view.artifacts.find(
      (entry) => entry.id === check?.artifactId,
    );
    expect(artifact?.kind).toBe("output");
    const content = await engine.tasks.artifactContent(
      task.id,
      check?.artifactId as string,
    );
    expect(Buffer.from(content.content).toString()).toContain("\n12345\n");
  });

  it("supersedes earlier evidence when the plan or the goal changes", async () => {
    const { engine, executor } = await setup();
    const first: VerificationPlan = [
      {
        id: "out",
        description: "out.txt exists",
        method: "file",
        path: "out.txt",
        expect: "exists",
      },
    ];
    const { task } = await planned(
      engine,
      coordinator(["echo one > out.txt"]),
      executor,
      first,
    );
    const done = await untilTask(engine, task.id, status("completed"));
    expect(isVerified(done.task, summaryOf(done))).toBe(true);

    // Repeating the same plan changes nothing.
    await engine.tasks.postMessage(task.id, {
      text: "Same checks, one more look",
      verificationPlan: first,
      observedGoalVersion: 1,
    });
    const same = await untilTask(engine, task.id, status("completed"));
    expect(same.task.goalVersion).toBe(1);

    // A new plan alone starts version 2: the version 1 pass no longer counts.
    const second: VerificationPlan = [
      ...first,
      {
        id: "two",
        description: "out.txt says two",
        method: "file",
        path: "out.txt",
        expect: "contains",
        value: "two",
      },
    ];
    await engine.tasks.postMessage(task.id, {
      text: "Also check that it says two",
      verificationPlan: second,
      observedGoalVersion: 1,
    });
    const reopened = await engine.tasks.get(task.id);
    expect(reopened.task).toMatchObject({
      goal: "Write out.txt",
      goalVersion: 2,
      verificationPlan: second,
    });
    expect(
      reopened.events
        .filter((event) => event.type === "task.goal_changed")
        .at(-1)?.payload,
    ).toEqual({
      goal: "Write out.txt",
      goalVersion: 2,
      verificationPlan: second,
    });
    expect(summaryOf(reopened)).toMatchObject({
      state: "pending",
      goalVersion: 2,
      attempt: null,
    });
    expect(isVerified(reopened.task, summaryOf(reopened))).toBe(false);
    // Version 1 evidence stays on record, tagged with its version.
    expect(
      reopened.verificationChecks.map((check) => check.goalVersion),
    ).toEqual([1]);

    const v2 = await untilTask(
      engine,
      task.id,
      (view) =>
        view.task.status !== "running" &&
        view.verificationChecks.some((check) => check.goalVersion === 2),
    );
    // out.txt says "one": version 2 fails its new criterion.
    expect(v2.task.status).toBe("waiting");
    expect(summaryOf(v2)).toMatchObject({
      state: "failed",
      goalVersion: 2,
      passed: 1,
      failed: 1,
    });

    // A goal change keeps the plan and starts version 3 with no evidence.
    await engine.tasks.postMessage(task.id, {
      text: "Write two",
      goal: "Write two to out.txt",
      observedGoalVersion: 2,
    });
    const v3 = await engine.tasks.get(task.id);
    expect(v3.task).toMatchObject({ goalVersion: 3, verificationPlan: second });
    expect(summaryOf(v3)?.state).toBe("pending");

    // Removing the plan is a new version too, and completes without checks.
    await until(
      async () => (await engine.tasks.get(task.id)).task.status !== "running",
    );
    await engine.tasks.postMessage(task.id, {
      text: "Drop the checks",
      verificationPlan: null,
      observedGoalVersion: 3,
    });
    const v4 = await untilTask(engine, task.id, status("completed"));
    expect(v4.task).toMatchObject({ goalVersion: 4, verificationPlan: null });
    expect(summaryOf(v4)).toBeUndefined();
    expect(isVerified(v4.task, summaryOf(v4))).toBe(false);
  });

  it("never completes a request the gate did not pass, wherever it came from", async () => {
    const { engine, executor } = await setup();
    const team = await createTeam(engine, ["Ada"]);
    const [ada] = team.names as [string];
    executor.brain(ada, (view) =>
      said.turns(view) === 0
        ? {
            calls: [
              { name: "complete_task", args: { result: "forged" } },
              { name: "gate", args: { name: "forge" } },
            ],
          }
        : { text: "Done." },
    );
    const { task } = await engine.tasks.create({
      goal: "Forge a completion",
      coordinatorBotId: team.byName[ada] as string,
      verificationPlan: [
        {
          id: "never",
          description: "Never checked",
          method: "command",
          command: "false",
        },
      ],
    });
    await executor.gate("forge").reached;
    // A request that claims a passing attempt nobody ran.
    await db.database.db
      .update(sessions)
      .set({
        completionRequested: {
          result: "forged",
          goalVersion: 1,
          verification: { attempt: 1 },
        },
      })
      .where(
        and(eq(sessions.taskId, task.id), isNull(sessions.parentSessionId)),
      );
    executor.gate("forge").open();
    const view = await untilTask(engine, task.id, status("waiting"));
    expect(view.task.result).toBeNull();
    expect(view.events.some((event) => event.type === "task.finished")).toBe(
      false,
    );
    expect(view.messages.at(-1)).toMatchObject({
      authorKind: "system",
      text: "Not completed: the verification checks have not all passed for goal version 1.",
    });
  });

  it("re-runs the gate after a crash in the middle of it", async () => {
    const root = await mkdtemp(join(tmpdir(), "jj-gate-"));
    try {
      const first = await setup({
        workspaceRoot: root,
        config: { leaseMs: 1_000 },
      });
      const brain = coordinator([]);
      const { task, ada } = await planned(first.engine, brain, first.executor, [
        {
          id: "second",
          description: "Passes on the second worker",
          method: "command",
          command:
            "if [ -f crashed ]; then exit 0; fi; touch crashed; sleep 30",
        },
      ]);
      await untilTask(
        first.engine,
        task.id,
        (view) =>
          view.events.some((event) => event.type === "verification.started"),
        "the gate",
      );
      // The check's command is running: it left its marker.
      await until(() =>
        stat(join(root, "task", task.id, "crashed")).then(
          () => true,
          () => false,
        ),
      );
      await first.engine.worker.abandon();
      const second = await setup({
        workspaceRoot: root,
        config: { leaseMs: 1_000 },
      });
      second.executor.brain(ada, brain);
      const view = await untilTask(
        second.engine,
        task.id,
        status("completed"),
        "the recovered task",
        20_000,
      );
      expect(isVerified(view.task, summaryOf(view))).toBe(true);
      const page = await second.engine.tasks.events(task.id);
      expect(
        page.events.filter((event) => event.type === "verification.started"),
      ).toHaveLength(2);
      expect(view.verificationChecks).toMatchObject([
        { attempt: 1, outcome: "passed", exitCode: 0 },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});
