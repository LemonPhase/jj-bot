// @vitest-environment jsdom
import "../../test/dom";
import { emptyUsage, type TaskView, type UsageReport } from "@jj/contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiProvider } from "../../api/ApiContext";
import type { JJApi } from "../../api/client";
import { createDemoApi } from "../../api/demoApi";
import { UsagePanel } from "../settings/UsagePanel";
import {
  formatCap,
  spendLevel,
  spendLine,
  unpricedNote,
  usageDetail,
} from "./format";
import { SpendControl } from "./SpendControl";
import { readCapInput } from "./spendInput";

const at = "2026-11-03T12:00:00.000Z";

const cappedEvent = {
  id: "e-capped",
  taskId: "task-1",
  sequence: 9,
  occurredAt: at,
  botId: "bot-1",
  sessionId: "s-1",
  runId: "r-1",
  causedBy: null,
  type: "spend.capped" as const,
  payload: { scope: "task" as const, spentUsd: 0.6, capUsd: 0.5 },
};

/** A task view with this much priced spend and this cap. */
function viewWith(
  costUsd: number,
  spendCapUsd: number | null,
  patch: Partial<Pick<TaskView["task"], "status">> & {
    events?: TaskView["events"];
  } = {},
): TaskView {
  const usage = {
    ...emptyUsage(),
    modelCalls: 4,
    inputTokens: 12_000,
    outputTokens: 800,
    costUsd,
    unpricedCalls: 1,
  };
  return {
    task: {
      id: "task-1",
      title: "Count",
      goal: "Count.",
      goalVersion: 1,
      coordinatorBotId: "bot-1",
      participantBotIds: ["bot-1"],
      status: patch.status ?? "waiting",
      result: null,
      error: null,
      cancelReason: null,
      cancelRequestedAt: null,
      verificationPlan: null,
      spendCapUsd,
      approveSpendPastThreshold: false,
      templateId: null,
      scheduleId: null,
      createdAt: at,
      updatedAt: at,
      finishedAt: null,
    },
    sessions: [],
    messages: [],
    artifacts: [],
    approvals: [],
    verificationChecks: [],
    usage: { total: usage, bySession: {} },
    events: patch.events ?? [],
    firstSequence: 1,
    hasEarlier: false,
    cursor: 0,
    compactedThrough: 0,
  };
}

function renderWith(api: Partial<JJApi>, node: React.ReactNode) {
  const full: JJApi = { ...createDemoApi({ autoplay: false }), ...api };
  render(<ApiProvider api={full}>{node}</ApiProvider>);
  return full;
}

describe("spend formats", () => {
  it("shows caps as set, and the level against them", () => {
    expect([5, 0.035, 0.5, 12.5].map(formatCap)).toEqual([
      "$5.00",
      "$0.035",
      "$0.50",
      "$12.50",
    ]);
    expect(spendLevel(1, null)).toBe("ok");
    expect(spendLevel(3.99, 5)).toBe("ok");
    expect(spendLevel(4, 5)).toBe("warning");
    expect(spendLevel(5, 5)).toBe("reached");
    expect(spendLine(0.42, 5)).toBe("$0.42 of $5.00");
    expect(spendLine(0.42, null)).toBe("$0.42 · no cap");
    expect(spendLine(0.004789, 0.004)).toBe("$0.004789 of $0.004");
    // Near the cap, places enough that over never reads as at or under.
    expect(spendLine(4.996, 5)).toBe("$4.996 of $5.00");
    expect(spendLine(5.0004, 5)).toBe("$5.0004 of $5.00");
    expect(spendLine(0.015, 0.01)).toBe("$0.015 of $0.01");
  });

  it("never shows calls with no listed price as free", () => {
    const usage = { ...emptyUsage(), modelCalls: 2, unpricedCalls: 2 };
    expect(unpricedNote(usage)).toBe(
      "2 calls on a model with no listed price: not in the cost, and no cap bounds them",
    );
    expect(unpricedNote(emptyUsage())).toBeNull();
    expect(usageDetail(usage)).toContain("2 with no listed price");
  });

  it("reads a cap input: empty is no cap, nonsense is refused", () => {
    expect(readCapInput(" ")).toEqual({ ok: true, value: null });
    expect(readCapInput("2.5")).toEqual({ ok: true, value: 2.5 });
    for (const bad of ["0", "-1", "abc", "10001"])
      expect(readCapInput(bad).ok).toBe(false);
  });
});

describe("the task header's spend control", () => {
  it("says the cap was reached and raises it through the API", async () => {
    const updateTask = vi.fn(async () => viewWith(0.6, 2).task);
    renderWith(
      { updateTask },
      <SpendControl view={viewWith(0.6, 0.5, { events: [cappedEvent] })} />,
    );
    const control = screen.getByRole("button", { name: /Usage:/ });
    expect(control.textContent).toContain("$0.60 of $0.50");
    expect(control.textContent).toContain("cap reached");
    expect(control.className).toContain("task-spend--reached");

    fireEvent.click(control);
    expect(
      screen.getByText(/After raising it, send a message in the task chat/),
    ).toBeDefined();
    const input = screen.getByLabelText("Spend cap (USD)");
    fireEvent.change(input, { target: { value: "-3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save cap" }));
    expect(
      await screen.findByText(/Enter an amount above 0 and at most 10000/),
    ).toBeDefined();
    expect(updateTask).not.toHaveBeenCalled();

    fireEvent.change(input, { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Save cap" }));
    await waitFor(() =>
      expect(updateTask).toHaveBeenCalledWith("task-1", { spendCapUsd: 2 }),
    );
    // Cleared: no cap.
    fireEvent.click(control);
    fireEvent.change(screen.getByLabelText("Spend cap (USD)"), {
      target: { value: "" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save cap" }));
    await waitFor(() =>
      expect(updateTask).toHaveBeenLastCalledWith("task-1", {
        spendCapUsd: null,
      }),
    );
  });

  it("turns amber past the soft threshold and says when there is no cap", () => {
    renderWith({}, <SpendControl view={viewWith(0.45, 0.5)} />);
    expect(screen.getByRole("button", { name: /Usage:/ }).className).toContain(
      "task-spend--warning",
    );
  });
});

describe("the usage badge's wording and reach", () => {
  const tipOf = (control: HTMLElement) =>
    document.getElementById(control.getAttribute("aria-describedby") ?? "")
      ?.textContent ?? "";

  it("says stopped only when the cap stopped the task, else at or past it", () => {
    renderWith(
      {},
      <SpendControl view={viewWith(0.6, 0.5, { status: "completed" })} />,
    );
    const control = screen.getByRole("button", { name: /Usage:/ });
    expect(tipOf(control)).toContain("At or past its spend cap of $0.50");
    expect(tipOf(control)).not.toContain("Stopped");
  });

  const reopened = {
    ...cappedEvent,
    id: "e-reopened",
    sequence: 10,
    type: "task.reopened" as const,
    payload: { previous: "waiting" as const },
  };
  const tipFor = (view: TaskView) => {
    renderWith({}, <SpendControl view={view} />);
    return tipOf(screen.getByRole("button", { name: /Usage:/ }));
  };

  it("says stopped while the current cap's stop stands", () => {
    expect(tipFor(viewWith(0.6, 0.5, { events: [cappedEvent] }))).toContain(
      "Stopped at its spend cap of $0.50",
    );
  });

  it("says at or past, not stopped, for a waiting task no cap stopped", () => {
    const tip = tipFor(viewWith(0.6, 0.5));
    expect(tip).toContain("At or past its spend cap of $0.50");
    expect(tip).not.toContain("Stopped");
  });

  it("no longer says stopped once the cap was raised after the stop", () => {
    const tip = tipFor(viewWith(0.6, 0.8, { events: [cappedEvent] }));
    expect(tip).toContain("Spend cap $0.80");
    expect(tip).not.toContain("Stopped");
  });

  it("says stopped only for the cap that stopped it, not a changed one still passed", () => {
    const tip = tipFor(viewWith(0.6, 0.55, { events: [cappedEvent] }));
    expect(tip).toContain("At or past its spend cap of $0.55");
    expect(tip).not.toContain("Stopped");
  });

  it("no longer says stopped once the user continued the task", () => {
    const tip = tipFor(viewWith(0.6, 0.5, { events: [cappedEvent, reopened] }));
    expect(tip).toContain("At or past its spend cap of $0.50");
    expect(tip).not.toContain("Stopped");
  });

  it("keeps the breakdown reachable on a cancelled task, and opens no dialog", () => {
    const updateTask = vi.fn();
    renderWith(
      { updateTask },
      <SpendControl view={viewWith(0.2, 5, { status: "cancelled" })} />,
    );
    const control = screen.getByRole("button", { name: /Usage:/ });
    expect((control as HTMLButtonElement).disabled).toBe(false);
    expect(control.getAttribute("aria-disabled")).toBe("true");
    expect(tipOf(control)).toContain("4 model calls");
    fireEvent.focus(control);
    expect(screen.getByRole("tooltip").hidden).toBe(false);
    fireEvent.click(control);
    expect(screen.queryByLabelText("Spend cap (USD)")).toBeNull();
  });
});

describe("Settings → Usage", () => {
  it("lists the windows, each bot against its cap, and models", async () => {
    const zero = emptyUsage();
    const spent = (costUsd: number, modelCalls = 1) => ({
      ...zero,
      costUsd,
      modelCalls,
    });
    const report: UsageReport = {
      asOf: at,
      instance: {
        last24h: spent(20.5, 3),
        last7d: spent(25, 4),
        last30d: { ...spent(30, 6), unpricedCalls: 2 },
        capUsdPerDay: 50,
      },
      bots: [
        {
          botId: "a",
          name: "Ada",
          archived: false,
          last24h: spent(20.5),
          last30d: spent(28),
          chatLast30d: spent(1.25),
          capUsdPerDay: 20,
        },
        {
          botId: "b",
          name: "Bob",
          archived: true,
          last24h: { ...zero, modelCalls: 2, unpricedCalls: 2 },
          last30d: spent(2),
          chatLast30d: { ...zero, modelCalls: 2, unpricedCalls: 2 },
          capUsdPerDay: null,
        },
      ],
      models: [
        { model: "openai/gpt-x", last30d: spent(30, 4) },
        { model: "free/model", last30d: { ...spent(0, 2), unpricedCalls: 2 } },
      ],
    };
    renderWith({ getUsage: async () => report }, <UsagePanel />);
    const ada = await screen.findByRole("row", { name: /Ada/ });
    expect(ada.textContent).toContain("$20.50 of $20.00");
    expect(ada.textContent).toContain("cap reached");
    expect(ada.textContent).toContain("$1.25");
    const bob = screen.getByRole("row", { name: /Bob/ });
    expect(bob.textContent).toContain("(archived)");
    // Unpriced calls are named in every cell that has them, never shown as free.
    expect(bob.textContent).toContain("$0.00 · no cap + 2 unpriced");
    expect(bob.textContent).toContain("$0.00 + 2 unpriced");
    expect(screen.getByText(/\$20\.50 of \$50\.00/)).toBeDefined();
    expect(
      screen.getByText(
        "2 calls on a model with no listed price: not in the cost, and no cap bounds them.",
      ),
    ).toBeDefined();
    expect(
      screen.getByRole("row", { name: /free\/model/ }).textContent,
    ).toContain("no listed price");
    // The demo API's own report says it is demo data.
    expect(screen.getByText(/Demo data: these totals/)).toBeDefined();
  });
});
