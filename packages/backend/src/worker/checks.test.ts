import type { ExecOptions, ExecResult, Sandbox } from "@jj/sandbox/contract";
import { describe, expect, it } from "vitest";
import { createRedactor, MIN_CUT_FRAGMENT_LENGTH, REDACTED } from "../redact";
import { type CheckEnv, headTailCollector, runCheck } from "./checks";

const KEY = "sk-check-0123456789abcdefghijklmn";
const redact = createRedactor([{ name: "OPENAI_API_KEY", value: KEY }]);

/** A sandbox whose one command streams `chunks` and then reports `result`. */
function printing(chunks: string[], result: Partial<ExecResult>): Sandbox {
  return {
    exec: async (_command: string, options?: ExecOptions) => {
      for (const chunk of chunks)
        options?.onData?.(Buffer.from(chunk), "stdout");
      return {
        exitCode: 1,
        stdout: "",
        stderr: "",
        truncated: false,
        durationMs: 1,
        interrupted: "no",
        ...result,
      };
    },
    fs: {
      stat: async (path: string) => ({
        path,
        kind: "file",
        size: 64,
        modifiedAt: new Date(0).toISOString(),
      }),
      read: async () => Buffer.from(`token=${KEY}\n`),
    },
  } as unknown as Sandbox;
}

const env = (sandbox: Sandbox, overrides: Partial<CheckEnv> = {}) => ({
  sandbox,
  limits: { execTimeoutMs: 10_000, maxOutputBytes: 1024 },
  signal: new AbortController().signal,
  deadline: new Date(Date.now() + 60_000),
  result: "",
  redact,
  ...overrides,
});

const command = {
  id: "c",
  description: "prints",
  method: "command" as const,
  command: "cat key.txt",
};

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

  it("masks a secret that holds another, cut at the head's end or the tail's start", () => {
    // Two sandbox secrets: a key, and the credentials file that holds it.
    const key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    const token = "FwoGZXIvYXdzEJr//////////wEaDOpK3hBZ5a9TokenToken";
    const file = `[default]\naws_secret_access_key=${key}\naws_session_token=${token}\n`;
    const secrets = createRedactor([
      { name: "AWS_SECRET_ACCESS_KEY", value: key },
      { name: "AWS_CREDENTIALS", value: file },
    ]);
    // The head ends 30 characters into the session token, the tail starts
    // 5 before the key.
    const head = 100 + file.indexOf(token) + 30;
    const tail = file.length - file.indexOf(key) + 5;
    const output = headTailCollector(2 * Math.max(head, tail));
    const half = Math.max(head, tail);
    output.onData(Buffer.from(`${"x".repeat(half - head + 100)}${file}`));
    output.onData(Buffer.from("y".repeat(10_000)));
    output.onData(Buffer.from(`${file}${"z".repeat(half - tail)}`));
    const text = output.text(secrets);
    expect(text).not.toContain(token.slice(0, MIN_CUT_FRAGMENT_LENGTH));
    expect(text).not.toContain("aws_session_token");
    expect(text).not.toContain(key.slice(-5));
    expect(text).toMatch(/x\[redacted\]\n\[… \d+ bytes/);
    expect(text).toMatch(/…\]\n\[redacted\]z*$/);
  });

  it("masks one a driver that does not stream cut at its own limit", async () => {
    const run = await runCheck(
      command,
      env(
        printing([], {
          stdout: `out ${KEY.slice(0, 9)}`,
          stderr: `err ${KEY.slice(0, MIN_CUT_FRAGMENT_LENGTH)}`,
          truncated: true,
        }),
      ),
    );
    expect(run.output).toBe(
      `out ${REDACTED}\nerr ${REDACTED}\n[Output cut at 1 KiB, the sandbox's output limit.]`,
    );
  });

  it("masks one a command was killed in the middle of printing", async () => {
    const stopped = { interrupted: "yes" as const, interruptReason: "timeout" };
    const streamed = await runCheck(
      command,
      env(printing([`out ${KEY.slice(0, 12)}`], stopped)),
    );
    expect(streamed.output).toBe(`out ${REDACTED}`);
    const kept = await runCheck(
      command,
      env(printing([], { ...stopped, stdout: `out ${KEY.slice(0, 12)}` })),
    );
    expect(kept.output).toBe(`out ${REDACTED}`);
  });
});

describe("a check that quotes what a regular expression matched", () => {
  it("masks the part of a secret the match is", async () => {
    for (const pattern of ["[0-9]{10}", "sk-check-[0-9]+", "[a-n]{14}$"]) {
      const run = await runCheck(
        {
          id: "m",
          description: "matches",
          method: "file",
          path: "out.txt",
          expect: "matches",
          value: pattern,
          flags: "m",
        },
        env(printing([], {})),
      );
      expect(run.outcome).toBe("passed");
      expect(run.detail).toContain(`: "${REDACTED}".`);
    }
  });
});
