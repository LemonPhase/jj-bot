import type { Bot, RuntimeProfile, Task, TaskView } from "@jj/contracts";
import { getJson, taskCards } from "./app";
import { expect, test } from "./fixtures";

// A profile that asks before `git push`: the scripted coordinator runs the
// command its goal quotes after "run", so its call waits for approval.
const command = "echo shipped > shipped.txt # git push";
const goal = `Ship the release: run \`${command}\``;

async function guardedTask(request: Parameters<typeof getJson>[0]) {
  const profile = await request.post("/api/runtime-profiles", {
    data: {
      name: "Guarded local",
      sandbox: { driver: "local", network: { mode: "open" } },
      approvals: [{ tool: "bash", match: "git push" }],
    },
  });
  expect(profile.status()).toBe(201);
  const { profile: created } = (await profile.json()) as {
    profile: RuntimeProfile;
  };
  const bot = await request.post("/api/bots", {
    data: { name: "Nova", runtimeProfileId: created.id },
  });
  expect(bot.status()).toBe(201);
  const { bot: nova } = (await bot.json()) as { bot: Bot };
  const response = await request.post("/api/tasks", {
    data: { goal, coordinatorBotId: nova.id },
  });
  expect(response.status()).toBe(201);
  const { task } = (await response.json()) as { task: Task };
  return { bot: nova, task };
}

test("a held call waits in the task chat, runs once when approved, and the task finishes", async ({
  page,
  request,
}) => {
  const { task } = await guardedTask(request);
  await page.goto(`/#/tasks/${task.id}`);
  const main = page.getByRole("main", { name: `Task: ${goal}` });
  const card = main.getByRole("article", {
    name: "Approval: Nova asks to run bash",
  });

  // Pending: the whole command, the rule, and nothing run yet.
  await expect(
    card.getByText("waiting for your approval · not run"),
  ).toBeVisible();
  await expect(card.getByLabel("The bash call")).toHaveText(command);
  await expect(
    card.getByText("Needs your approval: bash calls matching `git push`"),
  ).toBeVisible();
  await expect(main.getByText("1 approval waiting")).toBeVisible();
  const before = await getJson<TaskView>(request, `/api/tasks/${task.id}`);
  expect(before.task.status).toBe("waiting");
  expect(before.artifacts.map((artifact) => artifact.path)).not.toContain(
    "shipped.txt",
  );

  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card.getByText("ran · exit 0")).toBeVisible();
  await expect(card.getByRole("button", { name: "Approve" })).toHaveCount(0);
  await expect(
    main
      .getByRole("log", { name: `Messages in ${goal}` })
      .getByText("Task done"),
  ).toBeVisible();
  await expect(main.getByText("1 approval waiting")).toHaveCount(0);

  // The API agrees: approved, ran once, and the file it wrote is there.
  const after = await getJson<TaskView>(request, `/api/tasks/${task.id}`);
  expect(after.task.status).toBe("completed");
  expect(after.approvals).toMatchObject([
    { status: "approved", outcome: { ok: true, exitCode: 0 } },
  ]);
  const file = after.artifacts.find(
    (artifact) => artifact.path === "shipped.txt",
  );
  expect(file).toBeDefined();
  const content = await request.get(
    `/api/tasks/${task.id}/artifacts/${file?.id}/content`,
  );
  expect(await content.text()).toBe("shipped\n");
});

test("the coordinator's chat shows the held call on the task card, and Deny answers it", async ({
  page,
  request,
}) => {
  const { bot, task } = await guardedTask(request);
  await page.goto(`/#/bots/${bot.id}`);
  const chat = page.getByRole("main", { name: `Chat with ${bot.name}` });
  const log = chat.getByRole("log", { name: `Messages with ${bot.name}` });
  await expect(
    log.getByText(`"${goal}" needs your approval:`, { exact: false }),
  ).toBeVisible();
  await expect(taskCards(log, goal)).toHaveCount(1);
  const held = log.getByRole("list", {
    name: `Calls in ${goal} waiting for your approval`,
  });
  await expect(held).toContainText(`Nova asks to run bash: ${command}`);

  await held.getByRole("button", { name: `Deny: ${command}` }).click();
  // Answered: the card no longer offers it.
  await expect(held).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await getJson<TaskView>(request, `/api/tasks/${task.id}`)).approvals[0]
          ?.status,
    )
    .toBe("denied");
  const view = await getJson<TaskView>(request, `/api/tasks/${task.id}`);
  expect(view.artifacts.map((artifact) => artifact.path)).not.toContain(
    "shipped.txt",
  );
});
