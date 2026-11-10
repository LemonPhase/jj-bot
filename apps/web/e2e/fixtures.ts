import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test as base, expect } from "@playwright/test";

const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const scripts = join(repo, ".agents/skills/verify-jj-bot/scripts");

/** A JJ Bot instance of one test: its URL and its verify-jj-bot run dir. */
export interface Instance {
  url: string;
  run: string;
  /** With `auth`: the access token and the password it signs in with. */
  token?: string;
  password?: string;
}

/**
 * Every test gets an instance of its own, started with verify-jj-bot's
 * `launch.sh --no-build` (API, embedded worker and the built web app on a
 * fresh PGlite dir, the scripted model, the local driver, a cleared
 * environment) and stopped with its `stop.sh`. `baseURL` points at it, so
 * `page.goto("/#/settings")` and `request.get("/api/bots")` reach that
 * instance. A failed test gets the server log attached.
 */
export const test = base.extend<{
  instance: Instance;
  secretStore: boolean;
  auth: boolean;
}>({
  /**
   * `test.use({ secretStore: true })` launches with `--secret-store`: the
   * instance gets a fresh random JJ_SECRET_KEY, so Settings can store keys
   * and secrets.
   */
  secretStore: [false, { option: true }],
  /**
   * `test.use({ auth: true })` launches with `--auth`: the instance asks to
   * sign in, with a random token and password (`instance.token`,
   * `instance.password`), so the browser starts signed out.
   */
  auth: [false, { option: true }],
  instance: async ({ secretStore, auth }, use, testInfo) => {
    if (!existsSync(join(repo, "apps/web/dist/index.html")))
      throw new Error(
        "apps/web/dist is missing: build the web app first (npm run test:browser does)",
      );
    const root = testInfo.outputPath("run");
    let stdout: string;
    try {
      ({ stdout } = await exec(
        join(scripts, "launch.sh"),
        [
          "--no-build",
          ...(secretStore ? ["--secret-store"] : []),
          ...(auth ? ["--auth"] : []),
        ],
        { env: { ...process.env, JJ_VERIFY_ROOT: root } },
      ));
    } catch (error) {
      // launch.sh stops a server it started when it fails or is interrupted;
      // this also covers it being killed before it could.
      await stopRuns(root);
      throw error;
    }
    const run = stdout.trim();
    const url = (await readFile(join(run, "url"), "utf8")).trim();
    const credentials = auth
      ? {
          token: await readFile(join(run, "token"), "utf8"),
          password: await readFile(join(run, "password"), "utf8"),
        }
      : {};
    try {
      await use({ url, run, ...credentials });
    } finally {
      // stop.sh copies the server log into evidence/ and removes the data.
      await exec(join(scripts, "stop.sh"), [run]);
      const log = join(run, "evidence", "server.log");
      if (testInfo.status !== testInfo.expectedStatus && existsSync(log))
        await testInfo.attach("server.log", {
          path: log,
          contentType: "text/plain",
        });
    }
  },
  baseURL: async ({ instance }, use) => {
    await use(instance.url);
  },
  /**
   * The test's page fails the test on any Content-Security-Policy violation
   * it reports: the app must work under the policy the server sends
   * (apps/api/src/headers.ts), not merely load.
   */
  page: async ({ page }, use) => {
    const violations: string[] = [];
    await page.addInitScript(() => {
      document.addEventListener("securitypolicyviolation", (event) => {
        console.error(
          `CSP violation: ${event.effectiveDirective} blocked ${event.blockedURI || "an inline resource"} at ${event.sourceFile}:${event.lineNumber}`,
        );
      });
    });
    page.on("console", (message) => {
      if (/Content Security Policy|CSP violation/i.test(message.text()))
        violations.push(message.text());
    });
    await use(page);
    expect(violations, "Content-Security-Policy violations").toEqual([]);
  },
});

/** Stops every launch.sh run under `root` that recorded a server pid. */
async function stopRuns(root: string) {
  const runs = await readdir(root).catch(() => []);
  for (const name of runs)
    if (existsSync(join(root, name, "pid")))
      await exec(join(scripts, "stop.sh"), [join(root, name)]).catch(() => {});
}

export { expect };
