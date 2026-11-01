import { taskSummarySchema } from "@jj/contracts";
import { describe, expect, it } from "vitest";
import { createDemoApi } from "../api/demoApi";
import {
  rootSession,
  sessionLine,
  sessionOrdinal,
  sessionTools,
  summaryFromView,
} from "./tasks";

const api = () =>
  createDemoApi({
    now: () => new Date("2026-10-31T12:00:00.000Z"),
    autoplay: false,
  });

describe("task view helpers", () => {
  it("derives the list entry, root and ordinals from a view", async () => {
    const view = await api().getTask("task-102");
    const summary = taskSummarySchema.parse(summaryFromView(view));
    expect(summary).toMatchObject({
      id: "task-102",
      sessionCount: 2,
      activeSessionCount: 0,
    });
    const root = rootSession(view);
    expect(root?.role).toBe("coordinator");
    expect(sessionOrdinal(view, root?.id ?? "")).toBe("s-1");
    expect(sessionLine(root ?? view.sessions[0]!)).toMatch(/^Demo result/);
    expect(sessionTools(view, root?.id ?? "")).toEqual([
      "delegate Vesper",
      "complete_task",
    ]);
  });
});
