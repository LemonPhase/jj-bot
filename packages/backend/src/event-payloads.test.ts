// The clipped copy an over-cap event payload is stored as, and the bound on
// what the engine reads back: those events stay far below the cap, and
// clipping never changes a field the engine reads.
import {
  EVENT_PAYLOAD_CAP_BYTES,
  type TaskEventOf,
  type TaskEventType,
} from "@jj/contracts";
import { describe, expect, it } from "vitest";
import { MIN_EVENT_PAYLOAD_CAP_BYTES } from "./config";
import {
  clipPayload,
  clippedMarker,
  PAYLOAD_STRING_CLIP_BYTES,
  payloadBytes,
} from "./event-payloads";

const bytes = (text: string) => Buffer.byteLength(text, "utf8");

describe("clipPayload", () => {
  it("keeps the shape and clips each string over 4 KiB, marked, between code points", () => {
    const long = "é".repeat(150_000); // 300 000 bytes
    const payload = {
      session: {
        id: "ses_1",
        brief: "short",
        result: long,
        error: null,
        runCount: 3,
        participants: ["a", "b"],
      },
      previousStatus: "running",
    };
    const clipped = clipPayload(payload, 256 * 1024);
    expect(clipped.session.id).toBe("ses_1");
    expect(clipped.session.brief).toBe("short");
    expect(clipped.session.error).toBeNull();
    expect(clipped.session.runCount).toBe(3);
    expect(clipped.session.participants).toEqual(["a", "b"]);
    expect(clipped.previousStatus).toBe("running");
    const head = PAYLOAD_STRING_CLIP_BYTES / 2; // two bytes a character
    expect(clipped.session.result).toBe(
      `${"é".repeat(head)}${clippedMarker(150_000 - head)}`,
    );
    expect(bytes(clipped.session.result)).toBeLessThan(
      PAYLOAD_STRING_CLIP_BYTES + 100,
    );
    // The original is left as it was.
    expect(payload.session.result).toBe(long);
  });

  it("leaves strings of 4 KiB and less alone", () => {
    const edge = "x".repeat(PAYLOAD_STRING_CLIP_BYTES);
    expect(clipPayload({ text: edge }, MIN_EVENT_PAYLOAD_CAP_BYTES)).toEqual({
      text: edge,
    });
  });

  it("brings a held call's arguments under the cap even when they are not strings", () => {
    const payload = {
      approval: {
        id: "apr_1",
        summary: "mcp tool",
        args: { rows: Array.from({ length: 200_000 }, (_, index) => index) },
      },
    };
    expect(payloadBytes(payload)).toBeGreaterThan(MIN_EVENT_PAYLOAD_CAP_BYTES);
    const clipped = clipPayload(payload, MIN_EVENT_PAYLOAD_CAP_BYTES);
    expect(payloadBytes(clipped)).toBeLessThan(MIN_EVENT_PAYLOAD_CAP_BYTES);
    expect(clipped.approval.id).toBe("apr_1");
    expect(clipped.approval.summary).toBe("mcp tool");
    expect(Array.isArray(clipped.approval.args.rows)).toBe(true);
    expect(clipped.approval.args.rows.slice(0, 3)).toEqual([0, 1, 2]);
  });

  it("bounds verification plan schemas the same way", () => {
    const schema = {
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 3000 }, (_, index) => [
          `field${index}`,
          { type: "string" },
        ]),
      ),
    };
    const plan = Array.from({ length: 20 }, (_, index) => ({
      id: `c${index}`,
      description: "valid",
      method: "result",
      expect: "json",
      schema,
    }));
    const payload = { task: { id: "tsk_1", verificationPlan: plan } };
    expect(payloadBytes(payload)).toBeGreaterThan(MIN_EVENT_PAYLOAD_CAP_BYTES);
    const clipped = clipPayload(payload, MIN_EVENT_PAYLOAD_CAP_BYTES);
    expect(payloadBytes(clipped)).toBeLessThan(MIN_EVENT_PAYLOAD_CAP_BYTES);
    expect(clipped.task.verificationPlan.map((entry) => entry.id)).toEqual(
      plan.map((entry) => entry.id),
    );
    expect(clipped.task.verificationPlan[0]?.schema.type).toBe("object");
  });
});

/**
 * The events the engine reads back, each at the largest its schema and the
 * engine let it be, with every field the engine reads (see the reads of
 * `task_events` in services/spend.ts, services/tasks.ts, worker/gate.ts,
 * worker/runs.ts and worker/artifacts.ts). Free text the engine never reads
 * (`output`, `reason`, `error`) is at its limit too.
 */
const id = "x".repeat(128);
const READ_BACK: {
  [Type in TaskEventType]?: {
    payload: TaskEventOf<Type>["payload"];
    reads: (keyof TaskEventOf<Type>["payload"])[];
  };
} = {
  "spend.capped": {
    payload: { scope: "bot", spentUsd: 9999.99, capUsd: 10_000 },
    reads: ["scope", "capUsd"],
  },
  "spend.threshold": {
    payload: { spentUsd: 9999.99, capUsd: 10_000 },
    reads: ["capUsd"],
  },
  "task.reopened": { payload: { previous: "completed" }, reads: ["previous"] },
  "verification.started": {
    payload: { goalVersion: 20, attempt: 1000, criteria: 20 },
    reads: ["goalVersion", "attempt"],
  },
  "cancellation.requested": {
    payload: { reason: "r".repeat(500) },
    reads: [],
  },
  "run.finished": {
    payload: { outcome: "cancelled", error: "e".repeat(200_000) },
    reads: ["outcome"],
  },
  "tool.started": {
    payload: { toolCallId: id, tool: "t".repeat(64), summary: "s".repeat(300) },
    reads: ["toolCallId", "tool", "summary"],
  },
  "tool.finished": {
    payload: {
      toolCallId: id,
      tool: "t".repeat(64),
      summary: "s".repeat(300),
      ok: false,
      exitCode: 137,
      interrupted: "unknown",
      // Quotes take two bytes each in JSON: the worst ordinary preview.
      output: '"'.repeat(64 * 1024),
      truncated: true,
      artifactId: id,
    },
    reads: ["toolCallId", "tool", "summary", "ok", "interrupted"],
  },
};

describe("events the engine reads back", () => {
  it("keep every field the engine reads far below the cap, and clipping never changes one", () => {
    for (const [type, sample] of Object.entries(READ_BACK)) {
      const payload = sample.payload as Record<string, unknown>;
      const read = Object.fromEntries(
        (sample.reads as string[]).map((key) => [key, payload[key]]),
      );
      // What the engine reads is a few hundred bytes at most.
      expect(payloadBytes(read), type).toBeLessThan(
        MIN_EVENT_PAYLOAD_CAP_BYTES / 64,
      );
      const clipped = clipPayload(payload, MIN_EVENT_PAYLOAD_CAP_BYTES);
      for (const key of sample.reads as string[])
        expect(clipped[key], `${type}.${key}`).toEqual(payload[key]);
      expect(payloadBytes(clipped), type).toBeLessThan(
        MIN_EVENT_PAYLOAD_CAP_BYTES / 4,
      );
    }
  });

  it("are bounded by the contract's ceiling", () => {
    expect(EVENT_PAYLOAD_CAP_BYTES).toBe(1024 * 1024);
    expect(MIN_EVENT_PAYLOAD_CAP_BYTES).toBeLessThan(EVENT_PAYLOAD_CAP_BYTES);
  });
});
