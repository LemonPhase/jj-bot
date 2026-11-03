// @vitest-environment jsdom
import "../../test/dom";
import { act, configure, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../App";
import { ApiProvider } from "../../api/ApiContext";
import { createDemoApi } from "../../api/demoApi";
import { WorkspaceProvider } from "../../state/WorkspaceContext";
import { parseRoute } from "./router";
import { preloadScreen } from "./screens";

/**
 * Each lazy screen's chunk, held back: `started` counts the times its module
 * began loading, and it arrives on `arrive()`.
 */
const chunks = vi.hoisted(() => {
  const held = () => {
    let arrive = () => {};
    const arrived = new Promise<void>((resolve) => {
      arrive = resolve;
    });
    return { started: 0, arrived, arrive: () => arrive() };
  };
  return { tasks: held(), studio: held(), settings: held() };
});

vi.mock("../tasks/TasksScreen", async () => {
  chunks.tasks.started += 1;
  await chunks.tasks.arrived;
  return { TasksScreen: () => "Tasks screen" };
});
vi.mock("../settings/SettingsScreen", async () => {
  chunks.settings.started += 1;
  await chunks.settings.arrived;
  return { SettingsScreen: () => "Settings screen" };
});
// Studio's chunk fails to arrive, as after a redeploy replaced it.
vi.mock("../studio/StudioScreen", async () => {
  chunks.studio.started += 1;
  await chunks.studio.arrived;
  throw new TypeError("Failed to fetch dynamically imported module");
});

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

/** The spinner shown while a screen's chunk loads, found by its label. */
async function loadingStatus(label: string) {
  const text = await screen.findByText(label);
  const status = text.closest('[role="status"]');
  expect(status?.textContent).toBe(label);
  return status;
}

describe("lazy screens", () => {
  it("preload the deep-linked screen's chunk before anything renders, and name it while it loads", async () => {
    preloadScreen(parseRoute("#/bots/bot-1"));
    preloadScreen(parseRoute("#/settings"));
    await vi.waitFor(() => expect(chunks.settings.started).toBe(1));
    expect(chunks.tasks.started).toBe(0);
    expect(chunks.studio.started).toBe(0);

    renderAppAt("#/settings");
    await loadingStatus("Loading Settings…");
    act(() => chunks.settings.arrive());
    expect(await screen.findByText("Settings screen")).toBeTruthy();
    expect(screen.queryByText("Loading Settings…")).toBeNull();
    expect(chunks.settings.started).toBe(1);
  });

  it("load a screen opened without a preload when it renders, named while it loads", async () => {
    expect(chunks.tasks.started).toBe(0);
    renderAppAt("#/tasks");
    await loadingStatus("Loading Tasks…");
    expect(chunks.tasks.started).toBe(1);
    act(() => chunks.tasks.arrive());
    expect(await screen.findByText("Tasks screen")).toBeTruthy();
  });

  it("report a preloaded chunk that fails in the screen, not as an unhandled rejection", async () => {
    preloadScreen(parseRoute("#/studio/new"));
    await vi.waitFor(() => expect(chunks.studio.started).toBe(1));
    // It fails before the screen renders, while the workspace would still
    // be loading: nothing but the preload holds the rejection yet.
    chunks.studio.arrive();
    await new Promise((resolve) => setTimeout(resolve, 50));
    renderAppAt("#/studio/new");
    const alert = await screen.findByRole("alert");
    // Vitest words the mock's failure its own way; the boundary shows it.
    expect(alert.textContent).toMatch(/^Couldn't loadthis screen: /);
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  });
});
