import type { Bot } from "@jj/contracts";
import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect } from "./fixtures";

// Page helpers shared by the browser tests. Elements are found by role and
// accessible name, as a user (or a screen reader) finds them.

/**
 * A bot made through the API: a precondition for tests whose feature is not
 * Studio, so a Studio regression fails only the Studio test.
 */
export async function createBot(
  request: APIRequestContext,
  name: string,
): Promise<Bot> {
  const response = await request.post("/api/bots", { data: { name } });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { bot: Bot }).bot;
}

/** A JSON answer of the API: the second view of what the UI stored. */
export async function getJson<T>(
  request: APIRequestContext,
  path: string,
): Promise<T> {
  const response = await request.get(path);
  expect(response.status()).toBe(200);
  return (await response.json()) as T;
}

/** Opens a bot's chat and waits until its messages have loaded. */
export async function openChat(page: Page, bot: Bot) {
  await page.goto(`/#/bots/${bot.id}`);
  const chat = page.getByRole("main", { name: `Chat with ${bot.name}` });
  const log = chat.getByRole("log", { name: `Messages with ${bot.name}` });
  await expect(log).toBeVisible();
  await expect(log).not.toContainText("Loading messages");
  return {
    chat,
    log,
    /**
     * Sends a message from the composer and waits until the log shows it
     * stored (the bubble shown while sending is hidden from the a11y tree).
     */
    async send(text: string) {
      await chat
        .getByRole("textbox", { name: `Message ${bot.name}` })
        .fill(text);
      await chat.getByRole("button", { name: "Send" }).click();
      await expect(
        log.getByRole("paragraph").filter({ hasText: `You: ${text}` }),
      ).toBeVisible();
    },
  };
}

/** The inline task cards in `scope` for the task with this title, in any state. */
export function taskCards(scope: Page | Locator, title: string): Locator {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return scope.getByRole("link", { name: new RegExp(`^Task: ${escaped} `) });
}
