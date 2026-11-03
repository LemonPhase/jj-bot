import type { RuntimeProfile, Task, TaskView } from "@jj/contracts";
import type { APIRequestContext, Page } from "@playwright/test";
import { createBot, getJson, openChat, taskCards } from "./app";
import { expect, test } from "./fixtures";

// Phone widths: every screen at 360px, the narrowest the layout supports,
// on a touch screen. Reduced motion, so the drawer is measured where it
// stops rather than while it slides in.
test.use({
  viewport: { width: 360, height: 780 },
  isMobile: true,
  hasTouch: true,
  reducedMotion: "reduce",
});

/**
 * Panes that scroll sideways on purpose, inside a screen that does not:
 * Settings' section tabs, wide tables and command lines, and the graph.
 */
const SIDEWAYS = [
  ".settings-tabs .ui-tabs",
  ".settings-table-wrap",
  ".settings-command",
  ".graph-canvas",
  "pre",
].join(", ");

/**
 * What breaks the phone layout on screen now: the page or a pane that
 * scrolls sideways (except `SIDEWAYS`), anything that sticks out past the
 * screen's edge, and controls smaller than 44×44 CSS px (WCAG 2.5.5; links
 * inside running text are exempt, as in 2.5.8).
 */
function layoutProblems(page: Page): Promise<string[]> {
  return page.evaluate((sideways) => {
    const problems: string[] = [];
    const width = document.documentElement.clientWidth;
    const scroller = document.scrollingElement ?? document.documentElement;
    if (scroller.scrollWidth > width)
      problems.push(
        `the page is ${scroller.scrollWidth}px wide on a ${width}px screen`,
      );
    const shown = (element: Element) => {
      const box = element.getBoundingClientRect();
      return (
        box.width > 0 &&
        box.height > 0 &&
        element.checkVisibility({ visibilityProperty: true })
      );
    };
    const describe = (element: Element) => {
      const name =
        element.getAttribute("aria-label") ??
        element.textContent?.trim().replace(/\s+/g, " ").slice(0, 48) ??
        "";
      const classes =
        typeof element.className === "string" && element.className.trim()
          ? `.${element.className.trim().split(/\s+/).join(".")}`
          : "";
      return `<${element.tagName.toLowerCase()}${classes}> "${name}"`;
    };
    /** Whether an ancestor below <body> clips or scrolls it sideways. */
    const contained = (element: Element) => {
      for (
        let parent = element.parentElement;
        parent && parent !== document.body;
        parent = parent.parentElement
      )
        if (getComputedStyle(parent).overflowX !== "visible") return true;
      return false;
    };
    for (const element of document.querySelectorAll("body *")) {
      if (!shown(element)) continue;
      const style = getComputedStyle(element);
      if (
        (style.overflowX === "auto" || style.overflowX === "scroll") &&
        element.scrollWidth > element.clientWidth + 1 &&
        !element.matches(sideways)
      )
        problems.push(
          `${describe(element)} scrolls sideways (${element.scrollWidth}px in ${element.clientWidth}px)`,
        );
      const box = element.getBoundingClientRect();
      if ((box.right > width + 1 || box.left < -1) && !contained(element))
        problems.push(
          `${describe(element)} sticks out past the screen (${Math.round(box.left)} to ${Math.round(box.right)})`,
        );
    }
    const controls = document.querySelectorAll(
      'button, a[href], input:not([type="hidden"]), select, textarea, summary, [role="button"], [role="tab"], [role="radio"], [role="checkbox"], [role="switch"]',
    );
    for (const control of controls) {
      if (!shown(control)) continue;
      let box = control.getBoundingClientRect();
      // Visually hidden (a label's proxy, a skip target): not a target.
      if (box.width <= 1 || box.height <= 1) continue;
      if (
        control.matches("a") &&
        getComputedStyle(control).display === "inline"
      )
        continue;
      // A native checkbox or radio is reached through its label.
      const label = control.matches(
        'input[type="checkbox"], input[type="radio"]',
      )
        ? control.closest("label")
        : null;
      if (label) box = label.getBoundingClientRect();
      if (box.width < 43.5 || box.height < 43.5)
        problems.push(
          `${describe(control)} is ${Math.round(box.width)}×${Math.round(box.height)}, under 44×44`,
        );
    }
    return problems;
  }, SIDEWAYS);
}

/** A bot on a profile that asks before `git push`, and its task, held for approval. */
async function heldTask(request: APIRequestContext) {
  const profile = await request.post("/api/runtime-profiles", {
    data: {
      name: "Guarded local",
      sandbox: { driver: "local", network: { mode: "open" } },
      approvals: [{ tool: "bash", match: "git push" }],
    },
  });
  expect(profile.status()).toBe(201);
  const { profile: guarded } = (await profile.json()) as {
    profile: RuntimeProfile;
  };
  const bot = await request.post("/api/bots", {
    data: { name: "Gatekeeper", runtimeProfileId: guarded.id },
  });
  expect(bot.status()).toBe(201);
  const { bot: gatekeeper } = (await bot.json()) as { bot: { id: string } };
  const response = await request.post("/api/tasks", {
    data: {
      goal: "Ship the release: run `echo shipped > shipped.txt # git push`",
      coordinatorBotId: gatekeeper.id,
    },
  });
  expect(response.status()).toBe(201);
  return ((await response.json()) as { task: Task }).task;
}

const goal = "Penguin report: run `echo penguins > facts.txt`";

test.describe("at 360px", () => {
  test.use({ secretStore: true });

  test("every screen fits the width and its controls are 44px touch targets", async ({
    page,
    request,
  }) => {
    test.setTimeout(150_000);
    // Preconditions through the API: two bots, a finished task with a
    // passed check and a task waiting for approval.
    const nova = await createBot(request, "Nova");
    const pixel = await createBot(request, "Pixel");
    const created = await request.post("/api/tasks", {
      data: {
        goal,
        coordinatorBotId: nova.id,
        participantBotIds: [nova.id, pixel.id],
        verificationPlan: [
          {
            id: "c1",
            description: "facts.txt mentions penguins",
            method: "file",
            path: "facts.txt",
            expect: "contains",
            value: "penguins",
          },
        ],
      },
    });
    expect(created.status()).toBe(201);
    const { task } = (await created.json()) as { task: Task };
    const held = await heldTask(request);
    await expect
      .poll(
        async () =>
          (await getJson<TaskView>(request, `/api/tasks/${held.id}`)).approvals
            .length,
      )
      .toBe(1);

    const problems: Record<string, string[]> = {};
    const check = async (screen: string) => {
      const found = await layoutProblems(page);
      if (found.length > 0) problems[screen] = found;
    };

    // Bots: the direct chat, with the task's card once it is done.
    const { chat } = await openChat(page, nova);
    await expect(taskCards(chat, goal)).toBeVisible({ timeout: 30_000 });
    await check("bot chat");
    await chat.getByRole("button", { name: "Profile" }).click();
    const profile = page.getByRole("complementary", {
      name: "Nova's profile",
    });
    await expect(profile).toBeVisible();
    await check("bot profile");
    await profile.getByRole("button", { name: "Close profile" }).click();

    // The menu drawer, on each list.
    await page.getByRole("button", { name: "Menu", exact: true }).click();
    const menu = page.getByRole("dialog", { name: "Menu" });
    await expect(menu.getByRole("list", { name: "Bots" })).toBeVisible();
    await check("menu: bots");
    await menu.getByRole("button", { name: /^Tasks/ }).click();
    await expect(menu.getByRole("list", { name: "Tasks" })).toBeVisible();
    await check("menu: tasks");
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();

    // A task: its chat, then Progress, Graph and Office.
    await page.goto(`/#/tasks/${task.id}`);
    const main = page.getByRole("main", { name: `Task: ${goal}` });
    await expect(main.getByText("Task done")).toBeVisible();
    await check("task chat");
    // The chat fills the first screen; the panel's tabs show under it, and a
    // tab, the chosen one too, brings its view into the screen.
    const views = page.getByRole("tablist", { name: "Task view" });
    await expect(views).toBeInViewport();
    const steps = page
      .getByRole("tabpanel", { name: "Progress" })
      .getByRole("list", { name: "Steps" });
    await expect(steps).not.toBeInViewport();
    await views.getByRole("tab", { name: "Progress" }).click();
    await expect(steps).toBeInViewport();
    await check("task progress");
    await views.getByRole("tab", { name: "Graph" }).click();
    await expect(
      page
        .getByRole("tabpanel", { name: "Graph" })
        .getByRole("button", { name: "Nova coordinator · goal v1" }),
    ).toBeInViewport();
    await check("task graph");
    await views.getByRole("tab", { name: "Office" }).click();
    const office = page.getByRole("tabpanel", { name: "Office" });
    await expect(
      office.getByRole("img", {
        name: "Pixel office acting out the task conversation",
      }),
    ).toBeVisible();
    // 3D is not offered on a phone, and the office says why.
    const view3d = office
      .getByRole("radiogroup", { name: "Office view" })
      .getByRole("radio", { name: "3D" });
    await expect(view3d).toBeDisabled();
    await expect(
      office.getByRole("radiogroup", { name: "Office view" }),
    ).toHaveAccessibleDescription(
      "3D needs a wider screen. The 2D office shows the same task.",
    );
    await check("task office");
    await views.getByRole("tab", { name: "Progress" }).click();
    await main.getByRole("button", { name: "Edit checks" }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await check("checks dialog");
    await page.keyboard.press("Escape");

    // A call waiting for approval, answered from the phone.
    await page.goto(`/#/tasks/${held.id}`);
    const card = page.getByRole("article", {
      name: "Approval: Gatekeeper asks to run bash",
    });
    await expect(card.getByRole("button", { name: "Approve" })).toBeVisible();
    await check("task approval");

    // Studio, new and editing.
    await page.goto("/#/studio");
    await expect(
      page.getByRole("form", { name: "Design a bot" }),
    ).toBeVisible();
    await check("studio new");
    await page.goto(`/#/studio/${nova.id}`);
    await expect(page.getByRole("form", { name: "Edit Nova" })).toBeVisible();
    await check("studio edit");

    // Settings, every section, and the profile editor with its approval rule.
    await page.goto("/#/settings");
    for (const section of [
      "Models",
      "Secrets",
      "Runtime profiles",
      "Drivers",
      "Usage",
    ]) {
      await page.getByRole("tab", { name: section }).click();
      const panel = page.getByRole("tabpanel", { name: section });
      await expect(panel).toBeVisible();
      await expect(panel.getByText(/Loading/)).toHaveCount(0);
      await check(`settings: ${section}`);
    }
    await page.getByRole("tab", { name: "Runtime profiles" }).click();
    await page
      .getByRole("article", { name: "Guarded local" })
      .getByRole("button", { name: "Edit" })
      .click();
    await expect(
      page.getByRole("region", { name: "Edit Guarded local" }),
    ).toBeVisible();
    await check("settings: profile editor");

    // The New task dialog.
    await openChat(page, nova);
    await page.getByRole("button", { name: "New task" }).click();
    await expect(page.getByRole("dialog", { name: "New task" })).toBeVisible();
    await check("new task dialog");

    expect(problems).toEqual({});
  });
});

/** Whether the focused element is inside the open drawer. */
const focusInMenu = (page: Page) =>
  page.evaluate(() => Boolean(document.activeElement?.closest("dialog[open]")));

test("the menu drawer keeps focus in order, closes on Escape and follows a row", async ({
  page,
  request,
}) => {
  const nova = await createBot(request, "Nova");
  const pixel = await createBot(request, "Pixel");
  await openChat(page, nova);
  // The sidebar is folded away; the top bar keeps the mode badge in view.
  await expect(
    page.getByRole("complementary", { name: "Navigation" }),
  ).toBeHidden();
  await expect(
    page.getByRole("banner").getByText("Scripted model"),
  ).toBeVisible();

  // The menu button comes first, with the usual keyboard focus ring.
  await page.keyboard.press("Tab");
  const menuButton = page.getByRole("button", { name: "Menu", exact: true });
  await expect(menuButton).toBeFocused();
  await expect(menuButton).toHaveAttribute("aria-expanded", "false");
  await expect(menuButton).toHaveCSS("outline-style", "solid");
  await expect(menuButton).toHaveCSS("outline-width", "1px");

  await page.keyboard.press("Enter");
  const menu = page.getByRole("dialog", { name: "Menu" });
  await expect(menu).toBeVisible();
  // Focus starts in the drawer and Tab walks it in reading order.
  const focus = page.locator(":focus");
  const order = [
    "JJ BOT",
    "New bot",
    "Close menu",
    "Bots 2",
    "Tasks 0",
    "Nova Idle",
    "Settings",
    "Switch to dark theme",
  ];
  for (const [step, name] of order.entries()) {
    if (step > 0) await page.keyboard.press("Tab");
    await expect(focus).toHaveAccessibleName(name);
    expect(await focusInMenu(page)).toBe(true);
  }
  await page.keyboard.press("Shift+Tab");
  await expect(focus).toHaveAccessibleName("Settings");

  // Escape closes it and gives focus back to the menu button.
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(menuButton).toBeFocused();
  await expect(menuButton).toHaveAttribute("aria-expanded", "false");

  // A row opens its bot and closes the drawer.
  await menuButton.click();
  await expect(menuButton).toHaveAttribute("aria-expanded", "true");
  await menu.getByRole("button", { name: "Pixel Idle" }).click();
  await expect(menu).toBeHidden();
  await expect(
    page.getByRole("main", { name: "Chat with Pixel" }),
  ).toBeVisible();
  expect(new URL(page.url()).hash).toBe(`#/bots/${pixel.id}`);

  // So does a tap on the backdrop, beside the drawer.
  await menuButton.click();
  await expect(menu).toBeVisible();
  await page.mouse.click(350, 400);
  await expect(menu).toBeHidden();
});
