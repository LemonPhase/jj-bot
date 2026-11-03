import type { TaskSummary, TaskTemplate, TaskView } from "@jj/contracts";
import { createBot, getJson, openChat } from "./app";
import { expect, test } from "./fixtures";

// The scripted model runs every command quoted after "run", so each task
// started from the template leaves known files: the template's own and the
// one its run's instructions add.
const goal = "Weekly notes: run `echo notes > notes.txt`";
const instructions = "This week also run `echo again > again.txt`";

test("saves a task as a template, starts it with instructions, and the task runs", async ({
  page,
  request,
}) => {
  const bot = await createBot(request, "Nova");
  const { chat } = await openChat(page, bot);

  // A task started by hand, then saved as a template from its header.
  await chat.getByRole("button", { name: "New task" }).click();
  const newTask = page.getByRole("dialog", { name: "New task" });
  await newTask.getByRole("textbox", { name: "Goal" }).fill(goal);
  await newTask.getByRole("button", { name: "Start task" }).click();
  const first = page.getByRole("main", { name: `Task: ${goal}` });
  await expect(
    first
      .getByRole("log", { name: `Messages in ${goal}` })
      .getByText("Task done"),
  ).toBeVisible();
  await first.getByRole("button", { name: "Save as template" }).click();
  const editor = page.getByRole("dialog", { name: "New template" });
  await expect(editor.getByRole("textbox", { name: "Goal" })).toHaveValue(goal);
  await editor.getByRole("textbox", { name: "Title" }).fill("Weekly notes");
  await editor.getByRole("button", { name: "Save template" }).click();
  await expect(editor).toBeHidden();

  // The Templates section lists it; the second view is the stored record.
  const templates = page.getByRole("region", { name: "Templates" });
  await expect(templates.getByText("Weekly notes")).toBeVisible();
  const stored = await getJson<{ templates: TaskTemplate[] }>(
    request,
    "/api/task-templates",
  );
  expect(stored.templates).toHaveLength(1);
  const [template] = stored.templates;
  expect(template).toMatchObject({
    title: "Weekly notes",
    goal,
    coordinatorBotId: bot.id,
    participantBotIds: [bot.id],
    problems: [],
  });

  // Start it with instructions for this run: a new task opens and runs.
  await templates.getByRole("button", { name: "Start Weekly notes" }).click();
  const start = page.getByRole("dialog", { name: "Start: Weekly notes" });
  await expect(start.getByText("Nova coordinates")).toBeVisible();
  await start
    .getByRole("textbox", { name: /Instructions for this run/ })
    .fill(instructions);
  await start.getByRole("button", { name: "Start task" }).click();
  const second = page.getByRole("main", { name: "Task: Weekly notes" });
  await expect(second.getByText("From template Weekly notes")).toBeVisible();
  await expect(
    second
      .getByRole("log", { name: "Messages in Weekly notes" })
      .getByText("Task done"),
  ).toBeVisible();

  const tasks = await getJson<{ tasks: TaskSummary[] }>(request, "/api/tasks");
  const started = tasks.tasks.find((task) => task.templateId === template?.id);
  expect(started).toMatchObject({
    title: "Weekly notes",
    goal: `${goal}\n\nInstructions for this run:\n${instructions}`,
    status: "completed",
  });
  const view = await getJson<TaskView>(request, `/api/tasks/${started?.id}`);
  expect(view.artifacts.map((artifact) => artifact.path).sort()).toEqual(
    expect.arrayContaining(["again.txt", "notes.txt"]),
  );
  // The task it was saved from is unchanged.
  expect(tasks.tasks.find((task) => task.goal === goal)?.templateId).toBeNull();
});
