import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test as base } from "@playwright/test";

const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const scripts = join(repo, ".agents/skills/verify-jj-bot/scripts");

/** A JJ Bot instance of one test: its URL and its verify-jj-bot run dir. */
export interface Instance {
  url: string;
  run: string;
}

/**
 * Every test gets an instance of its own, started with verify-jj-bot's
 * `launch.sh --no-build` (API, embedded worker and the built web app on a
 * fresh PGlite dir, the scripted model, the local driver, a cleared
 * environment) and stopped with its `stop.sh`. `baseURL` points at it, so
 * `page.goto("/#/settings")` and `request.get("/api/bots")` reach that
 * instance. A failed test gets the server log attached.
 */
export const test = base.extend<{ instance: Instance }>({
  instance: async ({}, use, testInfo) => {
    if (!existsSync(join(repo, "apps/web/dist/index.html")))
      throw new Error(
        "apps/web/dist is missing: build the web app first (npm run test:browser does)",
      );
    const { stdout } = await exec(join(scripts, "launch.sh"), ["--no-build"], {
      env: { ...process.env, JJ_VERIFY_ROOT: testInfo.outputPath("run") },
    });
    const run = stdout.trim();
    const url = (await readFile(join(run, "url"), "utf8")).trim();
    try {
      await use({ url, run });
    } finally {
      await exec(join(scripts, "stop.sh"), [run]);
      if (testInfo.status !== testInfo.expectedStatus)
        await testInfo.attach("server.log", {
          path: join(run, "evidence", "server.log"),
          contentType: "text/plain",
        });
    }
  },
  baseURL: async ({ instance }, use) => {
    await use(instance.url);
  },
});

export { expect } from "@playwright/test";
