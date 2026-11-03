import type { ScheduleList } from "@jj/contracts";
import { createBot, getJson } from "./app";
import { expect, test } from "./fixtures";

test("schedules a template from the Templates list: presets, the next 3 runs, inline refusals, the list and TEMPLATE_IN_USE", async ({
  page,
  request,
}) => {
  const bot = await createBot(request, "Nova");
  const created = await request.post("/api/task-templates", {
    data: {
      title: "Morning notes",
      goal: "Notes: run `echo notes > notes.txt`",
      coordinatorBotId: bot.id,
      spendCapUsd: 1,
    },
  });
  expect(created.status()).toBe(201);

  await page.goto("/#/tasks");
  const templates = page.getByRole("region", { name: "Templates" });
  await templates
    .getByRole("button", { name: "Schedule Morning notes" })
    .click();
  const editor = page.getByRole("dialog", { name: "New schedule" });
  await expect(editor.getByRole("textbox", { name: "Name" })).toHaveValue(
    "Morning notes",
  );

  // A preset fills the cron field; the zone is read on its wall clock.
  const cron = editor.getByRole("textbox", { name: "Cron" });
  await editor.getByRole("radio", { name: "Weekdays" }).click();
  await expect(cron).toHaveValue("0 9 * * 1-5");
  await editor.getByLabel("Time zone").fill("Europe/London");
  const runs = editor.locator(".schedule-editor__runs time");
  await expect(runs).toHaveCount(3);

  // What the server would refuse is refused here, before a save.
  const save = editor.getByRole("button", { name: "Save schedule" });
  await cron.fill("*/30 * * * *");
  await expect(
    editor.getByText(
      "This schedule runs 30 minutes apart at times, under this server's minimum of 60 minutes between runs.",
    ),
  ).toBeVisible();
  await expect(runs).toHaveCount(0);
  await expect(save).toBeDisabled();
  await cron.fill("0 0 30 2 *");
  await expect(
    editor.getByText("This schedule never runs in the next 366 days."),
  ).toBeVisible();
  await cron.fill("0 9 * * 1-5");
  await expect(runs).toHaveCount(3);
  await save.click();
  await expect(editor).toBeHidden();

  // Listed with its next run; the worker's scheduler is passing, so no warning.
  const schedules = page.getByRole("region", { name: "Schedules" });
  await expect(schedules.getByText("Morning notes")).toBeVisible();
  await expect(schedules.getByText(/^Next .* · Europe\/London$/)).toBeVisible();
  await expect(schedules.getByRole("status")).toHaveCount(0);
  const stored = await getJson<ScheduleList>(request, "/api/schedules");
  expect(stored.schedules).toHaveLength(1);
  expect(stored.schedules[0]).toMatchObject({
    name: "Morning notes",
    trigger: { kind: "cron", cron: "0 9 * * 1-5", timeZone: "Europe/London" },
    enabled: true,
    chatUpdates: "attention",
    keepWorkspaces: 10,
  });
  expect(stored.scheduler.lastPassAt).not.toBeNull();

  // Its template cannot be deleted while it starts it.
  await templates.getByRole("button", { name: "Delete Morning notes" }).click();
  const confirm = page.getByRole("dialog", { name: "Delete “Morning notes”?" });
  await confirm.getByRole("button", { name: "Delete template" }).click();
  await expect(confirm.getByRole("alert")).toContainText(
    'started by the schedule "Morning notes"',
  );
});
