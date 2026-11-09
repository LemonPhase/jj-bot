import { describe, expect, it } from "vitest";
import {
  type Approval,
  activityFromEvent,
  applyTaskEvent,
  approvalRuleMatches,
  approvalSubject,
  createRuntimeProfileCommandSchema,
  decideApprovalCommandSchema,
  describeApprovalRule,
  emptyUsage,
  hasInvisible,
  matchingApprovalRule,
  parseTaskEvent,
  runtimeProfileSchema,
  shownInFull,
  type TaskView,
  taskSummarySchema,
  taskViewSchema,
  updateRuntimeProfileCommandSchema,
  visibleText,
} from "./index";

const at = "2026-11-03T10:00:00.000Z";

const approval: Approval = {
  kind: "tool",
  id: "ap1",
  taskId: "t1",
  sessionId: "s1",
  runId: "r1",
  botId: "b1",
  toolCallId: "call-1",
  tool: "bash",
  summary: "git push origin main",
  args: { command: "git push origin main" },
  rule: { tool: "bash", match: "git push" },
  text: "",
  goalVersion: 1,
  status: "pending",
  reason: null,
  outcome: null,
  createdAt: at,
  decidedAt: null,
  startedAt: null,
};

const task = {
  id: "t1",
  title: "Ship",
  goal: "Ship",
  goalVersion: 1,
  coordinatorBotId: "b1",
  participantBotIds: ["b1"],
  status: "running" as const,
  result: null,
  error: null,
  cancelReason: null,
  cancelRequestedAt: null,
  spendCapUsd: 5,
  approveSpendPastThreshold: false,
  templateId: null,
  verificationPlan: null,
  createdAt: at,
  updatedAt: at,
  finishedAt: null,
};

const event = (sequence: number, type: string, payload: object) =>
  parseTaskEvent({
    id: `e${sequence}`,
    taskId: "t1",
    sequence,
    occurredAt: at,
    botId: "b1",
    sessionId: "s1",
    runId: "r1",
    causedBy: null,
    type,
    payload,
  });

describe("approval rules", () => {
  const bash = (command: string) => ({ command });

  it.each([
    ["git push", "git push origin main", true],
    ["git push", "cd repo && git push", true],
    ["git push", "sh -c 'git   push --force'", true],
    ["git push", "git pull", false],
    // Parts never overlap: the space after `git` is not the one before `push`.
    ["git * push", "git push", false],
    ["git * push", "git  -C repo push", true],
    ["git push", "GIT PUSH", false],
    ["git*push", "git -C repo push", true],
    ["git*push", "git status; echo push", true],
    ["gh pr create", "gh pr list", false],
    ["*", "anything", true],
    ["rm -rf /", "rm -rf /tmp/x", true],
    ["a.b", "axb", false],
  ])("match %j against %j: %s", (match, command, expected) => {
    expect(
      approvalRuleMatches({ tool: "bash", match }, "bash", bash(command)),
    ).toBe(expected);
  });

  it("stays fast on long commands that do not match (no backtracking)", () => {
    const heredoc = `cat > notes.md <<'EOF'\n${"git pull and merge\n".repeat(700)}EOF`;
    const repeated = "a".repeat(3_000);
    const started = performance.now();
    expect(
      approvalRuleMatches(
        { tool: "bash", match: "*git*push*" },
        "bash",
        bash(heredoc),
      ),
    ).toBe(false);
    expect(
      approvalRuleMatches(
        { tool: "bash", match: "a*a*a*b" },
        "bash",
        bash(repeated),
      ),
    ).toBe(false);
    expect(
      approvalRuleMatches(
        { tool: "bash", match: "a*a*a*a" },
        "bash",
        bash(repeated),
      ),
    ).toBe(true);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("collapses a long command once, however many rules it checks", () => {
    const command = "x ".repeat(512 * 1024);
    const rules = Array.from({ length: 50 }, (_, index) => ({
      tool: "bash" as const,
      match: `rule${index}*push`,
    }));
    const started = performance.now();
    expect(matchingApprovalRule(rules, "bash", bash(command))).toBe(undefined);
    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it("matches every call of its tool without a match, and no other tool", () => {
    expect(approvalRuleMatches({ tool: "write" }, "write", { path: "a" })).toBe(
      true,
    );
    expect(approvalRuleMatches({ tool: "write" }, "edit", { path: "a" })).toBe(
      false,
    );
    expect(
      approvalRuleMatches({ tool: "bash", match: "push" }, "delegate", {
        command: "push",
      }),
    ).toBe(false);
  });

  it("looks in the command, the path, or a search's pattern and path", () => {
    expect(approvalSubject("bash", { command: "ls" })).toBe("ls");
    expect(approvalSubject("write", { path: ".github/ci.yml" })).toBe(
      ".github/ci.yml",
    );
    expect(approvalSubject("grep", { pattern: "TODO", path: "src" })).toBe(
      "TODO src",
    );
    expect(approvalSubject("find", { pattern: "*.ts" })).toBe("*.ts");
    expect(approvalSubject("bash", {})).toBe("");
    expect(
      approvalRuleMatches({ tool: "write", match: ".github/" }, "write", {
        path: ".github/workflows/ci.yml",
      }),
    ).toBe(true);
  });

  it("picks the first rule that matches and describes it", () => {
    const rules = [
      { tool: "bash" as const, match: "npm publish" },
      { tool: "bash" as const, match: "git push" },
      { tool: "write" as const },
    ];
    expect(
      matchingApprovalRule(rules, "bash", { command: "git push -f" }),
    ).toEqual(rules[1]);
    expect(matchingApprovalRule(rules, "bash", { command: "ls" })).toBe(
      undefined,
    );
    expect(describeApprovalRule(rules[1] as (typeof rules)[1])).toBe(
      "bash calls matching `git push`",
    );
    expect(describeApprovalRule({ tool: "write" })).toBe("every write call");
  });

  it("has no rules by default, and validates the ones it gets", () => {
    const profile = runtimeProfileSchema.parse({
      id: "p1",
      name: "Docker",
      sandbox: { driver: "docker" },
      budgets: {},
      isDefault: true,
      status: { driverAvailable: true, isolated: true },
      createdAt: at,
      updatedAt: at,
    });
    expect(profile.approvals).toEqual([]);
    expect(
      createRuntimeProfileCommandSchema.safeParse({
        name: "x",
        sandbox: { driver: "local" },
        approvals: [{ tool: "delegate" }],
      }).success,
    ).toBe(false);
    expect(
      updateRuntimeProfileCommandSchema.safeParse({
        approvals: [{ tool: "bash", match: "  " }],
      }).success,
    ).toBe(false);
    expect(
      updateRuntimeProfileCommandSchema.parse({
        approvals: [{ tool: "bash", match: " git push " }],
      }).approvals,
    ).toEqual([{ tool: "bash", match: "git push" }]);
  });
});

describe("calls a reader cannot fully see", () => {
  const pending = (command: string) => ({
    tool: "bash",
    args: { command },
    summary: command,
  });

  it("are never shown in full, and show each hidden character", () => {
    for (const hidden of [
      "\u202E", // right-to-left override
      "\u2066", // left-to-right isolate
      "\u200B", // zero-width space
      "\u00AD", // soft hyphen
      "\u0007", // bell
      "\u001B", // escape
      "\uFEFF", // byte order mark
      "\u{E0041}", // tag letter A
    ]) {
      const command = `echo safe ${hidden}# git push`;
      expect(hasInvisible(command)).toBe(true);
      expect(shownInFull(pending(command))).toBe(false);
      expect(visibleText(command)).not.toContain(hidden);
    }
    expect(visibleText("ls \u202Etxt.exe")).toBe("ls ⟨U+202E⟩txt.exe");
    expect(visibleText("a\u{E0041}b")).toBe("a⟨U+E0041⟩b");
    // Tabs and newlines are visible, and plain text is left as it is.
    expect(visibleText("a\tb\nc")).toBe("a\tb\nc");
    expect(shownInFull(pending("git push origin main"))).toBe(true);
  });
});

describe("approval decisions", () => {
  it("takes a reason only with a denial, and drops a blank one", () => {
    expect(
      decideApprovalCommandSchema.parse({ decision: "deny", reason: " no " }),
    ).toEqual({ decision: "deny", reason: "no" });
    expect(
      decideApprovalCommandSchema.parse({ decision: "deny", reason: "  " }),
    ).toEqual({ decision: "deny" });
    expect(
      decideApprovalCommandSchema.safeParse({
        decision: "approve",
        reason: "fine",
      }).success,
    ).toBe(false);
    expect(
      decideApprovalCommandSchema.safeParse({ decision: "maybe" }).success,
    ).toBe(false);
  });
});

describe("approvals in task views", () => {
  const view: TaskView = {
    task,
    sessions: [],
    messages: [],
    artifacts: [],
    approvals: [],
    verificationChecks: [],
    usage: { total: emptyUsage(), bySession: {} },
    events: [],
    firstSequence: 1,
    hasEarlier: false,
    cursor: 0,
    compactedThrough: 0,
  };

  it("folds a request and its updates onto the view", () => {
    let next = applyTaskEvent(
      view,
      event(1, "approval.requested", { approval }),
    );
    expect(next.approvals).toEqual([approval]);
    const approved = { ...approval, status: "approved", decidedAt: at };
    next = applyTaskEvent(
      next,
      event(2, "approval.updated", {
        approval: approved,
        previousStatus: "pending",
      }),
    );
    expect(next.approvals).toEqual([approved]);
    expect(next.cursor).toBe(2);
  });

  it("says a session waits for the user's approval", () => {
    const parsed = event(3, "session.updated", {
      session: {
        id: "s1",
        taskId: "t1",
        botId: "b1",
        parentSessionId: null,
        role: "coordinator",
        brief: "",
        goalVersion: 1,
        depth: 0,
        status: "waiting",
        waitingFor: "approval",
        result: null,
        error: null,
        activity: null,
        runCount: 1,
        createdAt: at,
        updatedAt: at,
        startedAt: at,
        finishedAt: null,
      },
      previousStatus: "running",
    });
    if ("unknown" in parsed) throw new Error("known event expected");
    expect(activityFromEvent(parsed)?.text).toBe("Waiting for your approval");
  });

  it("parses views and summaries from servers before approvals", () => {
    const { approvals: _approvals, ...older } = view;
    expect(taskViewSchema.parse(older).approvals).toEqual([]);
    const summary = taskSummarySchema.parse({
      ...task,
      activeSessionCount: 0,
      sessionCount: 0,
      usage: emptyUsage(),
    });
    expect(summary.pendingApprovals).toEqual([]);
  });
});
