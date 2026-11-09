// @vitest-environment jsdom
import "../../test/dom";
import type { AuthSession, AuthState } from "@jj/contracts";
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiProvider } from "../../api/ApiContext";
import { ApiError, type JJApi, type SessionControls } from "../../api/client";
import { createDemoApi } from "../../api/demoApi";
import { SecurityPanel } from "./SecurityPanel";

const AT = "2026-11-09T10:00:00.000Z";
const session = (id: string, label: string, current: boolean): AuthSession => ({
  id,
  label,
  createdAt: AT,
  lastSeenAt: AT,
  expiresAt: "2026-12-09T10:00:00.000Z",
  current,
});

const required: AuthState = {
  required: true,
  authenticated: true,
  via: "cookie",
  methods: { token: true, password: true, passkey: false },
  session: session("auth_me", "Firefox on Linux", true),
};

/** The demo API with sign-in controls whose answers the test scripts. */
function withAuth(controls: Partial<SessionControls>): JJApi {
  const auth: SessionControls = {
    state: vi.fn(async () => required),
    login: vi.fn(),
    logout: vi.fn(async () => {}),
    sessions: vi.fn(async () => [
      session("auth_me", "Firefox on Linux", true),
      session("auth_phone", "Safari on iPhone", false),
    ]),
    signOut: vi.fn(async () => {}),
    signOutOthers: vi.fn(async () => {}),
    rotateToken: vi.fn(async () => "new-token-shown-once"),
    ended: vi.fn(),
    ...controls,
  };
  return Object.assign(Object.create(createDemoApi({ autoplay: false })), {
    mode: "live",
    auth,
  }) as JJApi;
}

const renderPanel = (api: JJApi) =>
  render(
    <ApiProvider api={api}>
      <SecurityPanel />
    </ApiProvider>,
  );

describe("Settings → Security", () => {
  it("lists the devices, and signs one out, the others, or this one", async () => {
    const api = withAuth({});
    renderPanel(api);
    const phone = await screen.findByRole("article", {
      name: "Safari on iPhone",
    });
    const mine = screen.getByRole("article", { name: "Firefox on Linux" });
    expect(within(mine).getByText("this device")).toBeTruthy();
    expect(within(phone).queryByText("this device")).toBeNull();

    fireEvent.click(within(phone).getByRole("button", { name: "Sign out" }));
    await waitFor(() =>
      expect(api.auth?.signOut).toHaveBeenCalledWith("auth_phone"),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Sign out other devices" }),
    );
    await waitFor(() => expect(api.auth?.signOutOthers).toHaveBeenCalled());
    fireEvent.click(within(mine).getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(api.auth?.ended).toHaveBeenCalled());
    expect(api.auth?.logout).toHaveBeenCalled();
  });

  it("rotates the token with the current one, and shows the new one once", async () => {
    const api = withAuth({});
    renderPanel(api);
    fireEvent.click(
      await screen.findByRole("button", { name: "Rotate token" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Rotate the access token",
    });
    fireEvent.change(within(dialog).getByLabelText("Current access token"), {
      target: { value: "old-token" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Rotate token" }),
    );
    const shown = await screen.findByRole("dialog", {
      name: "New access token",
    });
    expect(api.auth?.rotateToken).toHaveBeenCalledWith({ token: "old-token" });
    expect(
      (within(shown).getByLabelText("New token") as HTMLInputElement).value,
    ).toBe("new-token-shown-once");
    expect(within(shown).getByText(/shown this once/)).toBeTruthy();
    fireEvent.click(within(shown).getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(screen.queryByDisplayValue("new-token-shown-once")).toBeNull(),
    );
  });

  it("says when API_TOKEN sets the token, which cannot be rotated here", async () => {
    const api = withAuth({
      rotateToken: vi.fn(async () => {
        throw new ApiError(
          "CONFLICT",
          "API_TOKEN sets this server's token: change it there and restart the server, which signs out every device.",
          undefined,
          409,
        );
      }),
    });
    renderPanel(api);
    fireEvent.click(
      await screen.findByRole("button", { name: "Rotate token" }),
    );
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Current access token"), {
      target: { value: "env-token" },
    });
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Rotate token" }),
    );
    expect(await within(dialog).findByText(/API_TOKEN sets/)).toBeTruthy();
  });

  it("says a loopback server asks for no sign-in, and the demo has none", async () => {
    renderPanel(
      withAuth({
        state: vi.fn(async () => ({
          ...required,
          required: false,
          via: "none" as const,
          session: null,
        })),
      }),
    );
    expect(await screen.findByText(/asks for no sign-in/)).toBeTruthy();
    renderPanel(createDemoApi({ autoplay: false }));
    expect(screen.getByText(/demo data: it has no sign-in/)).toBeTruthy();
  });
});
