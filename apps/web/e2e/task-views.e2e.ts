import { createBot, openChat } from "./app";
import { expect, test } from "./fixtures";

// The scripted model runs the command quoted after "run", so the task
// finishes with a known file.
const goal = "Penguin report: run `echo penguins > facts.txt`";

test("starts a task and shows it in Progress, Graph and Office 2D", async ({
  page,
  request,
}) => {
  const bot = await createBot(request, "Nova");
  const { chat } = await openChat(page, bot);
  await chat.getByRole("button", { name: "New task" }).click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByRole("textbox", { name: "Goal" }).fill(goal);
  await dialog.getByRole("button", { name: "Start task" }).click();

  const task = page.getByRole("main", { name: `Task: ${goal}` });
  await expect(
    task
      .getByRole("log", { name: `Messages in ${goal}` })
      .getByText("Task done"),
  ).toBeVisible();
  const views = page.getByRole("tablist", { name: "Task view" });
  const step = `s-1 · ${goal} done · Nova`;

  // Progress, the default view: the step and the files it wrote.
  await expect(views.getByRole("tab", { name: "Progress" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  const progress = page.getByRole("tabpanel", { name: "Progress" });
  await expect(
    progress.getByRole("list", { name: "Steps" }).getByRole("button", {
      name: step,
    }),
  ).toBeVisible();
  const download = progress.getByRole("link", { name: "Download facts.txt" });
  await expect(download).toBeVisible();
  const file = await request.get((await download.getAttribute("href")) ?? "");
  expect(await file.text()).toBe("penguins\n");

  // Graph: the coordinator and its session.
  await views.getByRole("tab", { name: "Graph" }).click();
  const graph = page.getByRole("tabpanel", { name: "Graph" });
  await expect(
    graph.getByRole("button", { name: "Nova coordinator · goal v1" }),
  ).toBeVisible();
  await expect(
    graph.getByRole("list", { name: "Sessions" }).getByRole("button", {
      name: step,
    }),
  ).toBeVisible();

  // Office, in 2D: the pixel office with Nova's desk done.
  await views.getByRole("tab", { name: "Office" }).click();
  const office = page.getByRole("tabpanel", { name: "Office" });
  await expect(
    office
      .getByRole("radiogroup", { name: "Office view" })
      .getByRole("radio", { name: "2D" }),
  ).toBeChecked();
  await expect(
    office.getByRole("img", {
      name: "Pixel office acting out the task conversation",
    }),
  ).toBeVisible();
  await expect(
    office.getByRole("list", { name: "Desks" }).getByRole("listitem"),
  ).toHaveText(["Nova: done"]);
  // That list is for screen readers; on screen, Nova stands in the office.
  await expect(office.getByText("Nova", { exact: true })).toBeVisible();
});

test("without WebGL the office offers 2D only and says why", async ({
  page,
  request,
}) => {
  // A browser with WebGL turned off, and 3D the view chosen last time.
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, "WebGLRenderingContext");
    Reflect.deleteProperty(window, "WebGL2RenderingContext");
    localStorage.setItem("jj.officeMode", "3d");
  });
  const bot = await createBot(request, "Nova");
  const created = await request.post("/api/tasks", {
    data: { goal, coordinatorBotId: bot.id },
  });
  expect(created.status()).toBe(201);
  const { task } = (await created.json()) as { task: { id: string } };
  await page.goto(`/#/tasks/${task.id}`);
  await page
    .getByRole("tablist", { name: "Task view" })
    .getByRole("tab", { name: "Office" })
    .click();

  const office = page.getByRole("tabpanel", { name: "Office" });
  const views = office.getByRole("radiogroup", { name: "Office view" });
  await expect(views.getByRole("radio", { name: "2D" })).toBeChecked();
  await expect(views.getByRole("radio", { name: "3D" })).toBeDisabled();
  await expect(views).toHaveAccessibleDescription(
    "3D needs WebGL, which this browser does not offer. The 2D office shows the same task.",
  );
  await expect(
    office.getByRole("img", {
      name: "Pixel office acting out the task conversation",
    }),
  ).toBeVisible();
});
