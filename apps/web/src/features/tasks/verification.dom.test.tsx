// @vitest-environment jsdom
import "../../test/dom";
import {
  emptyUsage,
  type TaskSummary,
  type TaskView,
  type VerificationCheck,
  type VerificationPlan,
  verificationSummary,
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
import { useWorkspace, WorkspaceProvider } from "../../state/WorkspaceContext";
import { InlineTaskCard } from "../bots/InlineTaskCard";
import { NewTaskDialog } from "./NewTaskDialog";
import { TaskHeader } from "./TaskHeader";
import { VerificationSection } from "./VerificationSection";

configure({ asyncUtilTimeout: 5000 });

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
    description: "The README names the start command",
    method: "file",
    path: "README.md",
    expect: "contains",
    value: "npm start",
  },
];

let ids = 0;
const check = (
  fields: Partial<VerificationCheck> &
    Pick<VerificationCheck, "criterionId" | "outcome">,
): VerificationCheck => ({
  id: `chk-${++ids}`,
  taskId: "task-v",
  goalVersion: 2,
  attempt: 1,
  method: "command",
  exitCode: fields.outcome === "passed" ? 0 : 1,
  interrupted: "no",
  durationMs: 4200,
  detail:
    fields.outcome === "passed" ? "Exited with code 0." : "Exited with code 1.",
  output: "1 passing\n",
  truncated: false,
  artifactId: null,
  sessionId: null,
  runId: null,
  startedAt: at,
  finishedAt: at,
  ...fields,
});

function viewOf(
  status: TaskView["task"]["status"],
  checks: VerificationCheck[],
  taskPlan: VerificationPlan | null = plan,
): TaskView {
  return {
    task: {
      id: "task-v",
      title: "Ship the release",
      goal: "Ship the release",
      goalVersion: 2,
      coordinatorBotId: "bot-juno",
      participantBotIds: ["bot-juno"],
      status,
      result: status === "completed" ? "Shipped." : null,
      error: null,
      cancelReason: null,
      cancelRequestedAt: null,
      verificationPlan: taskPlan,
      spendCapUsd: null,
      createdAt: at,
      updatedAt: at,
      finishedAt: status === "completed" ? at : null,
    },
    sessions: [],
    messages: [],
    artifacts: [],
    verificationChecks: checks,
    usage: { total: emptyUsage(), bySession: {} },
    events: [],
    firstSequence: 1,
    hasEarlier: false,
    cursor: 0,
  };
}

const passedBoth = () => [
  check({ criterionId: "tests", outcome: "passed" }),
  check({
    criterionId: "readme",
    outcome: "passed",
    method: "file",
    exitCode: null,
    interrupted: null,
  }),
];

/** Renders once the workspace has loaded over the demo API, with verification reported as enforced. */
function renderReady(
  ui: ReactNode,
  overrides: Partial<JJApi> = {},
  verification = true,
) {
  const base = createDemoApi({ autoplay: false });
  const capabilities = { ...base.capabilities, verification };
  const api: JJApi = { ...base, capabilities, ...overrides };
  function Ready({ children }: { children: ReactNode }) {
    const { loading } = useWorkspace();
    return loading ? null : <>{children}</>;
  }
  render(
    <ApiProvider api={api}>
      <WorkspaceProvider>
        <Ready>{ui}</Ready>
      </WorkspaceProvider>
    </ApiProvider>,
  );
  return api;
}

const badge = () => screen.findByText(/^Verification:/);

describe("verification display", () => {
  it("shows verified only when the task completed with every check passed for its goal version", async () => {
    renderReady(<TaskHeader view={viewOf("completed", passedBoth())} />);
    expect((await badge()).parentElement?.textContent).toBe(
      "Verification: verified · 2/2",
    );
  });

  it("never shows a failed, inconclusive, running or superseded task as verified", async () => {
    const cases: [TaskView, string][] = [
      [
        viewOf("completed", [
          check({ criterionId: "tests", outcome: "failed" }),
          check({ criterionId: "readme", outcome: "passed" }),
        ]),
        "failed · 1/2",
      ],
      [
        viewOf("waiting", [
          check({
            criterionId: "tests",
            outcome: "inconclusive",
            exitCode: null,
            interrupted: "unknown",
          }),
          check({ criterionId: "readme", outcome: "passed" }),
        ]),
        "inconclusive · 1/2",
      ],
      // Every check passed, but the task is still running: not verified.
      [viewOf("running", passedBoth()), "passed · 2/2"],
      // Evidence of goal v1 does not count for v2.
      [
        viewOf(
          "completed",
          passedBoth().map((item) => ({ ...item, goalVersion: 1 })),
        ),
        "not checked · 0/2",
      ],
      // One criterion has no check at the latest attempt.
      [
        viewOf("completed", [
          check({ criterionId: "tests", outcome: "passed", attempt: 2 }),
          check({ criterionId: "readme", outcome: "passed" }),
        ]),
        "checking · 1/2",
      ],
    ];
    for (const [view, text] of cases) {
      const { unmount } = render(<div />);
      unmount();
      renderReady(<TaskHeader view={view} />);
      const shown = (await badge()).parentElement?.textContent ?? "";
      expect(shown).toBe(`Verification: ${text}`);
      expect(shown).not.toContain("verified");
      document.body.innerHTML = "";
    }
  });

  it("shows no badge for a task without a plan", async () => {
    renderReady(<TaskHeader view={viewOf("completed", [], null)} />);
    await screen.findByRole("heading", { level: 1 });
    expect(screen.queryByText(/^Verification:/)).toBeNull();
    expect(screen.queryByText(/verified/)).toBeNull();
  });

  it("lists each criterion with its evidence, and earlier versions as superseded", async () => {
    const checks = [
      check({ criterionId: "tests", outcome: "passed", goalVersion: 1 }),
      check({ criterionId: "tests", outcome: "failed", output: "1 failing\n" }),
    ];
    renderReady(<VerificationSection view={viewOf("waiting", checks)} />);
    const section = await screen.findByRole("region", {
      name: "Verification · goal v2",
    });
    const items = within(section).getAllByRole("listitem");
    expect(items[0]?.textContent).toContain("The tests pass");
    expect(items[0]?.textContent).toContain("failed");
    expect(items[0]?.textContent).toContain("`npm test` exits 0");
    expect(items[0]?.textContent).toContain("exit 1 · 4.2 s · attempt 1");
    expect(items[0]?.textContent).toContain("1 failing");
    expect(items[1]?.textContent).toContain("not checked");
    expect(within(section).getByText(/Goal v1 · superseded/)).toBeTruthy();
    expect(section.textContent).not.toContain("verified ·");
  });

  it("puts the verification on the chat's task card", async () => {
    const view = viewOf("completed", passedBoth());
    const summary: TaskSummary = {
      ...view.task,
      activeSessionCount: 0,
      sessionCount: 1,
      usage: emptyUsage(),
      verification: verificationSummary(view.task, view.verificationChecks),
    };
    const failing: TaskSummary = {
      ...summary,
      id: "task-w",
      verification: verificationSummary(view.task, [
        check({ criterionId: "tests", outcome: "failed" }),
      ]),
    };
    const base = createDemoApi({ autoplay: false });
    renderReady(
      <>
        <InlineTaskCard taskId="task-v" />
        <InlineTaskCard taskId="task-w" />
      </>,
      {
        bootstrap: async () => ({
          ...(await base.bootstrap()),
          tasks: [summary, failing],
        }),
      },
    );
    expect(
      await screen.findByRole("link", {
        name: "Task: Ship the release done · v2 · checks verified 2/2",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("link", {
        name: "Task: Ship the release done · v2 · checks failed 0/2",
      }),
    ).toBeTruthy();
  });
});

describe("checks editor", () => {
  it("creates a task with the checks the user wrote", async () => {
    const base = createDemoApi({ autoplay: false });
    const createTask = vi.fn(async () => viewOf("queued", []).task);
    renderReady(
      <NewTaskDialog initialBotIds={["bot-juno"]} onClose={() => {}} />,
      { createTask },
    );
    fireEvent.change(await screen.findByLabelText("Goal"), {
      target: { value: "Ship the release" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add a check" }));
    fireEvent.click(screen.getByRole("button", { name: "Start task" }));
    // An empty check is refused in place, not sent.
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Say what it checks.",
    );
    expect(createTask).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("What it checks"), {
      target: { value: "The tests pass" },
    });
    // Editing clears the problem it answers.
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(screen.getByLabelText("Command"), {
      target: { value: "npm test" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start task" }));
    await waitFor(() => expect(createTask).toHaveBeenCalled());
    expect(createTask).toHaveBeenCalledWith({
      goal: "Ship the release",
      coordinatorBotId: "bot-juno",
      participantBotIds: ["bot-juno"],
      verificationPlan: [
        {
          id: "the-tests-pass",
          description: "The tests pass",
          method: "command",
          command: "npm test",
        },
      ],
    });
    void base;
  });

  it("offers no checks where the server does not enforce them", async () => {
    renderReady(
      <NewTaskDialog initialBotIds={["bot-juno"]} onClose={() => {}} />,
      {},
      false,
    );
    await screen.findByLabelText("Goal");
    expect(screen.queryByRole("button", { name: "Add a check" })).toBeNull();
  });

  it("posts nothing when the checks did not change", async () => {
    const postTaskMessage = vi.fn();
    const withPlan = viewOf("completed", passedBoth());
    const base = createDemoApi({ autoplay: false });
    renderReady(<TaskHeader view={withPlan} />, {
      postTaskMessage,
      bootstrap: async () => ({
        ...(await base.bootstrap()),
        tasks: [
          {
            ...withPlan.task,
            activeSessionCount: 0,
            sessionCount: 1,
            usage: emptyUsage(),
            verification: verificationSummary(
              withPlan.task,
              withPlan.verificationChecks,
            ),
          },
        ],
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Edit checks" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Verification checks",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save as goal v3" }),
    );
    expect((await within(dialog).findByRole("status")).textContent).toBe(
      "Nothing to save: these are the checks of goal v2.",
    );
    expect(postTaskMessage).not.toHaveBeenCalled();
  });

  it("posts nothing when Add checks is saved without a check", async () => {
    const postTaskMessage = vi.fn();
    renderReady(<TaskHeader view={viewOf("completed", [], null)} />, {
      postTaskMessage,
    });
    fireEvent.click(await screen.findByRole("button", { name: "Add checks" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Verification checks",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save as goal v3" }),
    );
    await within(dialog).findByRole("status");
    expect(postTaskMessage).not.toHaveBeenCalled();
  });

  it("changes the checks as a new goal version against the version on screen", async () => {
    const view = viewOf("completed", passedBoth());
    const postTaskMessage = vi.fn(async () => ({
      id: "msg-1",
      taskId: "task-v",
      sequence: 1,
      authorKind: "user" as const,
      authorBotId: null,
      sessionId: null,
      intent: "steering" as const,
      text: "x",
      recipientBotIds: ["bot-juno"],
      createdAt: at,
    }));
    const base = createDemoApi({ autoplay: false });
    renderReady(<TaskHeader view={view} />, {
      postTaskMessage,
      bootstrap: async () => ({
        ...(await base.bootstrap()),
        tasks: [
          {
            ...view.task,
            activeSessionCount: 0,
            sessionCount: 1,
            usage: emptyUsage(),
            verification: verificationSummary(
              view.task,
              view.verificationChecks,
            ),
          },
        ],
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Edit checks" }));
    const dialog = await screen.findByRole("dialog", {
      name: "Verification checks",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Remove check 2" }),
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save as goal v3" }),
    );
    await waitFor(() => expect(postTaskMessage).toHaveBeenCalled());
    expect(postTaskMessage).toHaveBeenCalledWith("task-v", {
      text: "I changed the verification checks.",
      verificationPlan: [plan[0]],
      observedGoalVersion: 2,
    });
  });
});
