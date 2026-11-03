import { createBot } from "./app";
import { expect, test } from "./fixtures";

// How the app starts when the API does not answer as itself: it says why,
// and never opens on the demo data, which would pass for the workspace.

test("a bootstrap redirected to a sign-in page says so and never shows the demo data", async ({
  page,
  request,
}) => {
  await createBot(request, "Nova");
  // A proxy in front sends the API's bootstrap to its login page.
  await page.route("**/api/bootstrap", (route) =>
    route.fulfill({ status: 302, headers: { location: "/login" } }),
  );
  await page.goto("/");
  await expect(
    page.getByText(
      "The API's address was redirected to /login (HTTP 200) instead of answering, as to a sign-in page.",
    ),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Reload" })).toBeVisible();
  await expect(page.getByText("Demo data")).toHaveCount(0);
});
