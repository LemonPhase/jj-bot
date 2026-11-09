// @vitest-environment jsdom
import "../../test/dom";
import {
  emptyUsage,
  pendingApprovalOf,
  type SpendApproval,
  type TaskView,
} from "@jj/contracts";
import {
  configure,
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
import { DEMO_DRIVERS } from "../../api/demoFixtures";
import { useWorkspace, WorkspaceProvider } from "../../state/WorkspaceContext";
import { TestShell } from "../../test/shell";
import { InlineTaskCard } from "../bots/InlineTaskCard";
import { ProfileEditor } from "../settings/ProfileEditor";
import { ApprovalCard } from "./ApprovalCard";
import { approvalState, coordinatorHolds, pendingLabel } from "./approvals";
import { NewTaskDialog } from "./NewTaskDialog";
import { SpendControl } from "./SpendControl";
import { TaskHeader } from "./TaskHeader";

configure({ asyncUtilTimeout: 5000 });

const at = "2026-11-09T12:00:00.000Z";

const spend = (patch: Partial<SpendApproval> = {}): SpendApproval => ({
  kind: "spend",
  id: "ap-spend",
  taskId: "task-1",
  sessionId: "s-1",
  runId: "r-1",
  botId: "bot-1",
  scope: "task",
  spentUsd: 4.02,
  capUsd: 5,
  thresholdUsd: 4,
  status: "pending",
  reason: null,
  createdAt: at,
  decidedAt: null,
  ...patch,
});

function view(
  approvals: TaskView["approvals"] = [spend()],
  task: Partial<TaskView["task"]> = {},
): TaskView {
  return {
    task: {
      id: "task-1",
      title: "Count",
      goal: "Count.",
      goalVersion: 1,
      coordinatorBotId: "bot-1",
      participantBotIds: ["bot-1"],
      status: "waiting",
      result: null,
      error: null,
      cancelReason: null,
      cancelRequestedAt: null,
      verificationPlan: null,
      spendCapUsd: 5,
      approveSpendPastThreshold: true,
      templateId: null,
      createdAt: at,
      updatedAt: at,
      finishedAt: null,
      ...task,
    },
    sessions: [
      {
        id: "s-1",
        taskId: "task-1",
        botId: "bot-1",
        parentSessionId: null,
        role: "coordinator",
        brief: "Count.",
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
    ],
    messages: [],
    artifacts: [],
    approvals,
    verificationChecks: [],
    usage: {
      total: { ...emptyUsage(), modelCalls: 9, costUsd: 4.02 },
      bySession: {},
    },
    events: [],
    firstSequence: 1,
    hasEarlier: false,
    cursor: 0,
    compactedThrough: 0,
  };
}

function renderWith(node: ReactNode, api: Partial<JJApi> = {}) {
  const full: JJApi = { ...createDemoApi({ autoplay: false }), ...api };
  render(<ApiProvider api={full}>{node}</ApiProvider>);
  return full;
}

describe("a spend approval's card", () => {
  it("asks to continue up to the cap, and approves through the API", async () => {
    const decideApproval = vi.fn(async () =>
      spend({ status: "approved", decidedAt: at }),
    );
    renderWith(
      <ApprovalCard approval={spend()} bot={undefined} view={view()} />,
      {
        decideApproval,
      },
    );
    const card = screen.getByRole("article", {
      name: "Approval: spend past 80% of the task's cap",
    });
    expect(card.textContent).toContain(
      "Spent $4.02 of $5.00, past the 80% threshold. Continue up to the cap?",
    );
    expect(within(card).getByText("waiting · no model calls")).toBeTruthy();
    fireEvent.click(within(card).getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(within(card).getByText("approved")).toBeTruthy(),
    );
    expect(decideApproval).toHaveBeenCalledWith("task-1", "ap-spend", {
      decision: "approve",
    });
    expect(within(card).queryByRole("button", { name: "Deny" })).toBeNull();
  });

  it("denies, and says the task stopped", async () => {
    const decideApproval = vi.fn(async () =>
      spend({ status: "denied", decidedAt: at }),
    );
    renderWith(
      <ApprovalCard approval={spend()} bot={undefined} view={view()} />,
      {
        decideApproval,
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Deny" }));
    await waitFor(() =>
      expect(screen.getByText("denied · task stopped")).toBeTruthy(),
    );
    expect(decideApproval).toHaveBeenCalledWith("task-1", "ap-spend", {
      decision: "deny",
    });
  });

  it("raises the cap from the card, which saves only the cap", async () => {
    const updateTask = vi.fn(async () => view().task);
    renderWith(
      <ApprovalCard approval={spend()} bot={undefined} view={view()} />,
      {
        updateTask,
      },
    );
    fireEvent.click(screen.getByRole("button", { name: "Raise cap…" }));
    const dialog = await screen.findByRole("dialog", { name: "Spend cap" });
    expect(
      (
        within(dialog).getByRole("checkbox", {
          name: "Ask before spending past 80% of a cap",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    fireEvent.change(within(dialog).getByLabelText("Spend cap (USD)"), {
      target: { value: "8" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save cap" }));
    await waitFor(() =>
      expect(updateTask).toHaveBeenCalledWith("task-1", { spendCapUsd: 8 }),
    );
  });

  it("shows each state from the record alone", () => {
    const cases: [Partial<SpendApproval>, string][] = [
      [{}, "waiting · no model calls"],
      [{ status: "approved", decidedAt: at }, "approved"],
      [{ status: "denied", decidedAt: at }, "denied · task stopped"],
      [
        {
          status: "expired",
          reason:
            "the task's spend cap changed to $8.00 before the user answered.",
        },
        "expired · cap changed",
      ],
      [
        {
          status: "expired",
          reason:
            "asking before spending past 80% of the cap was turned off before the user answered.",
        },
        "expired · question turned off",
      ],
      [
        {
          status: "expired",
          reason:
            "the task reached its spend cap ($0.0512 of $0.05) before the user answered.",
        },
        "expired · cap reached",
      ],
      [{ status: "cancelled" }, "cancelled"],
    ];
    for (const [patch, text] of cases)
      expect(approvalState(spend(patch)).text).toBe(text);
  });

  it("names a bot's daily cap and offers no task cap to raise", () => {
    renderWith(
      <ApprovalCard
        approval={spend({
          scope: "bot",
          spentUsd: 16.2,
          capUsd: 20,
          thresholdUsd: 16,
        })}
        bot={undefined}
        view={view()}
      />,
    );
    expect(
      screen.getByRole("article", {
        name: "Approval: spend past 80% of Unknown bot's daily cap",
      }).textContent,
    ).toContain(
      "Unknown bot spent $16.20 of its $20.00 daily cap in the last 24 hours, past the 80% threshold.",
    );
    expect(screen.queryByRole("button", { name: "Raise cap…" })).toBeNull();
    expect(
      screen.getByText(
        "To raise Unknown bot's daily cap, edit its runtime profile.",
      ),
    ).toBeTruthy();
    // Only that bot's sessions wait: the card says so, and so does a denial.
    expect(
      screen.getByText(
        "None of Unknown bot's model calls in this task starts until you answer. Calls already running finish.",
      ),
    ).toBeTruthy();
    expect(
      approvalState(spend({ scope: "bot", status: "denied", decidedAt: at }))
        .text,
    ).toBe("denied · this bot stopped");
  });
});

describe("spend approvals in the task's status", () => {
  it("counts a spend approval as one waiting, and as holding the coordinator", () => {
    expect(pendingLabel([spend()])).toBe("1 approval waiting");
    expect(coordinatorHolds(view())).toBe(true);
    expect(coordinatorHolds(view([spend({ status: "approved" })]))).toBe(false);
    // A bot's cap holds only that bot's sessions.
    expect(
      coordinatorHolds(view([spend({ scope: "bot", botId: "bot-2" })])),
    ).toBe(false);
  });

  it("shows the header's approval count", async () => {
    renderReady(<TaskHeader view={view()} />);
    expect(await screen.findByText("1 approval waiting")).toBeTruthy();
  });

  it("offers Approve on the chat's task card from the summary", async () => {
    const base = createDemoApi({ autoplay: false });
    const task = view().task;
    const decideApproval = vi.fn(async () =>
      spend({ status: "approved", decidedAt: at }),
    );
    renderReady(<InlineTaskCard taskId={task.id} />, {
      decideApproval,
      bootstrap: async () => ({
        ...(await base.bootstrap()),
        tasks: [
          {
            ...task,
            activeSessionCount: 1,
            sessionCount: 1,
            usage: emptyUsage(),
            pendingApprovals: [pendingApprovalOf(spend())],
          },
        ],
      }),
    });
    const list = await screen.findByRole("list", {
      name: "Calls in Count waiting for your approval",
    });
    expect(list.textContent).toContain(
      "Spend past $4.00 of the task's $5.00 cap: no model call starts until you answer.",
    );
    fireEvent.click(
      within(list).getByRole("button", {
        name: "Approve: Spend past $4.00 of the task's $5.00 cap",
      }),
    );
    await waitFor(() =>
      expect(decideApproval).toHaveBeenCalledWith("task-1", "ap-spend", {
        decision: "approve",
      }),
    );
    expect(
      await within(list).findByText(
        "Approved: the task goes on up to its cap.",
      ),
    ).toBeTruthy();
  });

  it.each([
    [
      spend(),
      "Denied: the task stops at the threshold.",
      "Spend past $4.00 of the task's $5.00 cap: no model call starts until you answer.",
    ],
    [
      spend({ scope: "bot", spentUsd: 16.2, capUsd: 20, thresholdUsd: 16 }),
      "Denied: the bot's work in this task stops at the threshold.",
      "Spend past $16.00 of the bot's $20.00 daily cap: none of the bot's model calls in this task starts until you answer.",
    ],
  ])(
    "says what a denial from the chat's task card stops (%#)",
    async (approval, denied, pending) => {
      const base = createDemoApi({ autoplay: false });
      const task = view().task;
      const decideApproval = vi.fn(async () => ({
        ...approval,
        status: "denied" as const,
        decidedAt: at,
      }));
      renderReady(<InlineTaskCard taskId={task.id} />, {
        decideApproval,
        bootstrap: async () => ({
          ...(await base.bootstrap()),
          tasks: [
            {
              ...task,
              activeSessionCount: 1,
              sessionCount: 1,
              usage: emptyUsage(),
              pendingApprovals: [pendingApprovalOf(approval)],
            },
          ],
        }),
      });
      const list = await screen.findByRole("list", {
        name: "Calls in Count waiting for your approval",
      });
      expect(list.textContent).toContain(pending);
      fireEvent.click(within(list).getByRole("button", { name: /^Deny:/ }));
      expect(await within(list).findByText(denied)).toBeTruthy();
      expect(list.textContent).not.toContain("the task goes on");
    },
  );
});

function renderReady(ui: ReactNode, overrides: Partial<JJApi> = {}) {
  const api: JJApi = { ...createDemoApi({ autoplay: false }), ...overrides };
  function Ready({ children }: { children: ReactNode }) {
    const { loading } = useWorkspace();
    return loading ? null : <>{children}</>;
  }
  render(
    <ApiProvider api={api}>
      <WorkspaceProvider>
        <TestShell>
          <Ready>{ui}</Ready>
        </TestShell>
      </WorkspaceProvider>
    </ApiProvider>,
  );
  return api;
}

describe("asking before spending past 80% of a cap", () => {
  it("is a choice of the cap dialog, saved alone", async () => {
    const updateTask = vi.fn(async () => view().task);
    renderWith(
      <SpendControl view={view([], { approveSpendPastThreshold: false })} />,
      { updateTask },
    );
    fireEvent.click(screen.getByRole("button", { name: /Usage:/ }));
    const ask = await screen.findByRole("checkbox", {
      name: "Ask before spending past 80% of a cap",
    });
    expect((ask as HTMLInputElement).checked).toBe(false);
    fireEvent.click(ask);
    fireEvent.click(screen.getByRole("button", { name: "Save cap" }));
    await waitFor(() =>
      expect(updateTask).toHaveBeenCalledWith("task-1", {
        approveSpendPastThreshold: true,
      }),
    );
  });

  it("is sent with a new task only when changed from the profile's choice", async () => {
    const base = createDemoApi({ autoplay: false });
    const createTask = vi.fn(base.createTask);
    renderReady(
      <NewTaskDialog initialBotIds={["bot-juno"]} onClose={() => {}} />,
      { createTask },
    );
    fireEvent.change(await screen.findByLabelText("Goal"), {
      target: { value: "Count carefully" },
    });
    const ask = screen.getByRole("checkbox", {
      name: "Ask before spending past 80% of a cap",
    });
    expect((ask as HTMLInputElement).checked).toBe(false);
    fireEvent.click(ask);
    fireEvent.click(screen.getByRole("button", { name: "Start task" }));
    await waitFor(() =>
      expect(createTask).toHaveBeenCalledWith(
        expect.objectContaining({
          goal: "Count carefully",
          approveSpendPastThreshold: true,
        }),
      ),
    );
    expect(
      (await createTask.mock.results[0]?.value).approveSpendPastThreshold,
    ).toBe(true);
  });

  it("is a profile setting", async () => {
    const base = createDemoApi({ autoplay: false });
    const createProfile = vi.fn(base.createProfile);
    render(
      <ApiProvider api={{ ...base, createProfile }}>
        <WorkspaceProvider>
          <ProfileEditor
            profile={null}
            drivers={DEMO_DRIVERS}
            onClose={() => {}}
          />
        </WorkspaceProvider>
      </ApiProvider>,
    );
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Careful" },
    });
    fireEvent.click(
      screen.getByRole("checkbox", {
        name: "Ask before spending past 80% of a cap",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));
    await waitFor(() => expect(createProfile).toHaveBeenCalled());
    expect(createProfile.mock.calls[0]?.[0].budgets).toMatchObject({
      approveSpendPastThreshold: true,
    });
  });
});
