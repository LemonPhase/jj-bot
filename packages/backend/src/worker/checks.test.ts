import type { Sandbox } from "@jj/sandbox/contract";
import { describe, expect, it } from "vitest";
import { createRedactor, MIN_CUT_FRAGMENT_LENGTH, REDACTED } from "../redact";
import { headTailCollector, runCheck } from "./checks";

const KEY = "sk-check-0123456789abcdefghijklmn";
const redact = createRedactor([{ name: "OPENAI_API_KEY", value: KEY }]);

describe("a check's output cut at the sandbox's limit", () => {
  it("masks a key the collector's head ends in and its tail starts in", () => {
    const output = headTailCollector(64);
    // The head (32 bytes) ends 9 characters into a key; the tail (the last
    // 32) starts 9 characters before the end of one.
    output.onData(Buffer.from(`${"x".repeat(23)}${KEY}${"y".repeat(100)}`));
    output.onData(Buffer.from(`${KEY}${"z".repeat(32 - 9)}`));
    expect(output.cut).toBe(true);
    const text = output.text(redact);
    expect(text).toMatch(
      new RegExp(
        `^x{23}\\[redacted\\]\\n\\[… \\d+ bytes of output left out[^\\n]*\\n\\[redacted\\]z{23}$`,
      ),
    );
    // Not cut: redacted whole, and nothing else is touched.
    const whole = headTailCollector(1024);
    whole.onData(Buffer.from(`${KEY} then ${KEY.slice(0, 9)}`));
    expect(whole.text(redact)).toBe(`${REDACTED} then ${KEY.slice(0, 9)}`);
  });

  it("masks one a driver that does not stream cut at its own limit", async () => {
    const sandbox = {
      exec: async () => ({
        exitCode: 1,
        stdout: `out ${KEY.slice(0, 9)}`,
        stderr: `err ${KEY.slice(0, MIN_CUT_FRAGMENT_LENGTH)}`,
        truncated: true,
        durationMs: 1,
        interrupted: "no" as const,
      }),
    } as unknown as Sandbox;
    const run = await runCheck(
      {
        id: "c",
        description: "prints",
        method: "command",
        command: "cat key.txt",
      },
      {
        sandbox,
        limits: { execTimeoutMs: 10_000, maxOutputBytes: 1024 },
        signal: new AbortController().signal,
        deadline: new Date(Date.now() + 60_000),
        result: "",
        redact,
      },
    );
    expect(run.output).toBe(
      `out ${REDACTED}\nerr ${REDACTED}\n[Output cut at 1 KiB, the sandbox's output limit.]`,
    );
  });
});
