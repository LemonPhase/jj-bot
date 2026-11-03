import type { Route } from "@playwright/test";
import { expect, test } from "./fixtures";

/** A route handler that holds the requests it matches until `release()`. */
function held() {
  let release = () => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    release: () => release(),
    async handler(route: Route) {
      await released;
      await route.continue();
    },
  };
}

test("a deep link fetches its screen while the workspace loads, and names it until it arrives", async ({
  page,
}) => {
  // The backend probe is held, so the workspace cannot load until released,
  // and so is the Settings screen's chunk.
  const probe = held();
  await page.route("**/api/bootstrap", probe.handler);
  const settingsChunk = /\/assets\/SettingsScreen-[\w-]+\.js$/;
  const chunk = held();
  await page.route(settingsChunk, chunk.handler);
  const requested = Promise.all([
    page.waitForRequest("**/api/bootstrap"),
    page.waitForRequest(settingsChunk),
  ]);

  await page.goto("/#/settings", { waitUntil: "commit" });
  // The chunk is requested while the probe is still unanswered: it does not
  // wait for the workspace.
  await requested;

  probe.release();
  await expect(page.getByRole("main").getByRole("status")).toHaveText(
    "Loading Settings…",
  );
  chunk.release();
  await expect(
    page.getByRole("heading", { level: 1, name: "Settings" }),
  ).toBeVisible();
});
