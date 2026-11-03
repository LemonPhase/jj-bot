// An error nothing caught goes through the process's own redacting log, and
// the process exits 1, instead of Node printing it raw.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "./config";

const SECRET = "sk-uncaught-secret-0123456789abcdef";

function crash(how: string) {
  const script = `
    const { exitOnUncaught } = await import(${JSON.stringify(join(REPO_ROOT, "apps/api/src/process.ts"))});
    const { createLogger } = await import(${JSON.stringify(join(REPO_ROOT, "packages/backend/src/index.ts"))});
    const logger = createLogger();
    logger.redactWith((value) =>
      typeof value === "string" ? value.split(${JSON.stringify(SECRET)}).join("[redacted]") : value,
    );
    exitOnUncaught(logger);
    ${how}
  `;
  return spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", script],
    {
      cwd: REPO_ROOT,
      env: { PATH: process.env.PATH },
      encoding: "utf8",
      timeout: 30_000,
    },
  );
}

describe("exitOnUncaught", () => {
  it("logs an uncaught exception redacted, then exits 1", () => {
    const result = crash(
      `setTimeout(() => { throw new Error("boom ${SECRET}"); });`,
    );
    expect(result.status, result.stderr).toBe(1);
    const line = JSON.parse(
      result.stderr
        .split("\n")
        .find((entry) => entry.includes("Uncaught exception")) ?? "{}",
    );
    expect(line).toMatchObject({
      level: "error",
      msg: "Uncaught exception: exiting",
      error: { message: "boom [redacted]" },
    });
    expect(result.stderr + result.stdout).not.toContain(SECRET);
  }, 40_000);

  it("logs an unhandled rejection redacted, then exits 1", () => {
    const result = crash(`Promise.reject(new Error("refused ${SECRET}"));`);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('"msg":"Unhandled rejection: exiting"');
    expect(result.stderr).toContain("refused [redacted]");
    expect(result.stderr + result.stdout).not.toContain(SECRET);
  }, 40_000);
});
