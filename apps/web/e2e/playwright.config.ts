import { defineConfig, devices } from "@playwright/test";

const ci = Boolean(process.env.CI);

/**
 * The browser suite (`npm run test:browser`): headless Chromium against the
 * built web app, each test on an isolated instance started by verify-jj-bot's
 * launch script (fresh PGlite, scripted model, local driver). See
 * docs/development.md#browser-tests.
 */
export default defineConfig({
  testDir: ".",
  testMatch: "*.e2e.ts",
  // Paths are relative to this file: test-results/ at the repository root.
  outputDir: "../../../test-results/browser",
  // A failed test keeps its trace, screenshot and server log; a passed one nothing.
  preserveOutput: "failures-only",
  fullyParallel: true,
  forbidOnly: ci,
  // A flaky test fails the run rather than passing on a retry.
  retries: 0,
  // A test includes starting and stopping its instance.
  timeout: 90_000,
  // On CI a hung run fails here, before the job's 10-minute limit, so the
  // job still uploads the evidence.
  globalTimeout: ci ? 8 * 60_000 : 0,
  expect: { timeout: 15_000 },
  reporter: ci
    ? [
        ["github"],
        ["list"],
        [
          "html",
          {
            open: "never",
            outputFolder: "../../../test-results/browser-report",
          },
        ],
      ]
    : [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    actionTimeout: 15_000,
    navigationTimeout: 15_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
