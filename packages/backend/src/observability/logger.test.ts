// The structured log: JSON lines (or pretty ones), levels, the ids of the
// scope a line is written in, redaction of every string in a line, and the
// one revealed value of the token line.
import { describe, expect, it } from "vitest";
import { createRedactor } from "../redact";
import {
  createLogger,
  type LogLevel,
  logFields,
  logSettings,
  withLogFields,
} from "./logger";

const SECRET = "sk-logger-secret-0123456789abcdef";
const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_abcd";
const at = new Date("2026-11-03T12:00:00.000Z");

function capture(options: Parameters<typeof createLogger>[0] = {}) {
  const lines: { line: string; level: LogLevel }[] = [];
  const logger = createLogger({
    clock: () => at,
    write: (line, level) => lines.push({ line, level }),
    ...options,
  });
  return {
    logger,
    lines,
    json: () => lines.map(({ line }) => JSON.parse(line)),
  };
}

describe("createLogger", () => {
  it("writes one JSON object per line with time, level and message first", () => {
    const { logger, lines, json } = capture();
    logger.info("Started", { port: 3001 });
    logger.warn("Careful");
    expect(lines.map(({ line }) => line)).toEqual([
      '{"time":"2026-11-03T12:00:00.000Z","level":"info","msg":"Started","port":3001}',
      '{"time":"2026-11-03T12:00:00.000Z","level":"warn","msg":"Careful"}',
    ]);
    expect(lines.map(({ level }) => level)).toEqual(["info", "warn"]);
    expect(json()[0]).toEqual({
      time: at.toISOString(),
      level: "info",
      msg: "Started",
      port: 3001,
    });
  });

  it("drops lines below its level", () => {
    const { logger, json } = capture({ level: "warn" });
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(json().map((line) => line.level)).toEqual(["warn", "error"]);
    const debug = capture({ level: "debug" });
    debug.logger.debug("d");
    expect(debug.json()).toHaveLength(1);
  });

  it("adds the ids of the scope a line is written in, nested scopes merged", async () => {
    const { logger, json } = capture();
    await withLogFields({ requestId: "req_1" }, async () => {
      await withLogFields(
        { taskId: "task_1", sessionId: "sess_1" },
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 1));
          await withLogFields({ runId: "run_1" }, async () => {
            logger.info("inside");
          });
          expect(logFields()).toEqual({
            requestId: "req_1",
            taskId: "task_1",
            sessionId: "sess_1",
          });
        },
      );
      logger.info("outer");
    });
    logger.info("outside");
    expect(json()).toEqual([
      expect.objectContaining({
        msg: "inside",
        requestId: "req_1",
        taskId: "task_1",
        sessionId: "sess_1",
        runId: "run_1",
      }),
      {
        time: at.toISOString(),
        level: "info",
        msg: "outer",
        requestId: "req_1",
      },
      { time: at.toISOString(), level: "info", msg: "outside" },
    ]);
  });

  it("logs errors with their message and stack, and details that are not objects", () => {
    const { logger, json } = capture();
    const error = Object.assign(new Error("boom"), { code: "E_BOOM" });
    logger.error("Failed", error);
    logger.error("Failed", { error, attempt: 2n });
    logger.info("Count", 3);
    const [plain, nested, count] = json();
    expect(plain.error).toMatchObject({
      name: "Error",
      message: "boom",
      code: "E_BOOM",
      stack: expect.stringContaining("boom"),
    });
    expect(nested).toMatchObject({ error: { message: "boom" }, attempt: "2" });
    expect(count).toMatchObject({ msg: "Count", details: 3 });
  });

  it("never lets details overwrite the time, level or message", () => {
    const { logger, json } = capture();
    logger.info("Real", { msg: "forged", level: "error", time: "then" });
    expect(json()[0]).toEqual({
      time: at.toISOString(),
      level: "info",
      msg: "Real",
      msg_: "forged",
      level_: "error",
      time_: "then",
    });
  });

  it("redacts every string of a line once given a redactor", () => {
    const { logger, lines } = capture();
    logger.info(`before ${SECRET}`);
    logger.redactWith(createRedactor([{ name: "KEY", value: SECRET }]));
    logger.warn(`The key ${SECRET} failed`, {
      error: new Error(`401 for ${SECRET}`),
      nested: { list: [`x${SECRET}y`] },
      [`key-${SECRET}`]: 1,
    });
    const [before, after] = lines.map(({ line }) => line);
    expect(before).toContain(SECRET);
    expect(after).not.toContain(SECRET);
    expect(JSON.parse(after as string)).toMatchObject({
      msg: "The key [redacted] failed",
      error: { message: "401 for [redacted]" },
      nested: { list: ["x[redacted]y"] },
    });
  });

  it("reveals one value in the token line, at any level, and redacts the rest", () => {
    for (const format of ["json", "pretty"] as const) {
      const { logger, lines } = capture({ level: "error", format });
      logger.redactWith(
        createRedactor([
          { name: "the generated API token", value: TOKEN },
          { name: "KEY", value: SECRET },
        ]),
      );
      logger.info(`Open JJ Bot: http://127.0.0.1:3001/?token=${TOKEN}`);
      logger.reveal(
        `Open JJ Bot: http://127.0.0.1:3001/?token=${TOKEN} ${SECRET}`,
        TOKEN,
      );
      expect(lines, format).toHaveLength(1);
      const line = lines[0]?.line ?? "";
      expect(line.split(TOKEN)).toHaveLength(2);
      expect(line).toContain(`?token=${TOKEN} [redacted]`);
      expect(line).not.toContain(SECRET);
    }
  });

  it("writes readable lines with JJ_LOG_FORMAT=pretty", () => {
    const { logger, lines } = capture({ format: "pretty" });
    withLogFields({ taskId: "task_1" }, () =>
      logger.warn("Run failed", { outcome: "error", reason: "two words" }),
    );
    expect(lines[0]?.line).toBe(
      '2026-11-03T12:00:00.000Z WARN  Run failed taskId=task_1 outcome=error reason="two words"',
    );
  });
});

describe("logSettings", () => {
  it("reads JJ_LOG_LEVEL and JJ_LOG_FORMAT, info and JSON by default", () => {
    expect(logSettings({})).toEqual({ level: "info", format: "json" });
    expect(
      logSettings({ JJ_LOG_LEVEL: " DEBUG ", JJ_LOG_FORMAT: "pretty" }),
    ).toEqual({
      level: "debug",
      format: "pretty",
    });
  });

  it("refuses a value it does not know, naming the variable, unless lenient", () => {
    expect(() => logSettings({ JJ_LOG_LEVEL: "verbose" })).toThrow(
      'JJ_LOG_LEVEL must be one of debug, info, warn, error; got "verbose".',
    );
    expect(() => logSettings({ JJ_LOG_FORMAT: "xml" })).toThrow(
      /JJ_LOG_FORMAT/,
    );
    expect(logSettings({ JJ_LOG_LEVEL: "verbose" }, true).level).toBe("info");
  });
});
