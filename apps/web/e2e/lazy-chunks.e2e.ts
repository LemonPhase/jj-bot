import type { Task } from "@jj/contracts";
import type { APIRequestContext, Page } from "@playwright/test";
import { createBot, openChat } from "./app";
import { expect, test } from "./fixtures";

// The New task dialog is a chunk of its own, with tasks.css (which the Tasks
// screen shares), prefetched in the background once the page has loaded and
// imported on the first click. These tests fail the page's own requests for
// those files; the service worker would answer some of them itself, and
// pwa.e2e.ts covers it.
test.use({ serviceWorkers: "block" });

const CHUNK = /\/assets\/NewTaskDialog-[\w-]+\.js$/;
const STYLESHEET = /\/assets\/tasks-[\w-]+\.css$/;

/**
 * Fails the page's requests for `url` whose number (from 1) `fails` picks.
 * Returns how many the page made.
 */
async function failRequests(
  page: Page,
  url: RegExp,
  fails: (request: number) => boolean,
) {
  let requests = 0;
  await page.route(url, async (route) => {
    requests += 1;
    if (fails(requests)) await route.abort("failed");
    else await route.continue();
  });
  return () => requests;
}

/**
 * Opens a bot's chat; returns what clicking its New task button does: the
 * dialog it opens.
 */
async function openNewTask(page: Page, request: APIRequestContext) {
  const bot = await createBot(request, "Nova");
  const { chat } = await openChat(page, bot);
  return async () => {
    await chat.getByRole("button", { name: "New task" }).click();
    return page.getByRole("dialog", { name: "New task" });
  };
}

test("a background download that fails does not keep the New task dialog from opening", async ({
  page,
  request,
}) => {
  const chunk = await failRequests(page, CHUNK, (n) => n === 1);
  const click = await openNewTask(page, request);
  // The background download has asked for the chunk, and failed.
  await expect.poll(chunk).toBe(1);
  const dialog = await click();
  await expect(dialog.getByRole("textbox", { name: "Goal" })).toBeVisible();
  expect(chunk()).toBe(2);
});

test("a stylesheet whose background download fails still styles the dialog", async ({
  page,
  request,
}) => {
  const css = await failRequests(page, STYLESHEET, (n) => n === 1);
  const click = await openNewTask(page, request);
  await expect.poll(css).toBe(1);
  const dialog = await click();
  await expect(dialog.getByRole("textbox", { name: "Goal" })).toBeVisible();
  // tasks.css lays the form out as a column; without it, it is a block.
  await expect(dialog.locator("form")).toHaveCSS("display", "flex");
});

test("a stylesheet that fails as the dialog opens: an honest error, then the Tasks screen that shares it is styled", async ({
  page,
  request,
}) => {
  // The background download gets it; the click's own request fails.
  const css = await failRequests(page, STYLESHEET, (n) => n === 2);
  const click = await openNewTask(page, request);
  await expect.poll(css).toBe(1);
  await click();
  const failed = page.getByRole("dialog", { name: "Couldn't open this" });
  await expect(failed).toBeVisible();
  await expect(failed.getByRole("button", { name: "Reload" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Goal" })).toHaveCount(0);
  await failed.getByRole("button", { name: "Close" }).click();

  // A task (made through the API: a precondition) on the Tasks screen, which
  // shares tasks.css: asked for again, it arrives and the screen is styled.
  const bots = (await (await request.get("/api/bots")).json()) as {
    bots: { id: string }[];
  };
  const created = await request.post("/api/tasks", {
    data: { goal: "Say hi", coordinatorBotId: bots.bots[0]?.id },
  });
  expect(created.status()).toBe(201);
  const { task } = (await created.json()) as { task: Task };
  await page.goto(`/#/tasks/${task.id}`);
  const main = page.getByRole("main", { name: "Task: Say hi" });
  await expect(main).toBeVisible();
  await expect(main).toHaveCSS("flex-direction", "column");
  expect(css()).toBe(3);
});

test("a stylesheet that never arrives shows an honest error, not an unstyled part", async ({
  page,
  request,
}) => {
  const css = await failRequests(page, STYLESHEET, () => true);
  const click = await openNewTask(page, request);
  await expect.poll(css).toBeGreaterThan(0);
  await click();
  const failed = page.getByRole("dialog", { name: "Couldn't open this" });
  await expect(failed).toBeVisible();
  await expect(failed.getByRole("button", { name: "Reload" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Goal" })).toHaveCount(0);
  await failed.getByRole("button", { name: "Close" }).click();

  // The Tasks screen shares it: it says so too, rather than show unstyled.
  await page.goto("/#/tasks");
  await expect(
    page.getByRole("alert").filter({
      hasText: /this screen: Unable to load the stylesheet .*\/assets\/tasks-/,
    }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { level: 1 })).toHaveCount(0);
});
