// @vitest-environment jsdom
import "../../test/dom";
import type { RuntimeProfile } from "@jj/contracts";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiProvider } from "../../api/ApiContext";
import type { JJApi } from "../../api/client";
import { createDemoApi } from "../../api/demoApi";
import { DEMO_DRIVERS } from "../../api/demoFixtures";
import { WorkspaceProvider } from "../../state/WorkspaceContext";
import { ProfileEditor } from "./ProfileEditor";

const describedBy = (element: HTMLElement) =>
  (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? "");

/** A new-profile form over the demo API, whose docker driver declares allowlist like the real one. */
function renderEditor() {
  const base = createDemoApi({ autoplay: false });
  const createProfile = vi.fn(base.createProfile);
  const api: JJApi = { ...base, createProfile };
  const onClose = vi.fn();
  render(
    <ApiProvider api={api}>
      <WorkspaceProvider>
        <ProfileEditor
          profile={null}
          drivers={DEMO_DRIVERS}
          onClose={onClose}
        />
      </WorkspaceProvider>
    </ApiProvider>,
  );
  return { createProfile, onClose };
}

describe("runtime profile editor: network allowlist", () => {
  it("offers allowlist for docker with a hosts editor that checks each line", async () => {
    const { createProfile, onClose } = renderEditor();
    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Registry only" },
    });
    expect(screen.queryByLabelText("Allowed hosts")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: "Allowlist" }));

    const hosts = screen.getByLabelText("Allowed hosts");
    expect(hosts.tagName).toBe("TEXTAREA");
    expect(hosts.getAttribute("placeholder")).toBe("registry.npmjs.org");
    expect(describedBy(hosts)).toContain(
      "One host per line, e.g. registry.npmjs.org or *.pythonhosted.org. Plain HTTP(S) only; private addresses are never reachable.",
    );

    fireEvent.change(hosts, {
      target: { value: "registry.npmjs.org\nhttps://pypi.org/simple" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));
    expect(
      await screen.findByText(
        "Line 2: write a host such as registry.npmjs.org or *.example.com, optionally with :port, without a scheme or path.",
      ),
    ).toBeDefined();
    expect(hosts.getAttribute("aria-invalid")).toBe("true");
    expect(createProfile).not.toHaveBeenCalled();

    fireEvent.change(hosts, {
      target: { value: "Registry.npmjs.org\n*.pythonhosted.org\n" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create profile" }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(createProfile.mock.calls[0]?.[0].sandbox).toMatchObject({
      driver: "docker",
      network: {
        mode: "allowlist",
        hosts: ["Registry.npmjs.org", "*.pythonhosted.org"],
      },
    });
    // The contract normalises what is stored.
    const created = (await createProfile.mock.results[0]
      ?.value) as RuntimeProfile;
    expect(created.sandbox.network).toEqual({
      mode: "allowlist",
      hosts: ["registry.npmjs.org", "*.pythonhosted.org"],
    });
  });
});
