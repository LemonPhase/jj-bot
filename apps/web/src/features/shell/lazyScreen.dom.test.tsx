// @vitest-environment jsdom
import "../../test/dom";
import { act, configure, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../App";
import { ApiProvider } from "../../api/ApiContext";
import { createDemoApi } from "../../api/demoApi";
import { WorkspaceProvider } from "../../state/WorkspaceContext";

// The Settings chunk fails to arrive, as after a redeploy replaced it.
vi.mock("../settings/SettingsScreen", () => {
  throw new TypeError("Failed to fetch dynamically imported module");
});

configure({ asyncUtilTimeout: 5000 });

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  localStorage.clear();
});

describe("lazy screens", () => {
  it("say a screen failed to load, keep the app, and recover on another screen", async () => {
    window.history.replaceState(null, "", "/#/settings");
    render(
      <ApiProvider api={createDemoApi({ autoplay: false })}>
        <WorkspaceProvider>
          <App />
        </WorkspaceProvider>
      </ApiProvider>,
    );
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/^Couldn't loadthis screen: /);
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    // The sidebar is still there, and another screen opens normally.
    const nav = screen.getByRole("navigation", { name: "Primary" });
    act(() => {
      window.location.hash = "#/studio";
    });
    expect(
      await screen.findByRole("heading", { level: 1, name: "Design a bot" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
    expect(within(nav).getByRole("button", { name: /^Bots/ })).toBeTruthy();
  });
});
