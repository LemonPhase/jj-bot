// @vitest-environment jsdom
import "../../test/dom";
import { configure, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../App";
import { ApiProvider } from "../../api/ApiContext";
import { createDemoApi } from "../../api/demoApi";
import { WorkspaceProvider } from "../../state/WorkspaceContext";
import { OFFICE_MODE_KEY } from "./playback";
import { no3dReason } from "./TaskOffice";

// Whole-provider renders share CPU with the other suites in a full run.
configure({ asyncUtilTimeout: 5000 });

describe("no3dReason", () => {
  it("offers 3D only with WebGL on a screen wider than a phone", () => {
    expect(no3dReason(false, () => true)).toBeNull();
    expect(no3dReason(false, () => false)).toBe(
      "3D needs WebGL, which this browser does not offer. The 2D office shows the same task.",
    );
  });

  it("asks a phone-width screen nothing about WebGL, so it makes no WebGL context", () => {
    const webgl = vi.fn(() => true);
    expect(no3dReason(true, webgl)).toBe(
      "3D needs a wider screen. The 2D office shows the same task.",
    );
    expect(webgl).not.toHaveBeenCalled();
  });
});

describe("the office without WebGL", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/#/tasks/task-102");
    localStorage.clear();
  });

  it("shows 2D, even when 3D was the last choice, and says why 3D is off", async () => {
    // jsdom has no WebGL, like a browser with it turned off.
    expect(typeof WebGLRenderingContext).toBe("undefined");
    localStorage.setItem(OFFICE_MODE_KEY, "3d");
    render(
      <ApiProvider api={createDemoApi({ autoplay: false })}>
        <WorkspaceProvider>
          <App />
        </WorkspaceProvider>
      </ApiProvider>,
    );
    fireEvent.click(await screen.findByRole("tab", { name: "Office" }));
    const views = await screen.findByRole("radiogroup", {
      name: "Office view",
    });
    const radio = (name: string) =>
      screen.getByRole("radio", { name }) as HTMLButtonElement;
    expect(radio("2D").getAttribute("aria-checked")).toBe("true");
    expect(radio("3D").disabled).toBe(true);
    const note = document.getElementById(
      views.getAttribute("aria-describedby") ?? "",
    );
    expect(note?.textContent).toBe(
      "3D needs WebGL, which this browser does not offer. The 2D office shows the same task.",
    );
    expect(
      screen.getByRole("img", {
        name: "Pixel office acting out the task conversation",
      }),
    ).toBeTruthy();
    // The choice is kept for a browser that can show it.
    expect(localStorage.getItem(OFFICE_MODE_KEY)).toBe("3d");
  });
});
