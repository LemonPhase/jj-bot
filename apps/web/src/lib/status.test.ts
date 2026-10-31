import { TASK_STATUSES } from "@jj/contracts";
import { describe, expect, it } from "vitest";
import {
  describeStatus,
  moodAnimates,
  moodForStatus,
  statusTitle,
  statusTone,
  statusWord,
} from "./status";

describe("moodForStatus (brief decision 1)", () => {
  it("maps every task and session status", () => {
    expect(
      TASK_STATUSES.map((status) => [status, moodForStatus(status)]),
    ).toEqual([
      ["queued", "thinking"],
      ["running", "working"],
      ["waiting", "idle"],
      ["completed", "done"],
      ["failed", "stuck"],
      ["cancelled", "idle"],
    ]);
  });

  it("maps bot presence", () => {
    expect(moodForStatus("idle")).toBe("idle");
    expect(moodForStatus("working")).toBe("working");
  });

  it("never shows the verifying mood in Contracts 1.0", () => {
    for (const status of [...TASK_STATUSES, "idle", "working"] as const)
      expect(moodForStatus(status)).not.toBe("verifying");
  });

  it("keeps the underlying mood while a task is stopping", () => {
    expect(
      moodForStatus({
        status: "running",
        cancelRequestedAt: "2026-10-31T12:00:00Z",
      }),
    ).toBe("working");
  });

  it("animates only the working mood", () => {
    expect(moodAnimates("working")).toBe(true);
    for (const mood of [
      "idle",
      "thinking",
      "verifying",
      "done",
      "stuck",
    ] as const)
      expect(moodAnimates(mood)).toBe(false);
  });
});

describe("statusWord and statusTone (brief decision 2)", () => {
  it("uses one vocabulary with its square colour", () => {
    expect(
      TASK_STATUSES.map((status) => [
        status,
        statusWord(status),
        statusTone(status),
      ]),
    ).toEqual([
      ["queued", "queued", "idle"],
      ["running", "working", "running"],
      ["waiting", "waiting", "idle"],
      ["completed", "done", "completed"],
      ["failed", "failed", "failed"],
      ["cancelled", "stopped", "idle"],
    ]);
  });

  it("says stopping (grey) once a stop is requested, until the task is cancelled", () => {
    const at = "2026-10-31T12:00:00Z";
    for (const status of ["queued", "running", "waiting"] as const) {
      expect(statusWord({ status, cancelRequestedAt: at })).toBe("stopping");
      expect(statusTone({ status, cancelRequestedAt: at })).toBe("idle");
    }
    expect(statusWord({ status: "cancelled", cancelRequestedAt: at })).toBe(
      "stopped",
    );
    expect(statusWord({ status: "running", cancelRequestedAt: null })).toBe(
      "working",
    );
  });

  it("describes bot presence in the same words", () => {
    expect([statusWord("idle"), statusTone("idle")]).toEqual(["idle", "idle"]);
    expect([statusWord("working"), statusTone("working")]).toEqual([
      "working",
      "running",
    ]);
  });
});

describe("statusTitle", () => {
  it("explains what a waiting session or task waits for", () => {
    expect(statusTitle({ status: "waiting", waitingFor: "user" })).toBe(
      "waiting for you",
    );
    expect(statusTitle({ status: "waiting", waitingFor: "delegations" })).toBe(
      "waiting on delegated work",
    );
    expect(statusTitle("waiting")).toBe("waiting for you");
  });

  it("has nothing to add for other words", () => {
    expect(statusTitle("running")).toBeUndefined();
    expect(
      statusTitle({
        status: "waiting",
        cancelRequestedAt: "2026-10-31T12:00:00Z",
      }),
    ).toBeUndefined();
  });

  it("is part of describeStatus", () => {
    expect(
      describeStatus({ status: "waiting", waitingFor: "delegations" }),
    ).toEqual({
      word: "waiting",
      tone: "idle",
      mood: "idle",
      title: "waiting on delegated work",
    });
    expect(describeStatus("completed")).toEqual({
      word: "done",
      tone: "completed",
      mood: "done",
    });
  });
});
