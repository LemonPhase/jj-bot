// @vitest-environment jsdom
import "../../test/dom";
import {
  type Artifact,
  type ExecutionSession,
  emptyUsage,
  type TaskEvent,
  type TaskMessage,
  type TaskView,
} from "@jj/contracts";
import { render, screen, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { ApiProvider } from "../../api/ApiContext";
import type { JJApi } from "../../api/client";
import { createDemoApi } from "../../api/demoApi";
import { useWorkspace, WorkspaceProvider } from "../../state/WorkspaceContext";
import { AboutPanel, retentionText } from "../settings/AboutPanel";
import { NodeInspector } from "./NodeInspector";
import { CompactedNote, ProgressSteps } from "./ProgressSteps";
import { TaskChat } from "./TaskChat";
import { compactedAt, savedCopies, toolCallsBySession } from "./taskModel";

const at = (second: number) =>
  `2026-10-01T12:00:${String(second).padStart(2, "0")}.000Z`;

const base = {
  taskId: "task-1",
  botId: "bot-1",
  sessionId: "s-1",
  runId: "r-1",
  causedBy: null,
};
const session: ExecutionSession = {
  id: "s-1",
  taskId: "task-1",
  botId: "bot-1",
  parentSessionId: null,
  role: "coordinator",
  brief: "Count the files",
  goalVersion: 1,
  depth: 0,
  status: "completed",
  waitingFor: null,
  result: "Counted.",
  error: null,
  activity: null,
  runCount: 1,
  createdAt: at(1),
  updatedAt: at(9),
  startedAt: at(1),
  finishedAt: at(9),
};
const saved: Artifact = {
  id: "art-big",
  taskId: "task-1",
  sessionId: "s-1",
  runId: "r-1",
  kind: "output",
  path: "message.posted payload",
  name: "message.posted.json",
  contentType: "application/json",
  sizeBytes: 300_000,
  sha256: "a".repeat(64),
  createdAt: at(6),
};
const long: TaskMessage = {
  id: "m-1",
  taskId: "task-1",
  sequence: 1,
  authorKind: "bot",
  authorBotId: "bot-1",
  sessionId: "s-1",
  intent: "discussion",
  text: "A very long report",
  recipientBotIds: [],
  createdAt: at(7),
};
const finished = (
  sequence: number,
  toolCallId: string,
  extra: Partial<TaskEvent> = {},
): TaskEvent =>
  ({
    ...base,
    id: `e${sequence}`,
    sequence,
    occurredAt: at(sequence),
    type: "tool.finished",
    payload: {
      toolCallId,
      tool: "bash",
      summary: `ls ${toolCallId}`,
      ok: true,
      exitCode: 0,
      truncated: false,
    },
    ...extra,
  }) as TaskEvent;

/** A completed task compacted through sequence 8, then continued once. */
function compactedView(): TaskView {
  const events: TaskEvent[] = [
    finished(4, "old"),
    {
      ...base,
      id: "e6",
      sequence: 6,
      occurredAt: at(6),
      type: "artifact.created",
      payload: { artifact: saved },
    },
    {
      ...base,
      id: "e7",
      sequence: 7,
      occurredAt: at(7),
      type: "message.posted",
      payloadArtifactId: "art-big",
      payload: { message: long },
    },
    {
      ...base,
      botId: null,
      sessionId: null,
      runId: null,
      id: "e9",
      sequence: 9,
      occurredAt: "2026-11-02T03:00:00.000Z",
      type: "task.compacted",
      payload: { through: 8, removed: 12, stripped: 2 },
    },
    finished(11, "new", { payloadArtifactId: "art-big" }),
  ] as TaskEvent[];
  return {
    task: {
      id: "task-1",
      title: "Count the files",
      goal: "Count the files",
      goalVersion: 1,
      coordinatorBotId: "bot-1",
      participantBotIds: ["bot-1"],
      status: "completed",
      result: "Counted.",
      error: null,
      cancelReason: null,
      cancelRequestedAt: null,
      verificationPlan: null,
      spendCapUsd: null,
      createdAt: at(0),
      updatedAt: at(12),
      finishedAt: at(12),
    },
    sessions: [session],
    messages: [long],
    artifacts: [saved],
    approvals: [],
    verificationChecks: [],
    usage: { total: emptyUsage(), bySession: {} },
    events,
    firstSequence: 4,
    hasEarlier: true,
    cursor: 12,
    compactedThrough: 8,
  };
}

function Ready({ children }: { children: ReactNode }) {
  const { loading } = useWorkspace();
  return loading ? null : <>{children}</>;
}

function renderWithWorkspace(node: ReactNode, api: Partial<JJApi> = {}) {
  const full: JJApi = { ...createDemoApi({ autoplay: false }), ...api };
  render(
    <ApiProvider api={full}>
      <WorkspaceProvider>
        <Ready>{node}</Ready>
      </WorkspaceProvider>
    </ApiProvider>,
  );
}

describe("a compacted task", () => {
  it("knows when it was compacted, which outputs are gone and which events were saved whole", () => {
    const view = compactedView();
    expect(compactedAt(view)).toBe("2026-11-02T03:00:00.000Z");
    expect(compactedAt({ ...view, compactedThrough: 0 })).toBeUndefined();
    // The marker fell out of the view's events: no date to give.
    expect(compactedAt({ ...view, events: view.events.slice(-1) })).toBeNull();
    const calls = toolCallsBySession(view).get("s-1")?.calls ?? [];
    expect(
      calls.map((call) => [call.id, call.outputGone, call.savedCopy]),
    ).toEqual([
      ["old", true, null],
      ["new", false, "art-big"],
    ]);
    expect(savedCopies(view)).toEqual(new Map([["message:m-1", "art-big"]]));
  });

  it("says so above its steps, and its tool rows say the output was not kept", async () => {
    const view = compactedView();
    renderWithWorkspace(
      <>
        <CompactedNote view={view} />
        <ProgressSteps view={view} picked="s-1" onPick={() => {}} />
      </>,
    );
    const note = await screen.findByRole("note");
    expect(note.textContent).toMatch(
      /^Activity before .*2026 was compacted\. Output previews are gone; saved full outputs are under Artifacts\.$/,
    );
    expect(screen.getByText(/output not kept/)).toBeTruthy();
  });

  it("shows nothing for a task never compacted", () => {
    render(
      <CompactedNote view={{ ...compactedView(), compactedThrough: 0 }} />,
    );
    expect(screen.queryByRole("note")).toBeNull();
  });

  it("links a spilled event's saved copy in the chat and the inspector", async () => {
    const view = compactedView();
    renderWithWorkspace(
      <>
        <TaskChat view={view} />
        <NodeInspector view={view} selected="s-1" />
      </>,
    );
    const log = await screen.findByRole("log", {
      name: "Messages in Count the files",
    });
    expect(
      within(log).getByRole("link", {
        name: "Large: open the saved copy: message.posted.json",
      }),
    ).toBeTruthy();
    const inspector = screen.getByRole("region", { name: "Selected session" });
    expect(
      within(inspector).getByRole("link", {
        name: "Large: open the saved copy: message.posted.json",
      }),
    ).toBeTruthy();
    expect(within(inspector).getByText(/output not kept/)).toBeTruthy();
  });
});

describe("Settings → About", () => {
  it("shows the server's event retention", async () => {
    const demo = createDemoApi({ autoplay: false });
    render(
      <ApiProvider
        api={{
          ...demo,
          bootstrap: async () => ({
            ...(await demo.bootstrap()),
            eventRetentionDays: 30,
          }),
        }}
      >
        <AboutPanel />
      </ApiProvider>,
    );
    await waitFor(() =>
      expect(screen.getByText("30 days after a task finishes")).toBeTruthy(),
    );
    expect(screen.getByText("JJ_EVENT_RETENTION_DAYS")).toBeTruthy();
    expect(retentionText(0)).toBe("Kept for good: compaction is off");
    expect(retentionText(1)).toBe("1 day after a task finishes");
    expect(retentionText(undefined)).toBe("Not reported by this server");
  });
});
