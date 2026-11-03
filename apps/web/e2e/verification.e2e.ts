import type { TaskSummary, TaskView } from "@jj/contracts";
import type { Page } from "@playwright/test";
import { createBot, getJson, openChat } from "./app";
import { expect, test } from "./fixtures";

// The scripted coordinator, told its checks failed, runs the fix its goal
// quotes after "if a check fails, fix it with" and completes again; without
// one it says the checks did not pass and waits for the user.
const fixable =
  "Write ready to checked.txt. If a check fails, fix it with `printf ready > checked.txt`.";
const hopeless = "Write a short note.";

/** Starts a task with one command check from the New task dialog. */
async function startWithCheck(
  page: Page,
  goal: string,
  check: { description: string; command: string },
) {
  await page.getByRole("button", { name: "New task" }).first().click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByRole("textbox", { name: "Goal" }).fill(goal);
  await dialog.getByRole("button", { name: "Add a check" }).click();
  await dialog
    .getByRole("textbox", { name: "What it checks" })
    .fill(check.description);
  await dialog.getByRole("textbox", { name: "Command" }).fill(check.command);
  await dialog.getByRole("button", { name: "Start task" }).click();
  // A long goal is clipped in the region's name.
  const start = goal.slice(0, 30).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return page.getByRole("main", { name: new RegExp(`^Task: ${start}`) });
}

test("a task's checks: verified only once they pass, never when they cannot", async ({
  page,
  request,
}) => {
  const bot = await createBot(request, "Nova");
  await openChat(page, bot);

  // A check that fails first, is fixed and passes: verified.
  const fixed = await startWithCheck(page, fixable, {
    description: "checked.txt says ready",
    command: "grep -q ready checked.txt",
  });
  await expect(
    fixed.getByRole("button", { name: "Verification: verified · 1/1" }),
  ).toBeVisible();
  const progress = page.getByRole("tabpanel", { name: "Progress" });
  const evidence = progress.getByRole("region", {
    name: "Verification · goal v1",
  });
  await expect(evidence).toContainText("checked.txt says ready");
  await expect(evidence).toContainText("exit 0");
  await expect(evidence).toContainText("attempt 2");
  // The second view: the stored evidence, both attempts.
  const tasks = await getJson<{ tasks: TaskSummary[] }>(request, "/api/tasks");
  const fixedTask = tasks.tasks.find((task) => task.goal === fixable);
  expect(fixedTask?.status).toBe("completed");
  expect(fixedTask?.verification).toMatchObject({
    state: "passed",
    attempt: 2,
  });

  // A check that cannot pass: the task waits, failed, and nothing says verified.
  const failing = await startWithCheck(page, hopeless, {
    description: "never-created.txt exists",
    command: "test -f never-created.txt",
  });
  await expect(
    failing.getByRole("button", { name: "Verification: failed · 0/1" }),
  ).toBeVisible();
  await expect(failing.getByText("waiting · v1").first()).toBeVisible();
  await expect(
    failing.getByRole("button", { name: /^Verification: verified/ }),
  ).toHaveCount(0);
  await expect(page.getByText(/^verified ·/)).toHaveCount(0);
  await expect(
    page
      .getByRole("tabpanel", { name: "Progress" })
      .getByRole("region", { name: "Verification · goal v1" }),
  ).toContainText("Not verified");
  const after = await getJson<{ tasks: TaskSummary[] }>(request, "/api/tasks");
  const failingTask = after.tasks.find((task) => task.goal === hopeless);
  expect(failingTask?.status).toBe("waiting");
  const view = await getJson<TaskView>(
    request,
    `/api/tasks/${failingTask?.id}`,
  );
  expect(view.task.result).toBeNull();
  expect(view.verificationChecks).toMatchObject([
    { outcome: "failed", exitCode: 1 },
  ]);
});
