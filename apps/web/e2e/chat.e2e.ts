import type { TaskSummary } from "@jj/contracts";
import { createBot, getJson, openChat, taskCards } from "./app";
import { expect, test } from "./fixtures";

// The scripted model starts a task for a request for work, posts the task's
// update when it finishes, and passes a follow-up ("also …") to that task.
const title = "Please write a penguin report";
const followUp = "Also add a section on seals";
const update = `Update on "${title}": it completed.`;

test("direct chat starts a task, posts its update, and a follow-up continues the same task", async ({
  page,
  request,
}) => {
  const bot = await createBot(request, "Nova");
  const { log, send } = await openChat(page, bot);
  const cards = taskCards(log, title);

  await send(title);
  await expect(log.getByText("I've started a task for that.")).toBeVisible();
  await expect(log.getByText(update)).toBeVisible();
  // The reply and the update each carry the task's card, showing it done.
  await expect(cards).toHaveCount(2);
  await expect(cards.first()).toHaveAccessibleName(`Task: ${title} done · v1`);
  // The name is set apart from what the card shows; check what a user sees too.
  await expect(cards.first()).toContainText(title);
  await expect(cards.first()).toContainText("done · v1");
  const href = await cards.first().getAttribute("href");
  expect(href).toMatch(/^#\/tasks\/task_\w+$/);

  await send(followUp);
  await expect(log.getByText("I've passed that on to the task.")).toBeVisible();
  await expect(log.getByText(update)).toHaveCount(2);
  // Every card links to the one task; no second task was started.
  await expect(cards).toHaveCount(4);
  for (const card of await cards.all())
    await expect(card).toHaveAttribute("href", href ?? "");
  await expect(page.getByRole("button", { name: "Tasks 1" })).toBeVisible();
  const { tasks } = await getJson<{ tasks: TaskSummary[] }>(
    request,
    "/api/tasks",
  );
  expect(tasks.map((task) => `#/tasks/${task.id}`)).toEqual([href]);

  // The task itself received the follow-up and continued.
  await cards.last().click();
  const taskLog = page
    .getByRole("main", { name: `Task: ${title}` })
    .getByRole("log", { name: `Messages in ${title}` });
  await expect(taskLog.getByText("Task continued")).toBeVisible();
  await expect(
    taskLog.getByRole("article").filter({ hasText: followUp }),
  ).toBeVisible();
});
