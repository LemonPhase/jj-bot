// Contract 1.13.0 (#106): spend approvals share the approval records, events
// and summaries with tool approvals, as a union on `kind`. What servers
// stored before it (approvals without `kind`, tasks and profiles without the
// option) still parses, as a tool approval and with the option off.
import { describe, expect, it } from "vitest";
import {
  approvalSchema,
  createTaskCommandSchema,
  createTaskTemplateCommandSchema,
  emptyUsage,
  parseTaskEvent,
  pendingApprovalOf,
  pendingApprovalSchema,
  profileBudgetsSchema,
  SPEND_EXPIRY_CAUSES,
  type SpendApproval,
  spendApprovalSummary,
  taskEventSchema,
  taskObjectSchema,
  taskSummarySchema,
  updateRuntimeProfileCommandSchema,
  updateTaskCommandSchema,
} from "./index";

const at = "2026-11-09T10:00:00.000Z";

const spend: SpendApproval = {
  kind: "spend",
  id: "appr_1",
  taskId: "task_1",
  sessionId: "sess_1",
  runId: "run_1",
  botId: "bot_1",
  scope: "task",
  spentUsd: 4.02,
  capUsd: 5,
  thresholdUsd: 4,
  status: "pending",
  reason: null,
  expiredBecause: null,
  createdAt: at,
  decidedAt: null,
};

/** An `approval.requested` event exactly as a server before 1.13 stored and streamed it. */
const storedBefore = {
  id: "evt_01",
  taskId: "task_1",
  sequence: 7,
  occurredAt: at,
  botId: "bot_1",
  sessionId: "sess_1",
  runId: "run_1",
  causedBy: null,
  type: "approval.requested",
  payload: {
    approval: {
      id: "appr_0",
      taskId: "task_1",
      sessionId: "sess_1",
      runId: "run_1",
      botId: "bot_1",
      toolCallId: "call_1",
      tool: "bash",
      summary: "git push",
      args: { command: "git push" },
      rule: { tool: "bash", match: "git push" },
      text: "",
      goalVersion: 1,
      status: "pending",
      reason: null,
      outcome: null,
      createdAt: at,
      decidedAt: null,
      startedAt: null,
    },
  },
};

describe("spend approvals (1.13.0)", () => {
  it("parses approvals stored before 1.13 as tool approvals", () => {
    const parsed = taskEventSchema.parse(storedBefore);
    expect(parsed.type).toBe("approval.requested");
    if (parsed.type !== "approval.requested") throw new Error("unreachable");
    expect(parsed.payload.approval).toMatchObject({
      kind: "tool",
      tool: "bash",
      summary: "git push",
    });
    const viaParse = parseTaskEvent(storedBefore);
    expect("unknown" in viaParse).toBe(false);
    expect(
      pendingApprovalSchema.parse({
        id: "appr_0",
        sessionId: "sess_1",
        botId: "bot_1",
        tool: "bash",
        summary: "git push",
        createdAt: at,
      }),
    ).toMatchObject({ kind: "tool", shownInFull: false });
  });

  it("parses a spend approval, and refuses one without its amounts", () => {
    expect(approvalSchema.parse(spend)).toEqual(spend);
    const { capUsd: _cap, ...partial } = spend;
    expect(approvalSchema.safeParse(partial).success).toBe(false);
    expect(
      approvalSchema.safeParse({ ...spend, scope: "instance" }).success,
    ).toBe(false);
    // Why one expired is a value the contract lists.
    for (const cause of SPEND_EXPIRY_CAUSES)
      expect(
        approvalSchema.parse({
          ...spend,
          status: "expired",
          expiredBecause: cause,
        }),
      ).toMatchObject({ expiredBecause: cause });
    expect(
      approvalSchema.safeParse({
        ...spend,
        status: "expired",
        expiredBecause: "reached",
      }).success,
    ).toBe(false);
    // A tool record cannot pass as a spend one, nor the reverse.
    expect(
      approvalSchema.safeParse({
        ...storedBefore.payload.approval,
        kind: "spend",
      }).success,
    ).toBe(false);
  });

  it("summarises a pending spend approval in full", () => {
    expect(spendApprovalSummary(spend)).toBe(
      "Spend past $4.00 of the task's $5.00 cap",
    );
    expect(
      spendApprovalSummary({ scope: "bot", thresholdUsd: 16, capUsd: 20 }),
    ).toBe("Spend past $16.00 of the bot's $20.00 daily cap");
    const pending = pendingApprovalOf(spend);
    expect(pending).toEqual({
      kind: "spend",
      id: "appr_1",
      sessionId: "sess_1",
      botId: "bot_1",
      scope: "task",
      spentUsd: 4.02,
      capUsd: 5,
      thresholdUsd: 4,
      summary: "Spend past $4.00 of the task's $5.00 cap",
      createdAt: at,
      shownInFull: true,
    });
    expect(pendingApprovalSchema.parse(pending)).toEqual(pending);
  });

  it("defaults the option off where it is missing, and keeps it when a patch omits it", () => {
    expect(profileBudgetsSchema.parse({}).approveSpendPastThreshold).toBe(
      false,
    );
    expect(
      updateRuntimeProfileCommandSchema.parse({
        budgets: { maxUsdPerTask: 2 },
      }).budgets,
    ).toEqual({ maxUsdPerTask: 2 });
    expect(
      updateRuntimeProfileCommandSchema.parse({
        budgets: { approveSpendPastThreshold: true },
      }).budgets,
    ).toEqual({ approveSpendPastThreshold: true });
    const task = {
      id: "task_1",
      title: "Ship",
      goal: "Ship it",
      goalVersion: 1,
      coordinatorBotId: "bot_1",
      participantBotIds: ["bot_1"],
      status: "running",
      result: null,
      error: null,
      cancelReason: null,
      cancelRequestedAt: null,
      createdAt: at,
      updatedAt: at,
      finishedAt: null,
    };
    expect(taskObjectSchema.parse(task).approveSpendPastThreshold).toBe(false);
    expect(
      taskSummarySchema.parse({
        ...task,
        activeSessionCount: 1,
        sessionCount: 1,
        usage: emptyUsage(),
        pendingApprovals: [pendingApprovalOf(spend)],
      }).pendingApprovals[0]?.kind,
    ).toBe("spend");
    expect(
      createTaskCommandSchema.parse({ goal: "Go", coordinatorBotId: "bot_1" })
        .approveSpendPastThreshold,
    ).toBeUndefined();
    expect(
      updateTaskCommandSchema.parse({ approveSpendPastThreshold: false }),
    ).toEqual({ approveSpendPastThreshold: false });
    // Templates do not carry it: a task started from one takes the profile's.
    expect(
      createTaskTemplateCommandSchema.parse({
        title: "T",
        goal: "Go",
        coordinatorBotId: "bot_1",
        approveSpendPastThreshold: true,
      }),
    ).not.toHaveProperty("approveSpendPastThreshold");
  });
});
