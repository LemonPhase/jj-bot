// @vitest-environment jsdom
import "../../test/dom";
import {
  type Approval,
  emptyUsage,
  pendingApprovalOf,
  type TaskView,
} from "@jj/contracts";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { ApiProvider } from "../../api/ApiContext";
import type { JJApi } from "../../api/client";
import { createDemoApi } from "../../api/demoApi";
import { useWorkspace, WorkspaceProvider } from "../../state/WorkspaceContext";
import { InlineTaskCard } from "../bots/InlineTaskCard";
import { ApprovalCard } from "./ApprovalCard";
import {
  approvalCall,
  approvalState,
  coordinatorHolds,
  pendingLabel,
  pendingOf,
} from "./approvals";
import { taskTimeline } from "./taskModel";

const at = (second: number) =>
  `2026-11-03T12:00:${String(second).padStart(2, "0")}.000Z`;

const approval = (patch: Partial<Approval> = {}): Approval => ({
  id: "ap-1",
  taskId: "task-1",
  sessionId: "s-1",
  runId: "r-1",
  botId: "bot-1",
  toolCallId: "call-1",
  tool: "bash",
  summary: "git push origin main",
  args: { command: "git push origin main" },
  rule: { tool: "bash", match: "git push" },
  text: "Pushing the branch.",
  goalVersion: 1,
  status: "pending",
  reason: null,
  outcome: null,
  createdAt: at(5),
  decidedAt: null,
  startedAt: null,
  ...patch,
});

const view = (patch: Partial<TaskView> = {}): TaskView => ({
  task: {
    id: "task-1",
    title: "Ship",
    goal: "Ship",
    goalVersion: 1,
    coordinatorBotId: "bot-1",
    participantBotIds: ["bot-1"],
    status: "waiting",
    result: null,
    error: null,
    cancelReason: null,
    cancelRequestedAt: null,
    spendCapUsd: null,
    verificationPlan: null,
    createdAt: at(1),
    updatedAt: at(1),
    finishedAt: null,
  },
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
  ...patch,
});

describe("approval state", () => {
  it("never says a call ran before its outcome is stored", () => {
    const cases: [Partial<Approval>, string][] = [
      [{}, "waiting for your approval · not run"],
      [{ status: "approved", decidedAt: at(6) }, "approved · waiting to run"],
      [
        { status: "approved", decidedAt: at(6), startedAt: at(7) },
        "approved · running",
      ],
      [
        {
          status: "approved",
          startedAt: at(7),
          outcome: { ok: true, exitCode: 0, interrupted: "no" },
        },
        "ran · exit 0",
      ],
      [
        {
          status: "approved",
          startedAt: at(7),
          outcome: { ok: false, exitCode: 1, interrupted: "no" },
        },
        "ran · failed · exit 1",
      ],
      [
        {
          status: "approved",
          startedAt: at(7),
          outcome: { ok: false, interrupted: "unknown" },
        },
        "interrupted · outcome unknown",
      ],
      [
        {
          status: "approved",
          startedAt: at(7),
          outcome: { ok: false, refused: "Tool bash not found" },
        },
        "approved · not run: refused",
      ],
      [{ status: "denied", reason: "no" }, "denied · not run"],
      [{ status: "expired" }, "expired · not run"],
      [{ status: "cancelled" }, "cancelled · not run"],
    ];
    for (const [patch, text] of cases)
      expect(approvalState(approval(patch)).text).toBe(text);
  });

  it("shows the whole command, or the arguments of another tool", () => {
    expect(approvalCall(approval())).toBe("git push origin main");
    expect(
      approvalCall({ tool: "write", args: { path: "a.txt", content: "x" } }),
    ).toBe('{\n  "path": "a.txt",\n  "content": "x"\n}');
  });

  it("counts what waits, and knows when the coordinator holds one", () => {
    const list = [approval(), approval({ id: "ap-2", status: "denied" })];
    expect(pendingLabel(pendingOf(list))).toBe("1 approval waiting");
    expect(pendingLabel([])).toBeNull();
    const root = {
      id: "s-1",
      taskId: "task-1",
      botId: "bot-1",
      parentSessionId: null,
      role: "coordinator" as const,
      brief: "",
      goalVersion: 1,
      depth: 0,
      status: "waiting" as const,
      waitingFor: "approval" as const,
      result: null,
      error: null,
      activity: null,
      runCount: 1,
      createdAt: at(1),
      updatedAt: at(1),
      startedAt: at(1),
      finishedAt: null,
    };
    expect(coordinatorHolds(view({ sessions: [root], approvals: list }))).toBe(
      true,
    );
    expect(
      coordinatorHolds(
        view({ sessions: [root], approvals: [approval({ sessionId: "s-2" })] }),
      ),
    ).toBe(false);
  });

  it("places an approval where it was requested, as it is now", () => {
    const message = (id: string, sequence: number, second: number) => ({
      id,
      taskId: "task-1",
      sequence,
      authorKind: "user" as const,
      authorBotId: null,
      sessionId: null,
      intent: "steering" as const,
      text: id,
      recipientBotIds: ["bot-1"],
      createdAt: at(second),
    });
    const m1 = message("m1", 1, 2);
    const m2 = message("m2", 2, 9);
    const base = {
      taskId: "task-1",
      occurredAt: at(5),
      botId: "bot-1",
      sessionId: "s-1",
      runId: "r-1",
      causedBy: null,
    };
    const answered = approval({ status: "denied", reason: "no" });
    const timeline = taskTimeline(
      view({
        messages: [m1, m2],
        approvals: [answered],
        events: [
          {
            ...base,
            id: "e1",
            sequence: 1,
            type: "message.posted",
            payload: { message: m1 },
          },
          {
            ...base,
            id: "e2",
            sequence: 2,
            type: "approval.requested",
            payload: { approval: approval() },
          },
          {
            ...base,
            id: "e3",
            sequence: 3,
            type: "message.posted",
            payload: { message: m2 },
          },
        ],
      }),
    );
    expect(
      timeline.map((entry) =>
        entry.kind === "approval"
          ? `approval ${entry.approval.status}`
          : entry.kind === "message"
            ? entry.message.id
            : entry.text,
      ),
    ).toEqual(["m1", "approval denied", "m2"]);
    // Requested before the retained events: placed by time.
    const older = taskTimeline(
      view({ messages: [m1, m2], approvals: [approval()], events: [] }),
    );
    expect(older.map((entry) => entry.kind)).toEqual([
      "message",
      "approval",
      "message",
    ]);
  });
});

function renderCard(item: Approval, api: Partial<JJApi> = {}) {
  const full: JJApi = { ...createDemoApi({ autoplay: false }), ...api };
  render(
    <ApiProvider api={full}>
      <ApprovalCard approval={item} bot={undefined} />
    </ApiProvider>,
  );
  return full;
}

describe("ApprovalCard", () => {
  it("approves a pending call through the API and shows the server's answer", async () => {
    const decideApproval = vi.fn(async () =>
      approval({ status: "approved", decidedAt: at(6) }),
    );
    renderCard(approval(), { decideApproval });
    expect(
      screen.getByRole("article", {
        name: "Approval: Unknown bot asks to run bash",
      }),
    ).toBeTruthy();
    expect(screen.getByText("git push origin main")).toBeTruthy();
    expect(
      screen.getByText("Needs your approval: bash calls matching `git push`"),
    ).toBeTruthy();
    expect(
      screen.getByText("waiting for your approval · not run"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(screen.getByText("approved · waiting to run")).toBeTruthy(),
    );
    expect(decideApproval).toHaveBeenCalledWith("task-1", "ap-1", {
      decision: "approve",
    });
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("denies with a reason, and shows a refusal in place", async () => {
    const decideApproval = vi
      .fn()
      .mockRejectedValueOnce(
        Object.assign(new Error("The approval is expired, not pending."), {
          name: "ApiError",
        }),
      )
      .mockResolvedValueOnce(
        approval({
          status: "denied",
          reason: "use a branch",
          decidedAt: at(6),
        }),
      );
    renderCard(approval(), { decideApproval });
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "Reason for the bot (optional)" }),
      { target: { value: " use a branch " } },
    );
    fireEvent.click(screen.getByRole("button", { name: "Deny the call" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "The approval is expired, not pending.",
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Deny the call" }));
    await waitFor(() =>
      expect(screen.getByText("denied · not run")).toBeTruthy(),
    );
    expect(decideApproval).toHaveBeenLastCalledWith("task-1", "ap-1", {
      decision: "deny",
      reason: "use a branch",
    });
    expect(screen.getByText(/Your reason: use a branch/)).toBeTruthy();
  });

  it("shows a hidden character in the call as its code point", () => {
    renderCard(
      approval({
        args: { command: "echo ok \u202E# hsup tig" },
        summary: "echo ok \u202E# hsup tig",
      }),
    );
    expect(screen.getByLabelText("The bash call").textContent).toBe(
      "echo ok ⟨U+202E⟩# hsup tig",
    );
  });

  it("offers no answer once the call was answered", () => {
    renderCard(
      approval({
        status: "approved",
        startedAt: at(7),
        outcome: { ok: true, exitCode: 0, interrupted: "no" },
      }),
    );
    expect(screen.getByText("ran · exit 0")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Deny" })).toBeNull();
  });
});

describe("approvals on the chat's task card", () => {
  function renderCard(pending: TaskView["approvals"]) {
    const base = createDemoApi({ autoplay: false });
    const task = view().task;
    const api: JJApi = {
      ...base,
      bootstrap: async () => ({
        ...(await base.bootstrap()),
        tasks: [
          {
            ...task,
            activeSessionCount: 0,
            sessionCount: 1,
            usage: emptyUsage(),
            pendingApprovals: pending.map(pendingApprovalOf),
          },
        ],
      }),
    };
    function Ready({ children }: { children: ReactNode }) {
      const { loading } = useWorkspace();
      return loading ? null : <>{children}</>;
    }
    render(
      <ApiProvider api={api}>
        <WorkspaceProvider>
          <Ready>
            <InlineTaskCard taskId={task.id} />
          </Ready>
        </WorkspaceProvider>
      </ApiProvider>,
    );
  }

  it("offers Approve only for a call its summary shows in full", async () => {
    const long = `git push origin main && ${"echo step; ".repeat(40)}`;
    renderCard([
      approval(),
      approval({
        id: "ap-2",
        sessionId: "s-2",
        args: { command: long },
        summary: `${long.slice(0, 299)}…`,
      }),
    ]);
    const list = await screen.findByRole("list", {
      name: "Calls in Ship waiting for your approval",
    });
    expect(
      within(list).getByRole("button", {
        name: "Approve: git push origin main",
      }),
    ).toBeTruthy();
    // The shortened one: review it in the task, where the whole call shows.
    const review = within(list).getByRole("link", {
      name: /^Review in the task: git push origin main && echo step;/,
    });
    expect(review.getAttribute("href")).toBe("#/tasks/task-1");
    expect(
      within(list).getAllByRole("button", { name: /^Approve:/ }),
    ).toHaveLength(1);
    expect(
      within(list).getAllByRole("button", { name: /^Deny:/ }),
    ).toHaveLength(2);
    expect(list.textContent).toContain("the task shows the whole call");
  });

  it("sends a call with a hidden character to the task for approval", async () => {
    const command = "echo ok \u202E# hsup tig";
    renderCard([approval({ args: { command }, summary: command })]);
    const list = await screen.findByRole("list", {
      name: "Calls in Ship waiting for your approval",
    });
    expect(
      within(list).queryByRole("button", { name: /^Approve:/ }),
    ).toBeNull();
    expect(list.textContent).toContain("echo ok ⟨U+202E⟩# hsup tig");
    expect(
      within(list).getByRole("link", { name: /^Review in the task: / }),
    ).toBeTruthy();
  });

  it("does not show a multi-line command as whole", () => {
    const multi = approval({
      args: { command: "cat > a <<'EOF'\ngit push\nEOF" },
      summary: "cat > a <<'EOF' git push EOF",
    });
    expect(pendingApprovalOf(multi).shownInFull).toBe(false);
    expect(pendingApprovalOf(approval()).shownInFull).toBe(true);
    expect(
      pendingApprovalOf(
        approval({ tool: "write", args: { path: "a" }, summary: "a" }),
      ).shownInFull,
    ).toBe(false);
  });
});
