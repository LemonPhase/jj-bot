import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { apiTarget, REPO_ROOT } from "./devEnv";

const saved = process.env.API_PORT;
afterEach(() => {
  if (saved === undefined) delete process.env.API_PORT;
  else process.env.API_PORT = saved;
});

describe("dev proxy target", () => {
  it("reads API_PORT from the .env in the given root, and the environment wins", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jj-dev-env-"));
    try {
      delete process.env.API_PORT;
      expect(apiTarget("development", dir)).toBe("http://127.0.0.1:3001");
      await writeFile(join(dir, ".env"), "API_PORT=3102\n");
      expect(apiTarget("development", dir)).toBe("http://127.0.0.1:3102");
      process.env.API_PORT = "3205";
      expect(apiTarget("development", dir)).toBe("http://127.0.0.1:3205");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("defaults to the repository root, where the API reads .env", async () => {
    const manifest = JSON.parse(
      await readFile(join(REPO_ROOT, "package.json"), "utf8"),
    ) as { name: string };
    expect(manifest.name).toBe("jj-bot");
    expect(existsSync(join(REPO_ROOT, ".env.example"))).toBe(true);
  });
});
