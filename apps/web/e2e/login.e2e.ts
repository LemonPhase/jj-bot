import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

// Signing in (#/login) on an instance that asks for it (`--auth`): the boot
// line's login link signs a browser in once, at desktop and phone widths;
// after that no credential appears in any URL, Referer, request header or
// storage; a password that keeps failing counts down; a token an earlier
// version kept is exchanged once and deleted; and a device signed out from
// another one goes back to the login screen, then to where it was.

test.use({ auth: true });

/** The newest login link the instance printed at boot. */
async function bootLink(run: string): Promise<string> {
  const log = await readFile(join(run, "server.log"), "utf8");
  const links = [
    ...log.matchAll(/Open JJ Bot: ([^"\s]+#\/login\?code=[A-Za-z0-9_-]+)/g),
  ];
  const link = links.at(-1)?.[1];
  if (!link) throw new Error("no login link in the server log");
  return link;
}

/** Every URL, Referer and Authorization the page's requests carry. */
function recordRequests(page: Page) {
  const seen: string[] = [];
  page.on("request", (request) => {
    const headers = request.headers();
    seen.push(
      request.url(),
      headers.referer ?? "",
      headers.authorization ?? "",
    );
  });
  return seen;
}

const signedIn = (page: Page) =>
  expect(page.getByText("Scripted model").first()).toBeVisible();

const loginHeading = (page: Page) =>
  page.getByRole("heading", { name: "Sign in" });

test("a login link signs in once, and no credential is left in a URL, Referer, header or storage", async ({
  page,
  instance,
  context,
}) => {
  const seen = recordRequests(page);
  const link = await bootLink(instance.run);
  const code = link.split("code=")[1] as string;
  // A fresh load of the link signs in.
  await page.goto(link);
  await signedIn(page);
  // The code left the address bar; the app is where the link pointed.
  expect(page.url()).not.toContain(code);
  expect(page.url()).not.toContain("login");

  // The session is an HttpOnly, SameSite=Strict cookie no script can read.
  const cookies = await context.cookies();
  expect(cookies.map((cookie) => cookie.name)).toEqual(["jj_session"]);
  expect(cookies[0]).toMatchObject({
    httpOnly: true,
    sameSite: "Strict",
    path: "/",
    secure: false,
  });
  expect(await page.evaluate(() => document.cookie)).toBe("");

  // Settings → Security shows this device; downloads and streams need nothing more.
  await page.goto("/#/settings");
  await page.getByRole("tab", { name: "Security" }).click();
  await expect(
    page.getByRole("article", { name: /on / }).getByText("this device"),
  ).toBeVisible();

  const stored = await page.evaluate(() => JSON.stringify(localStorage));
  for (const value of [code, instance.token as string]) {
    expect(stored).not.toContain(value);
    for (const entry of seen) expect(entry).not.toContain(value);
  }
  expect(seen.filter((entry) => entry.startsWith("Bearer"))).toEqual([]);

  // The same link does not work twice.
  const browser = context.browser();
  if (!browser) throw new Error("no browser");
  const other = await browser.newContext({ baseURL: instance.url });
  const second = await other.newPage();
  await second.goto(link);
  await expect(loginHeading(second)).toBeVisible();
  await expect(second.getByText(/A login link works once/)).toBeVisible();
  await other.close();
});

test("a login link opened in a tab already on the login screen signs in, then opens where the user was going", async ({
  page,
  instance,
}) => {
  await page.goto("/#/settings");
  await expect(loginHeading(page)).toBeVisible();
  // Only the hash changes: the page does not load again.
  const link = await bootLink(instance.run);
  await page.goto(link);
  await expect(
    page.getByRole("heading", { name: "Settings", level: 1 }),
  ).toBeVisible();
  expect(page.url()).toMatch(/#\/settings$/);
});

test.describe("at phone width", () => {
  test.use({
    viewport: { width: 360, height: 780 },
    isMobile: true,
    hasTouch: true,
  });

  test("signs in with the access token, then opens where the user was going", async ({
    page,
    instance,
  }) => {
    await page.goto("/#/settings");
    await expect(loginHeading(page)).toBeVisible();
    expect(page.url()).toMatch(/#\/login$/);
    const width = await page.evaluate(() => ({
      page: document.scrollingElement?.scrollWidth ?? 0,
      screen: document.documentElement.clientWidth,
    }));
    expect(width.page).toBeLessThanOrEqual(width.screen);
    const field = page.getByLabel("Access token");
    const box = await field.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(
      await field.evaluate((input) => getComputedStyle(input).fontSize),
    ).toBe("16px");
    await field.fill(instance.token as string);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(
      page.getByRole("heading", { name: "Settings", level: 1 }),
    ).toBeVisible();
    expect(page.url()).toMatch(/#\/settings$/);
  });
});

test("a password that keeps failing counts down, and the right one signs in after", async ({
  page,
  instance,
}) => {
  await page.goto("/");
  await expect(loginHeading(page)).toBeVisible();
  await page.getByRole("button", { name: "Use password" }).click();
  const password = page.getByLabel("Password");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await password.fill(`wrong password ${attempt}`);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(
      page.getByText(
        "Sign-in failed: the token, password or link is wrong, used or expired.",
      ),
    ).toBeVisible();
  }
  await password.fill(instance.password as string);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByText(/Try again in 1[45]:\d\d, or use the access token/),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign in" })).toBeDisabled();
  // The token still gets the owner in.
  await page.getByRole("button", { name: "Use access token" }).click();
  await page.getByLabel("Access token").fill(instance.token as string);
  await page.getByRole("button", { name: "Sign in" }).click();
  await signedIn(page);
});

test("a token an earlier version kept is exchanged once for a session, then deleted", async ({
  page,
  instance,
}) => {
  await page.goto("/");
  await expect(loginHeading(page)).toBeVisible();
  await page.evaluate(
    (token) => localStorage.setItem("jj.apiToken", token),
    instance.token as string,
  );
  await page.goto("/?token=from-an-old-link#/bots");
  await signedIn(page);
  expect(await page.evaluate(() => localStorage.getItem("jj.apiToken"))).toBe(
    null,
  );
  expect(page.url()).not.toContain("token=");
});

test("signing a device out from another sends it back to the login screen, then where it was", async ({
  page,
  browser,
  instance,
}) => {
  await page.goto("/#/settings");
  await page.getByLabel("Access token").fill(instance.token as string);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("tab", { name: "Security" }).click();
  await expect(page.getByText("this device")).toBeVisible();

  const phone = await browser.newContext({ baseURL: instance.url });
  const other = await phone.newPage();
  await other.goto("/#/settings");
  await other.getByLabel("Access token").fill(instance.token as string);
  await other.getByRole("button", { name: "Sign in" }).click();
  await other.getByRole("tab", { name: "Security" }).click();
  await other.getByRole("button", { name: "Sign out other devices" }).click();
  await expect(other.getByText("this device")).toBeVisible();

  // The first page's event stream ends with its session; it signs in again.
  await expect(loginHeading(page)).toBeVisible({ timeout: 30_000 });
  await page.getByLabel("Access token").fill(instance.token as string);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByRole("heading", { name: "Settings", level: 1 }),
  ).toBeVisible();
  await phone.close();
});
