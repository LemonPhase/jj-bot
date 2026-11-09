// @vitest-environment jsdom
import "../../test/dom";
import {
  act,
  configure,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../App";
import { ApiProvider } from "../../api/ApiContext";
import { createDemoApi } from "../../api/demoApi";
import { WorkspaceProvider } from "../../state/WorkspaceContext";
import { parseRoute } from "./router";
import { preloadScreen } from "./screens";

/**
 * The first screen's on-demand parts, each a chunk held back: `started`
 * counts the times its module began loading, and it arrives on `arrive()`.
 */
const chunks = vi.hoisted(() => {
  const held = () => {
    let arrive = () => {};
    const arrived = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    return { started: 0, arrived, arrive: () => arrive() };
  };
  return { newTask: held(), inspector: held(), tasksSection: held() };
});

vi.mock("../tasks/NewTaskDialog", async () => {
  chunks.newTask.started += 1;
  await chunks.newTask.arrived;
  return { NewTaskDialog: () => <p>New task form</p> };
});
// The profile panel's chunk fails to arrive, as after a redeploy replaced it.
vi.mock("../bots/BotInspector", async () => {
  chunks.inspector.started += 1;
  await chunks.inspector.arrived;
  throw new TypeError("Failed to fetch dynamically imported module");
});
vi.mock("./TasksSection", async () => {
  chunks.tasksSection.started += 1;
  await chunks.tasksSection.arrived;
  return { TasksSection: () => <p>Tasks section</p> };
});
// The Tasks screen itself is not under test here.
vi.mock("../tasks/TasksScreen", () => ({ TasksScreen: () => "Tasks screen" }));

configure({ asyncUtilTimeout: 5000 });

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  localStorage.clear();
});

function renderAppAt(hash: string) {
  window.history.replaceState(null, "", `/${hash}`);
  render(
    <ApiProvider api={createDemoApi({ autoplay: false })}>
      <WorkspaceProvider>
        <App />
      </WorkspaceProvider>
    </ApiProvider>,
  );
}

const heading = (name: string) =>
  screen.findByRole("heading", { level: 1, name });

// Loaded modules stay loaded for the whole file, so each test holds parts of
// its own: the Bots screen's (the profile panel and the New task dialog),
// then the sidebar's Tasks section. Their background download is a prefetch
// the build adds to index.html (prefetch.test.ts), never an import here.
describe("the first screen's on-demand parts", () => {
  it("load the profile panel at boot when it was left open and the New task dialog when asked for, named while they load", async () => {
    // At boot: the profile panel, only when it was left open.
    preloadScreen(parseRoute("#/bots/bot-kite"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(chunks.inspector.started).toBe(0);
    localStorage.setItem("jj.bots.inspector", "open");
    preloadScreen(parseRoute("#/bots/bot-kite"));
    await vi.waitFor(() => expect(chunks.inspector.started).toBe(1));
    expect(chunks.newTask.started).toBe(0);

    renderAppAt("#/bots/bot-kite");
    await heading("Kite");
    const panel = screen.getByRole("complementary", {
      name: "Kite's profile",
    });
    expect(within(panel).getByRole("status").textContent).toBe(
      "Loading profile…",
    );

    // Nothing imports the New task dialog until it is asked for: a failed
    // background import would cost the click (Chromium keeps it).
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(chunks.newTask.started).toBe(0);
    expect(chunks.inspector.started).toBe(1);

    // Asked for, the dialog waits briefly for its chunk (from the prefetch
    // cache it arrives in time and opens complete); one that takes longer
    // opens with its name and a spinner.
    const chat = screen.getByRole("main", { name: "Chat with Kite" });
    fireEvent.click(within(chat).getByRole("button", { name: "New task" }));
    await vi.waitFor(() => expect(chunks.newTask.started).toBe(1));
    const loading = await screen.findByRole("dialog", { name: "New task" });
    expect(within(loading).getByRole("status").textContent).toBe("Loading…");
    act(() => chunks.newTask.arrive());
    expect(await screen.findByText("New task form")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "New task" })).toBeNull();
    expect(chunks.newTask.started).toBe(1);

    // A panel whose chunk does not arrive says so in place; the chat stays,
    // and the panel still closes.
    act(() => chunks.inspector.arrive());
    const alert = await screen.findByRole("alert");
    const failed = screen.getByRole("complementary", {
      name: "Kite's profile",
    });
    expect(failed.contains(alert)).toBe(true);
    expect(alert.textContent).toMatch(/^Couldn't loadthe profile: /);
    expect(within(failed).getByRole("button", { name: "Reload" })).toBeTruthy();
    expect(screen.getByRole("main", { name: "Chat with Kite" })).toBeTruthy();
    fireEvent.click(
      within(failed).getByRole("button", { name: "Close profile" }),
    );
    expect(
      screen.queryByRole("complementary", { name: "Kite's profile" }),
    ).toBeNull();
  });

  it("preload the sidebar's Tasks section with the Tasks screen, named while it loads", async () => {
    preloadScreen(parseRoute("#/tasks"));
    await vi.waitFor(() => expect(chunks.tasksSection.started).toBe(1));
    renderAppAt("#/tasks");
    const sidebar = await screen.findByRole("complementary", {
      name: "Navigation",
    });
    expect(await within(sidebar).findByText("Loading…")).toBeTruthy();
    act(() => chunks.tasksSection.arrive());
    expect(await within(sidebar).findByText("Tasks section")).toBeTruthy();
    expect(chunks.tasksSection.started).toBe(1);
  });
});
