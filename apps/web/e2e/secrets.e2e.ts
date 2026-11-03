import type { RuntimeProfile, SecretsView } from "@jj/contracts";
import { getJson } from "./app";
import { expect, test } from "./fixtures";

// Values typed here are write-only: sent once, never shown or answered back.
const VALUE = "ghp_browserTestToken0123456789WxYz";

test.describe("with the secrets store", () => {
  test.use({ secretStore: true });

  test("stores a sandbox secret write-only and grants it to a profile", async ({
    page,
    request,
  }) => {
    const answers: string[] = [];
    page.on("response", async (response) => {
      if (
        response.url().includes("/api/") &&
        !response.url().endsWith("/stream")
      )
        answers.push(await response.text().catch(() => ""));
    });
    await page.goto("/#/settings");
    await page.getByRole("tab", { name: "Secrets" }).click();
    const panel = page.getByRole("tabpanel", { name: "Secrets" });
    // The header's button; the empty list offers the same one.
    await panel.getByRole("button", { name: "New secret" }).first().click();
    await panel.getByLabel("Name").fill("github_token");
    const value = panel.getByLabel("Value");
    await expect(value).toHaveAttribute("type", "password");
    await value.fill(VALUE);
    await panel.getByRole("button", { name: "Store secret" }).click();

    const card = panel.getByRole("article", { name: "GITHUB_TOKEN" });
    await expect(card).toContainText("ends in WxYz");
    await expect(card).toContainText("No profile grants it.");
    await expect(panel.getByLabel("Value")).toHaveCount(0);
    const stored = await getJson<SecretsView>(request, "/api/secrets");
    expect(stored).toMatchObject({
      available: true,
      secrets: [{ name: "GITHUB_TOKEN", hint: "WxYz", readable: true }],
    });

    // Granted in the profile editor, and shown on the profile.
    await page.getByRole("tab", { name: "Runtime profiles" }).click();
    const profiles = page.getByRole("tabpanel", { name: "Runtime profiles" });
    await profiles
      .getByRole("article", { name: "Local (unisolated)" })
      .getByRole("button", { name: "Edit" })
      .click();
    const editor = page.getByRole("region", {
      name: "Edit Local (unisolated)",
    });
    await editor
      .getByRole("group", { name: "Granted secrets" })
      .getByRole("button", { name: "GITHUB_TOKEN" })
      .click();
    await expect(editor).toContainText("This profile is unisolated");
    await editor.getByRole("button", { name: "Save changes" }).click();
    await expect(
      profiles.getByRole("article", { name: "Local (unisolated)" }),
    ).toContainText("secrets GITHUB_TOKEN");
    const { profiles: granted } = await getJson<{
      profiles: RuntimeProfile[];
    }>(request, "/api/runtime-profiles");
    expect(granted[0]?.secrets).toEqual(["GITHUB_TOKEN"]);

    // Nothing the page shows or the API answered carries the value.
    expect(await page.content()).not.toContain(VALUE);
    expect(answers.length).toBeGreaterThan(0);
    for (const answer of answers) expect(answer).not.toContain(VALUE);
  });
});

test("says how to turn the secrets store on when the server has no key", async ({
  page,
}) => {
  await page.goto("/#/settings");
  await page.getByRole("tab", { name: "Secrets" }).click();
  const panel = page.getByRole("tabpanel", { name: "Secrets" });
  await expect(panel).toContainText(
    'echo "JJ_SECRET_KEY=$(openssl rand -base64 32)" >> .env',
  );
  await expect(panel.getByRole("button", { name: "New secret" })).toHaveCount(
    0,
  );
});
