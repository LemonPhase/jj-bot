// @vitest-environment jsdom
import "../../test/dom";
import {
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../../App";
import { ApiProvider } from "../../api/ApiContext";
import { createDemoApi } from "../../api/demoApi";
import { NARROW_QUERY, resetMediaQueries } from "../../lib/media";
import { WorkspaceProvider } from "../../state/WorkspaceContext";

// Whole-provider renders share CPU with the other suites in a full run.
configure({ asyncUtilTimeout: 5000 });

const original = window.matchMedia;

/** A phone-width window: only the narrow query matches. */
function phoneWidth() {
  window.matchMedia = ((media: string) => ({
    matches: media === NARROW_QUERY,
    media,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  })) as unknown as typeof window.matchMedia;
}

function renderApp() {
  render(
    <ApiProvider api={createDemoApi({ autoplay: false, replyMs: 40 })}>
      <WorkspaceProvider>
        <App />
      </WorkspaceProvider>
    </ApiProvider>,
  );
}

const heading = (name: string | RegExp) =>
  screen.findByRole("heading", { level: 1, name }, { timeout: 5000 });
const menuButton = () => screen.getByRole("button", { name: /^Menu$/ });
const drawer = () => document.querySelector("dialog.shell-drawer");

beforeEach(() => {
  window.history.replaceState(null, "", "/#/bots/bot-juno");
  localStorage.clear();
  phoneWidth();
  resetMediaQueries();
});

afterEach(() => {
  window.matchMedia = original;
  resetMediaQueries();
});

describe("the phone menu", () => {
  it("replaces the sidebar with a top bar that keeps the mode badge in view", async () => {
    renderApp();
    await heading("Juno");
    expect(
      screen.queryByRole("complementary", { name: "Navigation" }),
    ).toBeNull();
    const bar = menuButton().closest("header") as HTMLElement;
    expect(within(bar).getByText("Demo data")).toBeTruthy();
    expect(menuButton().getAttribute("aria-expanded")).toBe("false");
    expect(menuButton().getAttribute("aria-controls")).toBe(drawer()?.id);
  });

  it("opens with focus inside, keeps open across the Bots/Tasks switch and closes on a row", async () => {
    renderApp();
    await heading("Juno");
    fireEvent.click(menuButton());
    expect(drawer()?.hasAttribute("open")).toBe(true);
    expect(menuButton().getAttribute("aria-expanded")).toBe("true");
    const nav = screen.getByRole("complementary", { name: "Navigation" });
    expect(drawer()?.contains(document.activeElement)).toBe(true);

    // The other list, still in the drawer.
    fireEvent.click(
      within(
        within(nav).getByRole("navigation", { name: "Primary" }),
      ).getByRole("button", { name: /^Tasks/ }),
    );
    await heading(/Check that the task stream resumes/);
    expect(drawer()?.hasAttribute("open")).toBe(true);

    // A row opens its task and folds the drawer away, focus back on the menu.
    fireEvent.click(
      within(within(nav).getByRole("list", { name: "Tasks" })).getAllByRole(
        "button",
      )[1] as HTMLElement,
    );
    await waitFor(() => expect(drawer()?.hasAttribute("open")).toBe(false));
    expect(document.activeElement).toBe(menuButton());
    expect(menuButton().getAttribute("aria-expanded")).toBe("false");
  });

  it("closes on Escape, on its close button and for the New task dialog", async () => {
    renderApp();
    await heading("Juno");
    fireEvent.click(menuButton());
    fireEvent(drawer() as Element, new Event("cancel", { cancelable: true }));
    await waitFor(() => expect(drawer()?.hasAttribute("open")).toBe(false));
    expect(document.activeElement).toBe(menuButton());

    fireEvent.click(menuButton());
    fireEvent.click(screen.getByRole("button", { name: "Close menu" }));
    await waitFor(() => expect(drawer()?.hasAttribute("open")).toBe(false));

    fireEvent.click(menuButton());
    fireEvent.click(
      within(screen.getByRole("navigation", { name: "Primary" })).getByRole(
        "button",
        { name: /^Tasks/ },
      ),
    );
    await heading(/Check that the task stream resumes/);
    fireEvent.click(
      within(
        screen.getByRole("complementary", { name: "Navigation" }),
      ).getByRole("button", { name: "New task" }),
    );
    await waitFor(() => expect(drawer()?.hasAttribute("open")).toBe(false));
    expect(
      await screen.findByRole("dialog", { name: "New task" }),
    ).toBeTruthy();
  });
});
