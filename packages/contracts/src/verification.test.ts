import { describe, expect, it } from "vitest";
import { applyTaskEvent, type ParsedTaskEvent, type TaskView } from "./events";
import {
  createTaskCommandSchema,
  postTaskMessageCommandSchema,
  type Task,
  taskSummarySchema,
} from "./tasks";
import {
  isVerified,
  latestAttemptChecks,
  type VerificationCheck,
  type VerificationPlan,
  verificationCheckSchema,
  verificationPlanSchema,
  verificationSummary,
} from "./verification";

const at = "2026-11-03T00:00:00.000Z";

const plan: VerificationPlan = [
  {
    id: "tests",
    description: "The tests pass",
    method: "command",
    command: "npm test",
  },
  {
    id: "readme",
    description: "The README names the command",
    method: "file",
    path: "README.md",
    expect: "contains",
    value: "npm start",
  },
];

const task: Task = {
  id: "t1",
  title: "Ship",
  goal: "Ship it",
  goalVersion: 2,
  coordinatorBotId: "coord",
  participantBotIds: ["coord"],
  status: "completed",
  result: "Done",
  error: null,
  cancelReason: null,
  cancelRequestedAt: null,
  verificationPlan: plan,
  spendCapUsd: null,
  createdAt: at,
  updatedAt: at,
  finishedAt: at,
};

let ids = 0;
const check = (
  fields: Partial<VerificationCheck> &
    Pick<VerificationCheck, "criterionId" | "outcome">,
): VerificationCheck => ({
  id: `c${++ids}`,
  taskId: "t1",
  goalVersion: 2,
  attempt: 1,
  method: "command",
  exitCode: fields.outcome === "passed" ? 0 : 1,
  interrupted: "no",
  durationMs: 10,
  detail: "observed",
  output: null,
  truncated: false,
  artifactId: null,
  sessionId: "s0",
  runId: "r1",
  startedAt: at,
  finishedAt: at,
  ...fields,
});

describe("verification plans", () => {
  it("accepts each method and refuses malformed criteria", () => {
    expect(
      verificationPlanSchema.parse([
        ...plan,
        {
          id: "json",
          description: "The report is valid",
          method: "file",
          path: "out/report.json",
          expect: "json",
          schema: {
            type: "object",
            properties: { total: { type: "number" } },
            required: ["total"],
          },
        },
        {
          id: "summary",
          description: "The result names the port",
          method: "result",
          expect: "matches",
          value: "port \\d+",
          flags: "i",
        },
        {
          id: "exists",
          description: "The build exists",
          method: "file",
          path: "dist/index.js",
          expect: "exists",
        },
      ]),
    ).toHaveLength(5);
    const refused = (criterion: unknown) =>
      verificationPlanSchema.safeParse([criterion]).success;
    const base = { id: "c", description: "d" };
    expect(refused({ ...base, method: "command", command: " " })).toBe(false);
    expect(refused({ ...base, method: "command", command: "x" })).toBe(true);
    expect(
      refused({
        ...base,
        method: "file",
        path: "../etc/passwd",
        expect: "exists",
      }),
    ).toBe(false);
    expect(
      refused({
        ...base,
        method: "file",
        path: "/etc/passwd",
        expect: "exists",
      }),
    ).toBe(false);
    expect(
      refused({ ...base, method: "file", path: "a.txt", expect: "contains" }),
    ).toBe(false);
    expect(
      refused({
        ...base,
        method: "file",
        path: "a.txt",
        expect: "exists",
        value: "x",
      }),
    ).toBe(false);
    expect(
      refused({ ...base, method: "result", expect: "matches", value: "(" }),
    ).toBe(false);
    expect(
      refused({
        ...base,
        method: "result",
        expect: "contains",
        value: "x",
        schema: { type: "object" },
      }),
    ).toBe(false);
    expect(refused({ ...base, method: "review", rubric: "good" })).toBe(false);
    expect(
      refused({ ...base, id: "has space", method: "command", command: "x" }),
    ).toBe(false);
    // Ids are unique within a plan; a plan has 1 to 20 criteria.
    expect(verificationPlanSchema.safeParse([plan[0], plan[0]]).success).toBe(
      false,
    );
    expect(verificationPlanSchema.safeParse([]).success).toBe(false);
    expect(
      verificationPlanSchema.safeParse(
        Array.from({ length: 21 }, (_, index) => ({
          ...base,
          id: `c${index}`,
          method: "command",
          command: "true",
        })),
      ).success,
    ).toBe(false);
  });

  it("travels with task creation and with a message that observed the goal version", () => {
    expect(
      createTaskCommandSchema.parse({
        goal: "Ship",
        coordinatorBotId: "coord",
        verificationPlan: plan,
      }).verificationPlan,
    ).toEqual(plan);
    expect(
      postTaskMessageCommandSchema.safeParse({
        text: "Check the README too",
        verificationPlan: plan,
      }).success,
    ).toBe(false);
    expect(
      postTaskMessageCommandSchema.safeParse({
        text: "Drop the checks",
        verificationPlan: null,
        observedGoalVersion: 2,
      }).success,
    ).toBe(true);
  });

  it("lets a command check pass only on exit code 0 with no interruption", () => {
    expect(
      verificationCheckSchema.safeParse(
        check({ criterionId: "tests", outcome: "passed" }),
      ).success,
    ).toBe(true);
    expect(
      verificationCheckSchema.safeParse(
        check({ criterionId: "tests", outcome: "passed", exitCode: 1 }),
      ).success,
    ).toBe(false);
    expect(
      verificationCheckSchema.safeParse(
        check({
          criterionId: "tests",
          outcome: "passed",
          exitCode: 0,
          interrupted: "unknown",
        }),
      ).success,
    ).toBe(false);
    // A check carries what it observed.
    expect(
      verificationCheckSchema.safeParse(
        check({ criterionId: "tests", outcome: "passed", detail: "" }),
      ).success,
    ).toBe(false);
  });
});

describe("verificationSummary and isVerified", () => {
  const passedBoth = [
    check({ criterionId: "tests", outcome: "passed" }),
    check({ criterionId: "readme", outcome: "passed", method: "file" }),
  ];

  it("is verified only when completed and every criterion passed at the current version's latest attempt", () => {
    const summary = verificationSummary(task, passedBoth);
    expect(summary).toMatchObject({
      state: "passed",
      goalVersion: 2,
      attempt: 1,
      passed: 2,
      total: 2,
    });
    expect(isVerified(task, summary)).toBe(true);
    // Not while it runs, waits or failed, whatever the checks say.
    for (const status of ["running", "waiting", "failed", "queued"] as const)
      expect(isVerified({ ...task, status }, summary)).toBe(false);
  });

  it("never passes with a missing, failed, inconclusive or superseded criterion", () => {
    const only = [check({ criterionId: "tests", outcome: "passed" })];
    expect(verificationSummary(task, only)?.state).toBe("pending");
    expect(isVerified(task, verificationSummary(task, only))).toBe(false);

    const failed = [
      check({ criterionId: "tests", outcome: "failed" }),
      check({ criterionId: "readme", outcome: "passed" }),
    ];
    expect(verificationSummary(task, failed)).toMatchObject({
      state: "failed",
      passed: 1,
      failed: 1,
    });
    const inconclusive = [
      check({ criterionId: "tests", outcome: "inconclusive" }),
      check({ criterionId: "readme", outcome: "passed" }),
    ];
    expect(verificationSummary(task, inconclusive)?.state).toBe("inconclusive");

    // Evidence of an older goal version is superseded.
    const older = passedBoth.map((item) => ({ ...item, goalVersion: 1 }));
    expect(verificationSummary(task, older)).toMatchObject({
      state: "pending",
      attempt: null,
      passed: 0,
    });
    expect(isVerified(task, verificationSummary(task, older))).toBe(false);

    // A later attempt supersedes an earlier pass, even before it finishes.
    const retried = [
      ...passedBoth,
      check({ criterionId: "tests", outcome: "failed", attempt: 2 }),
    ];
    expect(verificationSummary(task, retried)).toMatchObject({
      state: "failed",
      attempt: 2,
      passed: 0,
    });
    expect(latestAttemptChecks(retried, 2)).toHaveLength(1);

    // A summary from another goal version never verifies.
    const stale = verificationSummary({ ...task, goalVersion: 1 }, older);
    expect(isVerified(task, stale)).toBe(false);
    // No plan, no summary, never verified.
    const unplanned = { ...task, verificationPlan: null };
    expect(verificationSummary(unplanned, passedBoth)).toBeUndefined();
    expect(isVerified(unplanned, undefined)).toBe(false);
  });

  it("is in a task summary exactly when the task has a plan", () => {
    const usage = {
      modelCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      unpricedCalls: 0,
    };
    const summary = {
      ...task,
      activeSessionCount: 0,
      sessionCount: 1,
      usage,
      verification: verificationSummary(task, passedBoth),
    };
    expect(taskSummarySchema.safeParse(summary).success).toBe(true);
    expect(
      taskSummarySchema.safeParse({ ...summary, verification: undefined })
        .success,
    ).toBe(false);
    expect(
      taskSummarySchema.safeParse({ ...summary, verificationPlan: null })
        .success,
    ).toBe(false);
  });
});

describe("applyTaskEvent and verification checks", () => {
  const view: TaskView = {
    task,
    sessions: [],
    messages: [],
    artifacts: [],
    verificationChecks: [],
    usage: {
      total: {
        modelCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        unpricedCalls: 0,
      },
      bySession: {},
    },
    events: [],
    firstSequence: 1,
    hasEarlier: false,
    cursor: 0,
  };
  let sequence = 0;
  const checked = (item: VerificationCheck): ParsedTaskEvent => ({
    id: `e${++sequence}`,
    taskId: "t1",
    sequence,
    occurredAt: at,
    botId: "coord",
    sessionId: "s0",
    runId: "r1",
    causedBy: null,
    type: "verification.checked",
    payload: { check: item },
  });

  it("keeps the latest attempt of each goal version, as the snapshot does", () => {
    const v1 = check({
      criterionId: "tests",
      outcome: "passed",
      goalVersion: 1,
    });
    const a1 = check({ criterionId: "tests", outcome: "failed" });
    const a1b = check({ criterionId: "readme", outcome: "passed" });
    const a2 = check({ criterionId: "tests", outcome: "passed", attempt: 2 });
    const folded = [v1, a1, a1b, a2].map(checked).reduce(applyTaskEvent, view);
    expect(folded.verificationChecks.map((item) => item.id)).toEqual([
      v1.id,
      a2.id,
    ]);
    expect(folded.cursor).toBe(sequence);
  });
});
