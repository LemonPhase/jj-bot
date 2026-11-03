// The clipped copy an over-cap event payload is stored as: only what no
// record bounds is clipped, each field within its own limit, and every
// stored payload parses with its type's contract schema (a fuzz over every
// type). The events the engine reads back stay far below the cap, and
// clipping never changes a field the engine reads.
import {
  EVENT_PAYLOAD_CAP_BYTES,
  TASK_EVENT_TYPES,
  type TaskEventOf,
  type TaskEventType,
  TOOL_OUTPUT_PREVIEW_LIMIT,
} from "@jj/contracts";
import { describe, expect, it } from "vitest";
import { MIN_EVENT_PAYLOAD_CAP_BYTES } from "./config";
import {
  CLIPPABLE,
  clippedMarker,
  clippedPayload,
  PAYLOAD_STRING_CLIP_BYTES,
  payloadBytes,
  validPayload,
} from "./event-payloads";
import { SAMPLE_PAYLOADS } from "./testing/event-samples";

const CAP = MIN_EVENT_PAYLOAD_CAP_BYTES;
const bytes = (text: string) => Buffer.byteLength(text, "utf8");
/** What `emit` stores: the clipped copy, or the payload whole. */
const stored = (type: TaskEventType, payload: Record<string, unknown>) =>
  clippedPayload(type, payload, CAP) ?? payload;

describe("clippedPayload", () => {
  it("clips a tool's output preview within its limit, marked, and keeps the rest", () => {
    // Quotes: two bytes each in JSON, so 64 KiB of them is over the minimum cap.
    const output = '"'.repeat(TOOL_OUTPUT_PREVIEW_LIMIT);
    const payload = { ...SAMPLE_PAYLOADS["tool.finished"], output };
    expect(payloadBytes(payload)).toBeGreaterThan(CAP);
    const clipped = clippedPayload("tool.finished", payload, CAP);
    expect(clipped).toEqual({
      ...payload,
      output: `${'"'.repeat(PAYLOAD_STRING_CLIP_BYTES)}${clippedMarker(TOOL_OUTPUT_PREVIEW_LIMIT - PAYLOAD_STRING_CLIP_BYTES)}`,
    });
    expect(validPayload("tool.finished", clipped)).toBe(true);
    // The original is left as it was.
    expect(payload.output).toBe(output);
  });

  it("never splits a character, and keeps a text within its schema's limit", () => {
    // Astral characters: two code units and four bytes each.
    const output = "😀".repeat(TOOL_OUTPUT_PREVIEW_LIMIT / 2);
    const payload = { ...SAMPLE_PAYLOADS["tool.finished"], output };
    const clipped = clippedPayload("tool.finished", payload, CAP);
    const text = clipped?.output as string;
    expect(text.length).toBeLessThanOrEqual(TOOL_OUTPUT_PREVIEW_LIMIT);
    expect(text.startsWith("😀".repeat(PAYLOAD_STRING_CLIP_BYTES / 4))).toBe(
      true,
    );
    expect(text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it("stores record snapshots whole, whatever their size", () => {
    const huge = "中".repeat(150_000);
    const records: [TaskEventType, Record<string, unknown>][] = [
      [
        "session.updated",
        {
          ...SAMPLE_PAYLOADS["session.updated"],
          session: {
            ...SAMPLE_PAYLOADS["session.updated"].session,
            result: huge,
          },
        },
      ],
      [
        "task.updated",
        {
          ...SAMPLE_PAYLOADS["task.updated"],
          task: { ...SAMPLE_PAYLOADS["task.updated"].task, result: huge },
        },
      ],
      [
        "message.posted",
        {
          message: { ...SAMPLE_PAYLOADS["message.posted"].message, text: huge },
        },
      ],
    ];
    for (const [type, payload] of records) {
      expect(payloadBytes(payload), type).toBeGreaterThan(CAP);
      expect(validPayload(type, payload), type).toBe(true);
      expect(clippedPayload(type, payload, CAP), type).toBeUndefined();
    }
  });

  it("brings a held call's arguments under the cap even when they are not strings", () => {
    const payload = {
      approval: {
        ...SAMPLE_PAYLOADS["approval.requested"].approval,
        args: { rows: Array.from({ length: 200_000 }, (_, index) => index) },
      },
    };
    expect(payloadBytes(payload)).toBeGreaterThan(CAP);
    const clipped = clippedPayload("approval.requested", payload, CAP);
    expect(payloadBytes(clipped)).toBeLessThan(CAP);
    expect(validPayload("approval.requested", clipped)).toBe(true);
    const args = clipped?.approval.args as { rows: number[] };
    expect(args.rows.slice(0, 3)).toEqual([0, 1, 2]);
    expect(clipped?.approval.summary).toBe(payload.approval.summary);
  });

  it("clips only what no record bounds", () => {
    expect(Object.keys(CLIPPABLE).sort()).toEqual([
      "approval.requested",
      "approval.updated",
      "cancellation.completed",
      "cancellation.requested",
      "run.finished",
      "task.finished",
      "tool.finished",
    ]);
  });
});

/** xorshift32, so a failing case can be replayed from its seed. */
function generator(seed: number) {
  let state = seed | 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

const ALPHABET = ["a", "é", "中", "😀", '"', "\\", "\u0001", " ", "\n"];
const LENGTHS = [0, 1, 300, 2_000, 4_000, 4_096, 4_097, 20_000, 65_536];

function randomText(next: () => number): string {
  const pieces = 1 + Math.floor(next() * 3);
  let text = "";
  for (let piece = 0; piece < pieces; piece += 1) {
    const char = ALPHABET[Math.floor(next() * ALPHABET.length)] as string;
    const length =
      next() < 0.6
        ? (LENGTHS[Math.floor(next() * LENGTHS.length)] as number)
        : Math.floor(next() * 120_000);
    text += char.repeat(Math.ceil(length / char.length));
  }
  return text;
}

function randomJson(next: () => number, depth = 0): unknown {
  const roll = next();
  if (depth >= 2 || roll < 0.3) return randomText(next).slice(0, 30_000);
  if (roll < 0.4) return Math.floor(next() * 1e9);
  if (roll < 0.45) return next() < 0.5;
  // Bulk that is not strings: many numbers.
  if (roll < 0.55)
    return Array.from(
      { length: Math.floor(next() * 60_000) },
      (_, index) => index * 7,
    );
  if (roll < 0.8)
    return Array.from({ length: Math.floor(next() * 10) }, () =>
      randomJson(next, depth + 1),
    );
  return Object.fromEntries(
    Array.from({ length: Math.floor(next() * 6) }, (_, index) => [
      `k${index}`,
      randomJson(next, depth + 1),
    ]),
  );
}

type Path = (string | number)[];

/** The paths of the strings in `value`, and of a held call's arguments. */
function leaves(value: unknown, path: Path = []): Path[] {
  if (path.at(-1) === "args") return [path];
  if (typeof value === "string") return [path];
  if (Array.isArray(value))
    return value.flatMap((item, index) => leaves(item, [...path, index]));
  if (typeof value === "object" && value !== null)
    return Object.entries(value).flatMap(([key, item]) =>
      leaves(item, [...path, key]),
    );
  return [];
}

function setAt(value: unknown, path: Path, leaf: unknown): unknown {
  const [head, ...rest] = path;
  if (head === undefined) return leaf;
  if (Array.isArray(value))
    return value.map((item, index) =>
      index === head ? setAt(item, rest, leaf) : item,
    );
  const record = value as Record<string, unknown>;
  return { ...record, [head]: setAt(record[head as string], rest, leaf) };
}

/**
 * A valid payload of `type` with random strings (and random JSON for a held
 * call's arguments) wherever the contract accepts them.
 */
function inflate(type: TaskEventType, next: () => number): unknown {
  let payload: unknown = SAMPLE_PAYLOADS[type];
  for (const path of leaves(payload)) {
    if (next() < 0.4) continue;
    const candidate = setAt(
      payload,
      path,
      path.at(-1) === "args"
        ? { a: randomJson(next), b: randomJson(next) }
        : randomText(next),
    );
    if (validPayload(type, candidate)) payload = candidate;
  }
  return payload;
}

describe("every stored payload parses with its type's schema", () => {
  it("over random payloads of every type", () => {
    const clippedTypes = new Set<string>();
    let overCap = 0;
    for (const type of TASK_EVENT_TYPES) {
      const next = generator(0x5eed + type.length * 7919);
      for (let round = 0; round < 40; round += 1) {
        const payload = inflate(type, next) as Record<string, unknown>;
        expect(validPayload(type, payload)).toBe(true);
        if (payloadBytes(payload) <= CAP) continue;
        overCap += 1;
        const kept = stored(type, payload);
        expect(validPayload(type, kept), `${type}, round ${round}`).toBe(true);
        if (kept !== payload) {
          clippedTypes.add(type);
          expect(payloadBytes(kept)).toBeLessThan(payloadBytes(payload));
        }
      }
    }
    // The fuzz reached the cap, and clipped every kind of unbounded text.
    expect(overCap).toBeGreaterThan(100);
    expect([...clippedTypes].sort()).toEqual(
      expect.arrayContaining([
        "approval.requested",
        "approval.updated",
        "run.finished",
        "task.finished",
        "tool.finished",
      ]),
    );
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
      expect(payloadBytes(read), type).toBeLessThan(CAP / 64);
      const kept = stored(type as TaskEventType, payload);
      for (const key of sample.reads as string[])
        expect(kept[key], `${type}.${key}`).toEqual(payload[key]);
      expect(payloadBytes(kept), type).toBeLessThan(CAP / 4);
      expect(validPayload(type as TaskEventType, kept), type).toBe(true);
    }
  });

  it("are bounded by the contract's ceiling", () => {
    expect(EVENT_PAYLOAD_CAP_BYTES).toBe(1024 * 1024);
    expect(CAP).toBeLessThan(EVENT_PAYLOAD_CAP_BYTES);
    expect(bytes(clippedMarker(1))).toBeLessThan(64);
  });
});
