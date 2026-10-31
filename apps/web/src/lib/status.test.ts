import { TASK_STATUSES } from "@jj/contracts";
import { describe, expect, it } from "vitest";
import {
  acceptsMessages,
  isStoppable,
  statusColour,
  statusWord,
  taskStatusWord,
  waitingTooltip,
} from "./status";

describe("status vocabulary", () => {
  it("maps every status to one word and colour", () => {
    expect(
      TASK_STATUSES.map((status) => [
        status,
        statusWord(status),
        statusColour(statusWord(status)),
      ]),
    ).toEqual([
      ["queued", "queued", "grey"],
      ["running", "working", "blue"],
      ["waiting", "waiting", "grey"],
      ["completed", "done", "green"],
      ["failed", "failed", "red"],
      ["cancelled", "stopped", "grey"],
    ]);
  });

  it("shows a stop request as stopping until the task is cancelled", () => {
    const at = "2026-10-31T12:00:00.000Z";
    expect(taskStatusWord({ status: "running", cancelRequestedAt: at })).toBe(
      "stopping",
    );
    expect(taskStatusWord({ status: "cancelled", cancelRequestedAt: at })).toBe(
      "stopped",
    );
    expect(isStoppable({ status: "running", cancelRequestedAt: at })).toBe(
      false,
    );
    expect(isStoppable({ status: "waiting", cancelRequestedAt: null })).toBe(
      true,
    );
    expect(isStoppable({ status: "completed", cancelRequestedAt: null })).toBe(
      false,
    );
    expect(
      acceptsMessages({ status: "completed", cancelRequestedAt: null }),
    ).toBe(true);
    expect(acceptsMessages({ status: "running", cancelRequestedAt: at })).toBe(
      false,
    );
  });

  it("says what a waiting session waits for", () => {
    expect(waitingTooltip({ status: "waiting", waitingFor: "user" })).toBe(
      "waiting for you",
    );
    expect(
      waitingTooltip({ status: "waiting", waitingFor: "delegations" }),
    ).toBe("waiting on delegated work");
    expect(
      waitingTooltip({ status: "running", waitingFor: null }),
    ).toBeUndefined();
  });
});
