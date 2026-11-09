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

test("a held call too long to show in chat is reviewed and approved in the task", async ({
  page,
  request,
}) => {
  // Over the 300-character summary, so chat shows it shortened.
  const long = `echo shipped > shipped.txt; ${"true; ".repeat(60)}# git push`;
  const profile = await request.post("/api/runtime-profiles", {
    data: {
      name: "Guarded local",
      sandbox: { driver: "local", network: { mode: "open" } },
      approvals: [{ tool: "bash", match: "git push" }],
    },
  });
  const { profile: created } = (await profile.json()) as {
    profile: RuntimeProfile;
  };
  const bot = await request.post("/api/bots", {
    data: { name: "Nova", runtimeProfileId: created.id },
  });
  const { bot: nova } = (await bot.json()) as { bot: Bot };
  const response = await request.post("/api/tasks", {
    data: {
      goal: `Long release: run \`${long}\``,
      title: "Long release",
      coordinatorBotId: nova.id,
    },
  });
  const { task } = (await response.json()) as { task: Task };

  await page.goto(`/#/bots/${nova.id}`);
  const log = page
    .getByRole("main", { name: `Chat with ${nova.name}` })
    .getByRole("log", { name: `Messages with ${nova.name}` });
  const held = log.getByRole("list", {
    name: "Calls in Long release waiting for your approval",
  });
  await expect(held).toContainText("the task shows the whole call");
  // No Approve for a call the summary cuts short: review it in the task.
  await expect(held.getByRole("button", { name: /^Approve:/ })).toHaveCount(0);
  await held.getByRole("link", { name: /^Review in the task: / }).click();

  const card = page
    .getByRole("main", { name: "Task: Long release" })
    .getByRole("article", { name: "Approval: Nova asks to run bash" });
  await expect(card.getByLabel("The bash call")).toHaveText(long);
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card.getByText("ran · exit 0")).toBeVisible();
  const after = await getJson<TaskView>(request, `/api/tasks/${task.id}`);
  expect(after.approvals[0]).toMatchObject({
    kind: "tool",
    outcome: { ok: true, exitCode: 0 },
  });
});

// Spend past 80% of a task's cap that asks first: a bot on the scripted
// model at its fictional price runs the commands its goal quotes, one model
// call each, so its spend crosses the threshold well before the cap.
const notesGoal = `Write the notes: ${Array.from({ length: 30 }, (_, index) => `run \`echo ${index + 1}\``).join(", ")}.`;

async function spendingTask(
  request: Parameters<typeof getJson>[0],
  name: string,
) {
  const bot = await request.post("/api/bots", {
    data: { name, model: "scripted/team-priced" },
  });
  expect(bot.status()).toBe(201);
  const { bot: created } = (await bot.json()) as { bot: Bot };
  const response = await request.post("/api/tasks", {
    data: {
      goal: notesGoal,
      title: `${name}'s notes`,
      coordinatorBotId: created.id,
      spendCapUsd: 0.05,
      approveSpendPastThreshold: true,
    },
  });
  expect(response.status()).toBe(201);
  const { task } = (await response.json()) as { task: Task };
  return task;
}

test("spend past 80% of the task's cap waits for the user, then runs on to the cap once approved", async ({
  page,
  request,
}) => {
  const task = await spendingTask(request, "Penny");
  await page.goto(`/#/tasks/${task.id}`);
  const main = page.getByRole("main", { name: "Task: Penny's notes" });
  const card = main.getByRole("article", {
    name: "Approval: spend past 80% of the task's cap",
  });
  await expect(card.getByText("waiting · no model calls")).toBeVisible();
  await expect(card).toContainText(
    /Spent \$0\.0\d+ of \$0\.05, past the 80% threshold\. Continue up to the cap\?/,
  );
  await expect(main.getByText("1 approval waiting")).toBeVisible();
  // The API agrees: one pending approval, and no model call since it was asked.
  const held = await getJson<TaskView>(request, `/api/tasks/${task.id}`);
  const asked = held.events.find(
    (event) => event.type === "approval.requested",
  );
  expect(held.approvals).toMatchObject([
    { kind: "spend", status: "pending", capUsd: 0.05 },
  ]);
  expect(
    held.events.filter(
      (event) =>
        event.type === "model.started" &&
        event.sequence > (asked?.sequence ?? 0),
    ),
  ).toEqual([]);

  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card.getByText("approved", { exact: true })).toBeVisible();
  await expect(
    main
      .getByRole("log", { name: "Messages in Penny's notes" })
      .getByText(/^Stopped: The task reached its spend cap/),
  ).toBeVisible();
  const after = await getJson<TaskView>(request, `/api/tasks/${task.id}`);
  expect(after.approvals).toHaveLength(1);
  expect(after.usage.total.costUsd).toBeGreaterThanOrEqual(0.05);
});

test("a denied spend approval stops the task at the threshold, and a message asks again", async ({
  page,
  request,
}) => {
  const task = await spendingTask(request, "Prue");
  await page.goto(`/#/tasks/${task.id}`);
  const main = page.getByRole("main", { name: "Task: Prue's notes" });
  const log = main.getByRole("log", { name: "Messages in Prue's notes" });
  const cards = log.getByRole("article", {
    name: "Approval: spend past 80% of the task's cap",
  });
  await expect(
    cards.first().getByText("waiting · no model calls"),
  ).toBeVisible();
  const before = await getJson<TaskView>(request, `/api/tasks/${task.id}`);

  await cards.first().getByRole("button", { name: "Deny" }).click();
  await expect(cards.first().getByText("denied · task stopped")).toBeVisible();
  await expect(
    log.getByText(
      /^Stopped: spend past 80% of the task's \$0\.05 cap was not approved\./,
    ),
  ).toBeVisible();
  const denied = await getJson<TaskView>(request, `/api/tasks/${task.id}`);
  expect(denied.usage.total.costUsd).toBe(before.usage.total.costUsd);
  expect(denied.events.some((event) => event.type === "spend.capped")).toBe(
    false,
  );

  // A message continues the task and asks again, before any model call.
  await main
    .getByRole("textbox", { name: "Message the task group" })
    .fill("Please go on.");
  await main
    .getByRole("textbox", { name: "Message the task group" })
    .press("Enter");
  await expect(cards).toHaveCount(2);
  await expect(
    cards.nth(1).getByText("waiting · no model calls"),
  ).toBeVisible();
  const again = await getJson<TaskView>(request, `/api/tasks/${task.id}`);
  expect(again.usage.total.costUsd).toBe(before.usage.total.costUsd);
});
