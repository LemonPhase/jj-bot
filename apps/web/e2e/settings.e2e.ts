import type { RuntimeProfile } from "@jj/contracts";
import { getJson } from "./app";
import { expect, test } from "./fixtures";

test("edits a runtime profile in Settings", async ({ page, request }) => {
  await page.goto("/#/settings");
  await page.getByRole("tab", { name: "Runtime profiles" }).click();
  const profiles = page.getByRole("tabpanel", { name: "Runtime profiles" });
  // A fresh instance on the local driver has one profile, the default.
  await profiles
    .getByRole("article", { name: "Local (unisolated)" })
    .getByRole("button", { name: "Edit" })
    .click();

  const editor = page.getByRole("region", { name: "Edit Local (unisolated)" });
  await editor.getByRole("textbox", { name: "Name" }).fill("Local scratch");
  await editor
    .getByRole("spinbutton", { name: "Max turns per run" })
    .fill("40");
  await editor.getByRole("button", { name: "Save changes" }).click();

  // The list shows the saved profile, stored and kept on reload.
  const card = profiles.getByRole("article", { name: "Local scratch" });
  await expect(card).toContainText("40 turns · 30 min");
  await expect(editor).toBeHidden();
  const { profiles: stored } = await getJson<{ profiles: RuntimeProfile[] }>(
    request,
    "/api/runtime-profiles",
  );
  expect(stored).toEqual([
    expect.objectContaining({
      name: "Local scratch",
      isDefault: true,
      budgets: expect.objectContaining({ maxTurnsPerRun: 40 }),
    }),
  ]);
  await page.reload();
  await page.getByRole("tab", { name: "Runtime profiles" }).click();
  await expect(card).toContainText("40 turns · 30 min");
});
