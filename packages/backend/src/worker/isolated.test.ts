import { describe, expect, it } from "vitest";
import { liveIsolatedThreads, runIsolated } from "./isolated";

const until = async (check: () => boolean, ms: number) => {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  return check();
};

describe("isolated evaluation", () => {
  it("matches, validates and reports issues", async () => {
    expect(
      await runIsolated({ kind: "match", pattern: "b+", text: "abbbc" }),
    ).toEqual({ ok: true, result: { kind: "match", index: 1, text: "bbb" } });
    expect(
      await runIsolated({ kind: "match", pattern: "z", text: "abc" }),
    ).toEqual({ ok: true, result: { kind: "nomatch" } });
    expect(
      await runIsolated({
        kind: "schema",
        schema: {
          type: "object",
          properties: { a: { type: "string" } },
          required: ["a"],
        },
        value: {},
      }),
    ).toMatchObject({ ok: true, result: { kind: "invalid", count: 1 } });
  });

  it("stops a catastrophic pattern at its limit, and leaves no thread or CPU behind", async () => {
    const started = Date.now();
    const outcome = await runIsolated(
      { kind: "match", pattern: "^(\\w+\\s?)+$", text: `${"a".repeat(40)}!` },
      500,
    );
    expect(outcome).toMatchObject({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(5_000);
    // The thread is terminated, not left spinning.
    expect(await until(() => liveIsolatedThreads() === 0, 2_000)).toBe(true);
    const before = process.cpuUsage();
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const used = process.cpuUsage(before);
    expect(used.user + used.system).toBeLessThan(500_000);
  }, 20_000);

  it("finishes trivial checks run all at once, timing only the evaluation", async () => {
    const outcomes = await Promise.all(
      // A tight limit: starting 40 threads and loading the schema library
      // takes far longer than this, the evaluation itself far less.
      Array.from({ length: 40 }, () =>
        runIsolated(
          {
            kind: "schema",
            schema: { type: "object" },
            value: {},
          },
          150,
        ),
      ),
    );
    expect(
      outcomes.filter((outcome) => !outcome.ok).map((outcome) => outcome),
    ).toEqual([]);
    expect(await until(() => liveIsolatedThreads() === 0, 5_000)).toBe(true);
  }, 60_000);

  it("never throws, even for a value it cannot copy to its thread", async () => {
    const outcome = await runIsolated({
      kind: "schema",
      schema: { type: "object" },
      value: { fn: () => 1 },
    });
    expect(outcome).toMatchObject({ ok: false, reason: "error" });
    expect(liveIsolatedThreads()).toBe(0);
  });
});
