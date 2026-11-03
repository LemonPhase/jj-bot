// @vitest-environment jsdom
import "../../test/dom";
import {
  COMMAND_TEXT_LIMIT,
  PROFILE_SPEND_CAP,
  type TaskView,
  TEMPLATE_INSTRUCTIONS_HEADING,
} from "@jj/contracts";
import {
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiProvider } from "../../api/ApiContext";
import type { JJApi } from "../../api/client";
import { createDemoApi } from "../../api/demoApi";
import { useWorkspace, WorkspaceProvider } from "../../state/WorkspaceContext";
import { stubShell, TestShell } from "../../test/shell";
import type { ShellActions } from "../shell/ShellContext";
import { TaskHeader } from "../tasks/TaskHeader";
import TemplateDialog from "./TemplateDialog";
import { TemplateList } from "./TemplateList";

configure({ asyncUtilTimeout: 5000 });

const SEEDED = "tmpl-demo-1";

/** The demo API without seeded tasks, so every demo bot can be archived. */
const demo = () => createDemoApi({ autoplay: false, tasks: [] });

afterEach(() => {
  window.location.hash = "";
});

/** Renders once the workspace has loaded over `api`, inside a stub shell. */
function renderReady(
  ui: ReactNode,
  api: JJApi = demo(),
  shell: ShellActions = stubShell(),
) {
  function Ready({ children }: { children: ReactNode }) {
    const { loading, templates } = useWorkspace();
    return loading || templates === null ? null : <>{children}</>;
  }
  render(
    <ApiProvider api={api}>
      <WorkspaceProvider>
        <TestShell actions={shell}>
          <Ready>{ui}</Ready>
        </TestShell>
      </WorkspaceProvider>
    </ApiProvider>,
  );
  return { api, shell };
}

describe("the Templates sidebar section", () => {
  it("lists each template with Start, Edit and Delete, opening their dialogs", async () => {
    const { shell } = renderReady(<TemplateList />);
    const section = await screen.findByRole("region", { name: "Templates" });
    expect(within(section).getByText("Weekly contract review")).toBeTruthy();
    expect(within(section).getByText("Kite · 2 bots")).toBeTruthy();
    for (const [name, kind] of [
      ["Start Weekly contract review", "start"],
      ["Edit Weekly contract review", "edit"],
      ["Delete Weekly contract review", "delete"],
    ] as const) {
      fireEvent.click(within(section).getByRole("button", { name }));
      expect(shell.openTemplateDialog).toHaveBeenLastCalledWith({
        kind,
        templateId: SEEDED,
      });
    }
    fireEvent.click(
      within(section).getByRole("button", { name: "New template" }),
    );
    expect(shell.openTemplateDialog).toHaveBeenLastCalledWith({ kind: "new" });
  });

  it("shows why a template cannot start and disables Start while a bot is archived", async () => {
    const api = demo();
    renderReady(<TemplateList />, api);
    const start = await screen.findByRole("button", {
      name: "Start Weekly contract review",
    });
    expect(start as HTMLButtonElement).toHaveProperty("disabled", false);
    await api.archiveBot("bot-vesper");
    expect(await screen.findByText("Vesper is archived.")).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Start Weekly contract review",
      }) as HTMLButtonElement,
    ).toHaveProperty("disabled", true);
    expect(
      screen.getByRole("button", {
        name: "Edit Weekly contract review",
      }) as HTMLButtonElement,
    ).toHaveProperty("disabled", false);
  });

  it("is not shown by a server without templates", async () => {
    const base = demo();
    const api: JJApi = {
      ...base,
      listTemplates: () =>
        Promise.reject(
          Object.assign(new Error("Not found"), { code: "NOT_FOUND" }),
        ),
    };
    render(
      <ApiProvider api={api}>
        <WorkspaceProvider>
          <TestShell>
            <TemplateList />
          </TestShell>
        </WorkspaceProvider>
      </ApiProvider>,
    );
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());
    expect(screen.queryByRole("region", { name: "Templates" })).toBeNull();
  });
});

describe("the template editor", () => {
  it("saves a new template with a title, the team and the cap chosen", async () => {
    const api = demo();
    const create = vi.spyOn(api, "createTemplate");
    const onClose = vi.fn();
    renderReady(
      <TemplateDialog request={{ kind: "new" }} onClose={onClose} />,
      api,
    );
    const dialog = await screen.findByRole("dialog", { name: "New template" });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save template" }),
    );
    expect(
      await within(dialog).findByText("Give the template a title."),
    ).toBeTruthy();
    expect(within(dialog).getByText("Describe the goal.")).toBeTruthy();
    expect(create).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByRole("textbox", { name: "Title" }), {
      target: { value: "Daily digest" },
    });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Goal" }), {
      target: { value: "Summarise the day." },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Moss/ }));
    const cap = within(dialog).getByRole("radiogroup", { name: "Spend cap" });
    expect(
      within(cap)
        .getByRole("radio", { name: "Profile's" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(within(cap).getByRole("radio", { name: "No cap" }));
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save template" }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith({
      title: "Daily digest",
      goal: "Summarise the day.",
      coordinatorBotId: "bot-juno",
      participantBotIds: ["bot-juno", "bot-moss"],
      verificationPlan: null,
      spendCapUsd: null,
    });
    expect(
      (await api.listTemplates()).map((template) => template.title),
    ).toContain("Daily digest");
  });

  it("edits a template, leaving out an archived bot and setting an amount", async () => {
    const api = demo();
    await api.archiveBot("bot-vesper");
    const update = vi.spyOn(api, "updateTemplate");
    const onClose = vi.fn();
    renderReady(
      <TemplateDialog
        request={{ kind: "edit", templateId: SEEDED }}
        onClose={onClose}
      />,
      api,
    );
    const dialog = await screen.findByRole("dialog", { name: "Edit template" });
    expect(
      within(dialog).getByText(
        "Vesper is archived and left out when you save.",
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("textbox", {
        name: "Title",
      }) as HTMLInputElement,
    ).toHaveProperty("value", String("Weekly contract review"));
    fireEvent.click(within(dialog).getByRole("radio", { name: "Amount" }));
    fireEvent.change(
      within(dialog).getByRole("spinbutton", { name: "Cap (USD)" }),
      { target: { value: "2.5" } },
    );
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save template" }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(update).toHaveBeenCalledWith(
      SEEDED,
      expect.objectContaining({
        coordinatorBotId: "bot-kite",
        participantBotIds: ["bot-kite"],
        spendCapUsd: 2.5,
      }),
    );
    expect(await api.getTemplate(SEEDED)).toMatchObject({
      problems: [],
      spendCapUsd: 2.5,
    });
  });

  it("sends the profile's cap back as PROFILE_SPEND_CAP", async () => {
    const api = demo();
    await api.updateTemplate(SEEDED, { spendCapUsd: 4 });
    const update = vi.spyOn(api, "updateTemplate");
    renderReady(
      <TemplateDialog
        request={{ kind: "edit", templateId: SEEDED }}
        onClose={() => {}}
      />,
      api,
    );
    const dialog = await screen.findByRole("dialog", { name: "Edit template" });
    expect(
      within(dialog).getByRole("spinbutton", {
        name: "Cap (USD)",
      }) as HTMLInputElement,
    ).toHaveProperty("value", String(4));
    fireEvent.click(within(dialog).getByRole("radio", { name: "Profile's" }));
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save template" }),
    );
    await waitFor(() =>
      expect(update).toHaveBeenCalledWith(
        SEEDED,
        expect.objectContaining({ spendCapUsd: PROFILE_SPEND_CAP }),
      ),
    );
    expect("spendCapUsd" in (await api.getTemplate(SEEDED))).toBe(false);
  });

  it("starts from the open task as it is now when saved from its header", async () => {
    const base = createDemoApi({ autoplay: false });
    const create = vi.spyOn(base, "createTemplate");
    window.location.hash = "#/tasks/task-102";
    const { task } = await base.getTask("task-102");
    function WhenFollowed({ children }: { children: ReactNode }) {
      return useWorkspace().taskViews["task-102"] ? <>{children}</> : null;
    }
    const onClose = vi.fn();
    renderReady(
      <WhenFollowed>
        <TemplateDialog
          request={{ kind: "new", fromTaskId: "task-102" }}
          onClose={onClose}
        />
      </WhenFollowed>,
      base,
    );
    const dialog = await screen.findByRole("dialog", { name: "New template" });
    expect(
      within(dialog).getByRole("textbox", {
        name: "Title",
      }) as HTMLInputElement,
    ).toHaveProperty("value", String(task.title));
    expect(
      within(dialog).getByRole("textbox", { name: "Goal" }) as HTMLInputElement,
    ).toHaveProperty("value", String(task.goal));
    expect(
      within(dialog).getByRole("spinbutton", {
        name: "Cap (USD)",
      }) as HTMLInputElement,
    ).toHaveProperty("value", String(task.spendCapUsd));
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Save template" }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(create).toHaveBeenCalledWith({
      title: task.title,
      goal: task.goal,
      coordinatorBotId: task.coordinatorBotId,
      participantBotIds: task.participantBotIds,
      verificationPlan: null,
      spendCapUsd: task.spendCapUsd,
    });
  });
});

describe("the start dialog", () => {
  it("shows the cap the task gets, appends the instructions and opens the new task", async () => {
    const api = demo();
    const start = vi.spyOn(api, "startTemplate");
    const onClose = vi.fn();
    renderReady(
      <TemplateDialog
        request={{ kind: "start", templateId: SEEDED }}
        onClose={onClose}
      />,
      api,
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Start: Weekly contract review",
    });
    expect(
      within(dialog).getByText("$5.00, from Kite's profile."),
    ).toBeTruthy();
    expect(
      within(dialog).getByText("Kite coordinates, with Vesper"),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        `Added to the goal under “${TEMPLATE_INSTRUCTIONS_HEADING}”.`,
      ),
    ).toBeTruthy();
    fireEvent.change(
      within(dialog).getByRole("textbox", {
        name: /Instructions for this run/,
      }),
      { target: { value: "  Only the API changes.  " } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Start task" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(start).toHaveBeenCalledWith(SEEDED, {
      instructions: "Only the API changes.",
    });
    const task = await start.mock.results[0]?.value;
    expect(window.location.hash).toBe(`#/tasks/${task.id}`);
    expect(task).toMatchObject({ templateId: SEEDED });
  });

  it("says why a template cannot start and offers no Start", async () => {
    const api = demo();
    await api.archiveBot("bot-vesper");
    const start = vi.spyOn(api, "startTemplate");
    const shell = stubShell();
    renderReady(
      <TemplateDialog
        request={{ kind: "start", templateId: SEEDED }}
        onClose={() => {}}
      />,
      api,
      shell,
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Start: Weekly contract review",
    });
    expect(within(dialog).getByRole("alert").textContent).toContain(
      "Can't startVesper is archived.",
    );
    expect(
      within(dialog).getByRole("button", {
        name: "Start task",
      }) as HTMLButtonElement,
    ).toHaveProperty("disabled", true);
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Edit template" }),
    );
    expect(shell.openTemplateDialog).toHaveBeenCalledWith({
      kind: "edit",
      templateId: SEEDED,
    });
    expect(start).not.toHaveBeenCalled();
  });

  it("refuses instructions that push the goal over the task limit before sending", async () => {
    const api = demo();
    const long = await api.createTemplate({
      title: "Long goal",
      goal: "g".repeat(COMMAND_TEXT_LIMIT - 10),
      coordinatorBotId: "bot-kite",
    });
    renderReady(
      <TemplateDialog
        request={{ kind: "start", templateId: long.id }}
        onClose={() => {}}
      />,
      api,
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Start: Long goal",
    });
    fireEvent.change(
      within(dialog).getByRole("textbox", {
        name: /Instructions for this run/,
      }),
      { target: { value: "Far too much to add." } },
    );
    expect(
      within(dialog).getByText(
        `With these instructions the goal is over ${COMMAND_TEXT_LIMIT} characters; shorten them.`,
      ),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole("button", {
        name: "Start task",
      }) as HTMLButtonElement,
    ).toHaveProperty("disabled", true);
  });

  it("deletes a template after a confirmation", async () => {
    const api = demo();
    const onClose = vi.fn();
    renderReady(
      <TemplateDialog
        request={{ kind: "delete", templateId: SEEDED }}
        onClose={onClose}
      />,
      api,
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Delete “Weekly contract review”?",
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete template" }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(await api.listTemplates()).toEqual([]);
  });
});

describe("the task header", () => {
  async function headerFor(templateId: string | null) {
    const api = createDemoApi({ autoplay: false });
    const view: TaskView = await api.getTask("task-102");
    const shell = stubShell();
    renderReady(
      <TaskHeader view={{ ...view, task: { ...view.task, templateId } }} />,
      api,
      shell,
    );
    return { view, shell };
  }

  it("says which template a task came from, and saves a task as a template", async () => {
    const { view, shell } = await headerFor(SEEDED);
    expect(
      await screen.findByText("From template Weekly contract review"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Save as template" }));
    expect(shell.openTemplateDialog).toHaveBeenCalledWith({
      kind: "new",
      fromTaskId: view.task.id,
    });
  });

  it("names a deleted template as such, and says nothing for a manual task", async () => {
    await headerFor("tmpl-gone");
    expect(await screen.findByText("From a deleted template")).toBeTruthy();
  });

  it("says nothing about templates for a task created by hand", async () => {
    await headerFor(null);
    await screen.findByRole("button", { name: "Save as template" });
    expect(
      screen.queryByText(/^From (template|a deleted|a template)/),
    ).toBeNull();
  });

  /** The header while the template list is `listTemplates`' answer: never deleted until it is known. */
  async function headerWhile(listTemplates: JJApi["listTemplates"]) {
    const base = createDemoApi({ autoplay: false });
    const view: TaskView = await base.getTask("task-102");
    const api: JJApi = { ...base, listTemplates };
    function Loaded({ children }: { children: ReactNode }) {
      return useWorkspace().loading ? null : <>{children}</>;
    }
    render(
      <ApiProvider api={api}>
        <WorkspaceProvider>
          <TestShell>
            <Loaded>
              <TaskHeader
                view={{ ...view, task: { ...view.task, templateId: SEEDED } }}
              />
            </Loaded>
          </TestShell>
        </WorkspaceProvider>
      </ApiProvider>,
    );
    expect(await screen.findByText("From a template")).toBeTruthy();
  }

  it("says only that a task came from a template while the list is loading", async () => {
    const listTemplates = vi.fn(() => new Promise<never>(() => {}));
    await headerWhile(listTemplates);
    expect(listTemplates).toHaveBeenCalled();
    expect(screen.queryByText("From a deleted template")).toBeNull();
  });

  it("never calls a template deleted when the list failed to load", async () => {
    const listTemplates = vi.fn(() =>
      Promise.reject(
        Object.assign(new Error("The server failed."), {
          code: "INTERNAL",
          status: 500,
        }),
      ),
    );
    await headerWhile(listTemplates);
    await waitFor(() => expect(listTemplates).toHaveBeenCalled());
    // Let the rejection land before checking what the header says.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.getByText("From a template")).toBeTruthy();
    expect(screen.queryByText("From a deleted template")).toBeNull();
  });
});
