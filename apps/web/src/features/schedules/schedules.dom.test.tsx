// @vitest-environment jsdom
import "../../test/dom";
import type {
  Schedule,
  ScheduleFire,
  ScheduleList as ScheduleListView,
  TaskView,
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
import { afterEach, describe, expect, it } from "vitest";
import { ApiProvider } from "../../api/ApiContext";
import type { JJApi } from "../../api/client";
import { createDemoApi } from "../../api/demoApi";
import { useWorkspace, WorkspaceProvider } from "../../state/WorkspaceContext";
import { stubShell, TestShell } from "../../test/shell";
import type { ShellActions } from "../shell/ShellContext";
import { TaskHeader } from "../tasks/TaskHeader";
import TemplateDialog from "../templates/TemplateDialog";
import { TemplateList } from "../templates/TemplateList";
import ScheduleDialog from "./ScheduleDialog";
import { ScheduleList } from "./ScheduleList";

configure({ asyncUtilTimeout: 5000 });

const SEEDED_TEMPLATE = "tmpl-demo-1";
const SEEDED_SCHEDULE = "sched-demo-1";

const demo = () => createDemoApi({ autoplay: false, tasks: [] });

afterEach(() => {
  window.location.hash = "";
});

/** Renders once the workspace and its schedules have loaded over `api`. */
function renderReady(
  ui: ReactNode,
  api: JJApi = demo(),
  shell: ShellActions = stubShell(),
) {
  function Ready({ children }: { children: ReactNode }) {
    const { loading, templates, schedules } = useWorkspace();
    return loading || templates === null || schedules === null ? null : (
      <>{children}</>
    );
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

const at = new Date().toISOString();
const fire = (patch: Partial<ScheduleFire>): ScheduleFire => ({
  id: `fire-${Math.random()}`,
  scheduleId: "s1",
  scheduledFor: at,
  recordedAt: at,
  outcome: "started",
  reason: null,
  missedCount: 0,
  taskId: null,
  code: null,
  ...patch,
});
const schedule = (patch: Partial<Schedule>): Schedule => ({
  id: "s1",
  name: "Digest",
  templateId: SEEDED_TEMPLATE,
  trigger: { kind: "cron", cron: "0 9 * * *", timeZone: "UTC" },
  instructions: "",
  enabled: true,
  overlap: "skip",
  keepWorkspaces: 10,
  chatUpdates: "attention",
  nextFireAt: "2030-01-02T09:00:00.000Z",
  pausedReason: null,
  lastFire: null,
  createdAt: at,
  updatedAt: at,
  ...patch,
});

/** The demo with its schedule list replaced by `list`. */
function withSchedules(list: ScheduleListView): JJApi {
  const base = demo();
  return { ...base, listSchedules: async () => list };
}

const fresh = () => ({
  lastPassAt: new Date().toISOString(),
  minIntervalMinutes: 60,
  graceMinutes: 60,
});

describe("the Schedules sidebar section", () => {
  it("lists each schedule with its next run, and opens the new, edit and delete dialogs", async () => {
    const { shell } = renderReady(<ScheduleList />);
    const section = await screen.findByRole("region", { name: "Schedules" });
    expect(within(section).getByText("Monday contract review")).toBeTruthy();
    expect(
      within(section).getByText(/^Next .* · Europe\/London$/),
    ).toBeTruthy();
    fireEvent.click(
      within(section).getByRole("button", {
        name: "Edit Monday contract review",
      }),
    );
    expect(shell.openScheduleDialog).toHaveBeenLastCalledWith({
      kind: "edit",
      scheduleId: SEEDED_SCHEDULE,
    });
    fireEvent.click(
      within(section).getByRole("button", {
        name: "Delete Monday contract review",
      }),
    );
    expect(shell.openScheduleDialog).toHaveBeenLastCalledWith({
      kind: "delete",
      scheduleId: SEEDED_SCHEDULE,
    });
    fireEvent.click(
      within(section).getByRole("button", { name: "New schedule" }),
    );
    expect(shell.openScheduleDialog).toHaveBeenLastCalledWith({ kind: "new" });
  });

  it("shows each last outcome, linking to the task it started or waited on", async () => {
    renderReady(
      <ScheduleList />,
      withSchedules({
        scheduler: fresh(),
        schedules: [
          schedule({
            id: "a",
            name: "Started one",
            lastFire: fire({ outcome: "started", taskId: "task-9" }),
          }),
          schedule({
            id: "b",
            name: "Skipped one",
            lastFire: fire({
              outcome: "skipped",
              taskId: "task-8",
              reason: "The previous run is waiting for your approval.",
            }),
          }),
          schedule({
            id: "c",
            name: "Missed one",
            lastFire: fire({ outcome: "missed", missedCount: 3 }),
          }),
          schedule({
            id: "d",
            name: "Refused one",
            lastFire: fire({
              outcome: "refused",
              code: "SPEND_CAP_REACHED",
              reason: "Kite reached its daily spend cap: $20.00 of $20.00.",
            }),
          }),
          schedule({
            id: "e",
            name: "Paused one",
            enabled: false,
            nextFireAt: null,
            pausedReason: "template_unusable",
          }),
          schedule({
            id: "f",
            name: "Too often one",
            enabled: false,
            nextFireAt: null,
            pausedReason: "interval_too_short",
          }),
          schedule({
            id: "g",
            name: "Off one",
            enabled: false,
            nextFireAt: null,
          }),
        ],
      }),
    );
    const row = async (name: string) =>
      (await screen.findByText(name)).closest("li") as HTMLElement;
    const started = await row("Started one");
    expect(started.textContent).toContain("Started opened a task");
    expect(
      within(started).getByRole("link", { name: "opened a task" }),
    ).toHaveProperty("hash", "#/tasks/task-9");
    const skipped = await row("Skipped one");
    expect(skipped.textContent).toContain("Skipped waiting for your approval");
    expect(within(skipped).getByRole("link").getAttribute("href")).toBe(
      "#/tasks/task-8",
    );
    expect((await row("Missed one")).textContent).toContain(
      "Missed 3 runs: the server was down",
    );
    expect((await row("Refused one")).textContent).toContain(
      "Refused Kite reached its daily spend cap",
    );
    expect((await row("Paused one")).textContent).toContain(
      "Paused: its template could not start",
    );
    expect((await row("Too often one")).textContent).toContain(
      "Paused: its times are closer than this server's minimum",
    );
    expect((await row("Off one")).textContent).toContain("Off");
  });

  it("warns while the scheduler's last pass is more than 2 minutes old", async () => {
    renderReady(
      <ScheduleList />,
      withSchedules({
        scheduler: {
          ...fresh(),
          lastPassAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        },
        schedules: [schedule({})],
      }),
    );
    expect((await screen.findByRole("status")).textContent).toMatch(
      /The scheduler last ran 5 minutes ago: schedules start only while the server's worker runs\./,
    );
  });

  it("says nothing while the scheduler passes, or while no schedule is on", async () => {
    renderReady(
      <ScheduleList />,
      withSchedules({ scheduler: fresh(), schedules: [schedule({})] }),
    );
    await screen.findByText("Digest");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("offers Schedule… on each template", async () => {
    const { shell } = renderReady(<TemplateList />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Schedule Weekly contract review",
      }),
    );
    expect(shell.openScheduleDialog).toHaveBeenLastCalledWith({
      kind: "new",
      templateId: SEEDED_TEMPLATE,
    });
  });

  it("is not shown by a server that reports no schedules", async () => {
    const base = demo();
    const api: JJApi = {
      ...base,
      capabilities: { ...base.capabilities, schedules: false },
    };
    function Loaded({ children }: { children: ReactNode }) {
      const { loading, templates } = useWorkspace();
      return loading || templates === null ? null : <>{children}</>;
    }
    render(
      <ApiProvider api={api}>
        <WorkspaceProvider>
          <TestShell>
            <Loaded>
              <ScheduleList />
              <TemplateList />
            </Loaded>
          </TestShell>
        </WorkspaceProvider>
      </ApiProvider>,
    );
    await screen.findByRole("region", { name: "Templates" });
    expect(screen.queryByRole("region", { name: "Schedules" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Schedule / })).toBeNull();
  });
});

describe("the schedule editor", () => {
  const open = (api = demo()) =>
    renderReady(
      <ScheduleDialog
        request={{ kind: "new", templateId: SEEDED_TEMPLATE }}
        onClose={() => {}}
      />,
      api,
    );

  it("fills the cron field from a preset and previews the next 3 runs in the zone", async () => {
    open();
    const cron = (await screen.findByLabelText("Cron")) as HTMLInputElement;
    const zone = screen.getByLabelText("Time zone") as HTMLInputElement;
    fireEvent.change(zone, { target: { value: "UTC" } });
    expect(cron.value).toBe("0 9 * * *");
    fireEvent.click(screen.getByRole("radio", { name: "Weekdays" }));
    expect(cron.value).toBe("0 9 * * 1-5");
    fireEvent.click(screen.getByRole("radio", { name: "Hourly" }));
    expect(cron.value).toBe("0 * * * *");
    const runs = () =>
      [...document.querySelectorAll(".schedule-editor__runs time")].map(
        (time) => time.getAttribute("datetime") ?? "",
      );
    expect(runs()).toHaveLength(3);
    for (const run of runs()) expect(run).toMatch(/T\d\d:00:00\.000Z$/);
    const [first, second, third] = runs().map(Date.parse) as [
      number,
      number,
      number,
    ];
    expect(first).toBeGreaterThan(Date.now());
    expect([second - first, third - second]).toEqual([3_600_000, 3_600_000]);
    // A custom expression switches the preset to Custom.
    fireEvent.change(cron, { target: { value: "15 6 * * 0" } });
    expect(
      screen
        .getByRole("radio", { name: "Custom" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    for (const run of runs()) expect(new Date(run).getUTCDay()).toBe(0);
  });

  it("refuses inline what the server would: a gap under the minimum, a time that never comes, a bad zone", async () => {
    open();
    const cron = await screen.findByLabelText("Cron");
    const zone = screen.getByLabelText("Time zone");
    const save = screen.getByRole("button", { name: "Save schedule" });
    fireEvent.change(zone, { target: { value: "UTC" } });
    fireEvent.change(cron, { target: { value: "*/30 * * * *" } });
    expect(
      await screen.findByText(
        "This schedule runs 30 minutes apart at times, under this server's minimum of 60 minutes between runs.",
      ),
    ).toBeTruthy();
    expect(save).toHaveProperty("disabled", true);
    fireEvent.change(cron, { target: { value: "0 0 30 2 *" } });
    expect(
      await screen.findByText(
        "This schedule never runs: no time in the next 8 years matches it.",
      ),
    ).toBeTruthy();
    fireEvent.change(cron, { target: { value: "@daily" } });
    expect(await screen.findByText(/Macros such as @daily/)).toBeTruthy();
    fireEvent.change(cron, { target: { value: "0 9 * * *" } });
    fireEvent.change(zone, { target: { value: "Mars/Base" } });
    expect(
      await screen.findByText(
        /This browser does not know the time zone "Mars\/Base"/,
      ),
    ).toBeTruthy();
    expect(save).toHaveProperty("disabled", true);
    fireEvent.change(zone, { target: { value: "Europe/London" } });
    expect(save).toHaveProperty("disabled", false);
  });

  it("saves a schedule the list then shows", async () => {
    const api = demo();
    let closed = false;
    renderReady(
      <>
        <ScheduleDialog
          request={{ kind: "new" }}
          onClose={() => {
            closed = true;
          }}
        />
        <ScheduleList />
      </>,
      api,
    );
    const name = await screen.findByLabelText("Name");
    fireEvent.change(name, { target: { value: "Evening digest" } });
    fireEvent.change(screen.getByLabelText("Time zone"), {
      target: { value: "America/New_York" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));
    expect(await screen.findByText("Evening digest")).toBeTruthy();
    expect(closed).toBe(true);
    const saved = (await api.listSchedules()).schedules.find(
      (entry) => entry.name === "Evening digest",
    );
    expect(saved).toMatchObject({
      templateId: SEEDED_TEMPLATE,
      trigger: { cron: "0 9 * * *", timeZone: "America/New_York" },
      enabled: true,
      keepWorkspaces: 10,
      chatUpdates: "attention",
    });
  });

  it("warns of a template without a cap, and shows the server's refusal", async () => {
    const api = demo();
    const template = await api.createTemplate({
      title: "Uncapped",
      goal: "Write it.",
      coordinatorBotId: "bot-kite",
      spendCapUsd: null,
    });
    renderReady(
      <ScheduleDialog
        request={{ kind: "new", templateId: template.id }}
        onClose={() => {}}
      />,
      api,
    );
    expect(
      await screen.findByText(/Tasks from this template have no spend cap/),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Time zone"), {
      target: { value: "UTC" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));
    const refusal = await screen.findByRole("alert");
    expect(refusal.textContent).toMatch(
      /Not saved.*starts tasks with no spend cap, and a scheduled task needs one/,
    );
    expect((await api.listSchedules()).schedules).toHaveLength(1);
  });

  it("edits a schedule, keeping what it does not change", async () => {
    const api = demo();
    renderReady(
      <ScheduleDialog
        request={{ kind: "edit", scheduleId: SEEDED_SCHEDULE }}
        onClose={() => {}}
      />,
      api,
    );
    expect(
      ((await screen.findByLabelText("Cron")) as HTMLInputElement).value,
    ).toBe("0 9 * * 1");
    expect(
      screen
        .getByRole("radio", { name: "Weekly" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(screen.getByRole("radio", { name: "Every update" }));
    fireEvent.click(screen.getByRole("button", { name: "Save schedule" }));
    await waitFor(async () =>
      expect(
        (await api.getSchedule(SEEDED_SCHEDULE)).schedule.chatUpdates,
      ).toBe("all"),
    );
    expect((await api.getSchedule(SEEDED_SCHEDULE)).schedule.trigger).toEqual({
      kind: "cron",
      cron: "0 9 * * 1",
      timeZone: "Europe/London",
    });
  });

  it("confirms a deletion", async () => {
    const api = demo();
    let closed = false;
    renderReady(
      <ScheduleDialog
        request={{ kind: "delete", scheduleId: SEEDED_SCHEDULE }}
        onClose={() => {
          closed = true;
        }}
      />,
      api,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete schedule" }),
    );
    await waitFor(() => expect(closed).toBe(true));
    expect((await api.listSchedules()).schedules).toEqual([]);
  });
});

describe("deleting a template a schedule starts", () => {
  it("shows the server's TEMPLATE_IN_USE refusal and keeps the template", async () => {
    const api = demo();
    renderReady(
      <TemplateDialog
        request={{ kind: "delete", templateId: SEEDED_TEMPLATE }}
        onClose={() => {}}
      />,
      api,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Delete template" }),
    );
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Not deleted.*started by the schedule "Monday contract review"/,
    );
    expect((await api.listTemplates()).map((entry) => entry.id)).toContain(
      SEEDED_TEMPLATE,
    );
  });
});

describe("a scheduled task's header", () => {
  it("reads Scheduled · its schedule's name, or deleted", async () => {
    const api = createDemoApi({ autoplay: false });
    const view: TaskView = await api.getTask("task-102");
    renderReady(
      <TaskHeader
        view={{ ...view, task: { ...view.task, scheduleId: SEEDED_SCHEDULE } }}
      />,
      api,
    );
    expect(
      await screen.findByText("Scheduled · Monday contract review"),
    ).toBeTruthy();
  });

  it("names a deleted schedule as such, and says nothing for a task started otherwise", async () => {
    const api = createDemoApi({ autoplay: false });
    const view: TaskView = await api.getTask("task-102");
    renderReady(
      <>
        <TaskHeader
          view={{ ...view, task: { ...view.task, scheduleId: "sched-gone" } }}
        />
        <TaskHeader view={view} />
      </>,
      api,
    );
    expect(await screen.findAllByText("Scheduled · deleted")).toHaveLength(1);
  });
});
