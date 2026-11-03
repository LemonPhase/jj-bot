import type { Bot } from "@jj/contracts";
import { getJson } from "./app";
import { expect, test } from "./fixtures";

test("creates a bot in Studio and edits it", async ({ page, request }) => {
  await page.goto("/#/studio");
  const design = page.getByRole("form", { name: "Design a bot" });
  await design.getByRole("textbox", { name: "Name" }).fill("Nova");
  await design.getByRole("textbox", { name: "Role" }).fill("Research");
  await design
    .getByRole("radiogroup", { name: "Colour" })
    .getByRole("radio", { name: "Teal" })
    .click();
  await page.getByRole("button", { name: "Create bot" }).click();

  // Creating opens the new bot's chat and lists it in the sidebar.
  const chat = page.getByRole("main", { name: "Chat with Nova" });
  const about = chat.getByRole("region", { name: "About Nova" });
  await expect(about).toContainText("Research");
  await expect(
    page.getByRole("list", { name: "Bots" }).getByRole("button", {
      name: "Nova Idle",
    }),
  ).toBeVisible();

  // Edit it from its profile, as a user reaches Studio for an existing bot.
  await chat.getByRole("button", { name: "Profile" }).click();
  await page.getByRole("link", { name: "Edit in Studio" }).click();
  const edit = page.getByRole("form", { name: "Edit Nova" });
  await edit.getByRole("textbox", { name: "Role" }).fill("Field research");
  await edit
    .getByRole("radiogroup", { name: "Colour" })
    .getByRole("radio", { name: "Violet" })
    .click();
  await page.getByRole("button", { name: "Save changes" }).click();

  // Saving returns to the chat with the change shown, stored and kept on reload.
  await expect(about).toContainText("Field research");
  const { bots } = await getJson<{ bots: Bot[] }>(request, "/api/bots");
  expect(bots).toEqual([
    expect.objectContaining({
      name: "Nova",
      role: "Field research",
      appearance: expect.objectContaining({ colour: "violet" }),
    }),
  ]);
  await page.reload();
  await expect(about).toContainText("Field research");
});
