import { createHash } from "node:crypto";
import type { TaskEventPage, TaskSummary, TaskView } from "@jj/contracts";
import { createBot, getJson, openChat } from "./app";
import { expect, test } from "./fixtures";

// The scripted coordinator runs the command its goal quotes after "run" as
// its first step, so its output shows what was in the workspace by then.
const goal = "Check the files: run `sha256sum uploads/*`";
const files = [
  {
    name: "table.csv",
    mimeType: "text/csv",
    buffer: Buffer.from("id,name\n1,Ada\n"),
  },
  {
    name: "notes.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Notes\n"),
  },
];
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

test("uploads two files with a new task, which finds them in its workspace, and one more from the task chat", async ({
  page,
  request,
}) => {
  const bot = await createBot(request, "Nova");
  const { chat } = await openChat(page, bot);
  await chat.getByRole("button", { name: "New task" }).click();
  const dialog = page.getByRole("dialog", { name: "New task" });
  await dialog.getByRole("textbox", { name: "Goal" }).fill(goal);
  const field = dialog.getByRole("group", { name: "Files · optional" });
  await expect(
    field.getByText(/Up to 20 files of 16\.8 MB each/),
  ).toBeVisible();
  await dialog
    .getByLabel("Files to upload", { exact: true })
    .setInputFiles(files);
  const picked = dialog.getByRole("list", { name: "Files to upload" });
  await expect(picked.getByText("14 B · ready")).toBeVisible();
  await expect(picked.getByText("8 B · ready")).toBeVisible();
  await dialog.getByRole("button", { name: "Start task" }).click();

  const main = page.getByRole("main", { name: `Task: ${goal}` });
  const log = main.getByRole("log", { name: `Messages in ${goal}` });
  const card = log.getByRole("article", { name: "You uploaded 2 files" });
  await expect(card).toBeVisible();
  await expect(log.getByText("Task done")).toBeVisible();
  await expect(
    card.getByText("In workspace · uploads/table.csv"),
  ).toBeVisible();
  await expect(card.getByText("In workspace · uploads/notes.md")).toBeVisible();
  await expect(
    card.getByRole("link", { name: "Download table.csv" }),
  ).toBeVisible();

  // The second view: the stored record, and the coordinator's first command.
  const tasks = await getJson<{ tasks: TaskSummary[] }>(request, "/api/tasks");
  const task = tasks.tasks.find((entry) => entry.goal === goal);
  const view = await getJson<TaskView>(request, `/api/tasks/${task?.id}`);
  expect(
    view.artifacts
      .filter((artifact) => artifact.upload)
      .map((artifact) => [
        artifact.path,
        artifact.upload?.state,
        artifact.sha256,
      ]),
  ).toEqual([
    ["uploads/table.csv", "placed", sha(files[0]?.buffer as Buffer)],
    ["uploads/notes.md", "placed", sha(files[1]?.buffer as Buffer)],
  ]);
  const { events } = await getJson<TaskEventPage>(
    request,
    `/api/tasks/${task?.id}/events?after=0`,
  );
  const sums = events.find(
    (event) =>
      event.type === "tool.finished" &&
      event.payload.summary === "sha256sum uploads/*",
  );
  expect(sums?.type === "tool.finished" && sums.payload.output?.trim()).toBe(
    `${sha(files[1]?.buffer as Buffer)}  uploads/notes.md\n${sha(files[0]?.buffer as Buffer)}  uploads/table.csv`,
  );
  const firstCall = events.find((event) => event.type === "model.started");
  for (const placed of events.filter(
    (event) => event.type === "artifact.updated",
  ))
    expect(placed.sequence).toBeLessThan(firstCall?.sequence ?? 0);

  // The paperclip: one more file into the finished task waits for its next run.
  await main
    .getByLabel("Files to upload into the task", { exact: true })
    .setInputFiles({
      name: "later.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("later\n"),
    });
  await main.getByRole("button", { name: "Upload 1 file" }).click();
  const later = log.getByRole("article", { name: "You uploaded 1 file" });
  await expect(later.getByText("Waiting for the next run")).toBeVisible();
  await main
    .getByRole("textbox", { name: "Message the task group" })
    .fill("Read the new file too");
  await main.getByRole("button", { name: "Send" }).click();
  await expect(
    later.getByText("In workspace · uploads/later.txt"),
  ).toBeVisible();

  // Nothing the API answered was kept by the service worker.
  const cached = await page.evaluate(async () => {
    const urls: string[] = [];
    for (const name of await caches.keys())
      for (const entry of await (await caches.open(name)).keys())
        urls.push(new URL(entry.url).pathname);
    return urls;
  });
  expect(cached.filter((path) => path.startsWith("/api"))).toEqual([]);
});
