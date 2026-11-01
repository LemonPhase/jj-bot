// @vitest-environment jsdom
import "../../test/dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../App";
import { ApiProvider } from "../../api/ApiContext";
import { ApiError, type JJApi } from "../../api/client";
import { createDemoApi } from "../../api/demoApi";
import { WorkspaceProvider } from "../../state/WorkspaceContext";

/** The whole app over the in-memory demo API, as the browser runs it. */
function renderApp(overrides: Partial<JJApi> = {}) {
  const base = createDemoApi({ autoplay: false, replyMs: 40 });
  const api: JJApi = { ...base, ...overrides };
  render(
    <ApiProvider api={api}>
      <WorkspaceProvider>
        <App />
      </WorkspaceProvider>
    </ApiProvider>,
  );
  return api;
}

const heading = (name: string | RegExp) =>
  screen.findByRole("heading", { level: 1, name });

const primaryNav = () => screen.getByRole("navigation", { name: "Primary" });

/** Types into a labelled field and sends it with Enter, as in the composer. */
function send(label: string, text: string) {
  const field = screen.getByLabelText(label);
  fireEvent.change(field, { target: { value: text } });
  fireEvent.keyDown(field, { key: "Enter" });
}

const click = (element: HTMLElement) => fireEvent.click(element);

beforeEach(() => {
  window.history.replaceState(null, "", "/");
  localStorage.clear();
});

describe("routing", () => {
  it("canonicalises the hash in place, then moves back and forward", async () => {
    window.history.replaceState(null, "", "/#bots/bot-juno/");
    const length = window.history.length;
    renderApp();
    await heading("Juno");
    expect(window.location.hash).toBe("#/bots/bot-juno");
    // Both rewrites replaced the entry: nothing to go back to that was not typed.
    expect(window.history.length).toBe(length);

    click(
      within(
        screen.getByRole("complementary", { name: "Navigation" }),
      ).getByRole("button", { name: /^Kite/ }),
    );
    await heading("Kite");
    expect(window.location.hash).toBe("#/bots/bot-kite");

    act(() => window.history.back());
    await heading("Juno");
    expect(window.location.hash).toBe("#/bots/bot-juno");
    act(() => window.history.forward());
    await heading("Kite");
  });

  it("marks neither list as the current page on Studio or Settings", async () => {
    window.history.replaceState(null, "", "/#/settings");
    renderApp();
    await heading("Settings");
    expect(
      within(primaryNav()).queryByRole("button", { current: "page" }),
    ).toBeNull();
    act(() => {
      window.location.hash = "#/studio";
    });
    const length = window.history.length;
    await heading("Design a bot");
    await waitFor(() => expect(window.location.hash).toBe("#/studio/new"));
    expect(window.history.length).toBe(length);
    expect(
      within(primaryNav()).queryByRole("button", { current: "page" }),
    ).toBeNull();
  });

  it("says when a bot to edit does not exist", async () => {
    window.history.replaceState(null, "", "/#/studio/bot-nope");
    renderApp();
    expect(
      await screen.findByText("This bot does not exist or was archived."),
    ).toBeTruthy();
  });

  it("shows a load failure, not an empty workspace, and retries", async () => {
    window.history.replaceState(null, "", "/#/bots");
    const real = createDemoApi({ autoplay: false });
    let attempts = 0;
    renderApp({
      bootstrap: async () => {
        attempts += 1;
        if (attempts === 1)
          throw new ApiError("NETWORK_ERROR", "Can't reach the JJ Bot API.");
        return real.bootstrap();
      },
    });
    expect(await screen.findByText("Can't reach the JJ Bot API.")).toBeTruthy();
    expect(screen.queryByText(/No bots yet/)).toBeNull();
    click(screen.getByRole("button", { name: "Retry" }));
    await heading("Juno");
  });
});

describe("direct chat", () => {
  it("keeps the sent message on screen through replying to the reply", async () => {
    window.history.replaceState(null, "", "/#/bots/bot-kite");
    const base = createDemoApi({ autoplay: false, replyMs: 150 });
    const getConversation = vi.fn(base.getConversation);
    const delay = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));
    renderApp({
      ...base,
      getConversation,
      // The POST takes a moment, and fetched views lag behind it.
      sendBotMessage: async (botId, command) => {
        await delay(30);
        return base.sendBotMessage(botId, command);
      },
      subscribeConversation: (botId, onView, options) =>
        base.subscribeConversation(
          botId,
          (view) => void delay(80).then(() => onView(view)),
          options,
        ),
    });
    await heading("Kite");
    const log = await screen.findByRole("log", { name: "Messages with Kite" });
    const status = log.parentElement?.querySelector(
      '[role="status"]',
    ) as HTMLElement;
    expect(status.textContent).toBe("");

    send("Message Kite", "Hello Kite");
    // Pending: shown, but hidden from assistive technology so it is announced once.
    const pending = within(log).getByText("Hello Kite").closest(".chat-msg");
    expect(pending?.getAttribute("aria-hidden")).toBe("true");
    expect(status.textContent).toContain("Kite is replying");

    // The send returned; no fetched view has the message yet, and it stays.
    await act(() => delay(45));
    const stored = within(log).getByText("Hello Kite").closest(".chat-msg");
    expect(stored?.getAttribute("aria-hidden")).toBeNull();
    expect(status.textContent).toContain("Kite is replying");
    expect(within(log).getAllByText("Hello Kite")).toHaveLength(1);

    expect(await within(log).findByText(/scripted demo reply/)).toBeTruthy();
    await waitFor(() => expect(status.textContent).toBe(""));
    expect(within(log).getAllByText("Hello Kite")).toHaveLength(1);
    // The hint-driven refetch is the only one; the send adds none of its own.
    expect(getConversation).not.toHaveBeenCalled();
  });

  it("shows a failed reply, but not while the next message is on its way", async () => {
    window.history.replaceState(null, "", "/#/bots/bot-kite");
    const base = createDemoApi({ autoplay: false, replyMs: 60 });
    let releaseSend = () => {};
    renderApp({
      ...base,
      sendBotMessage: async (botId, command) => {
        await new Promise<void>((resolve) => {
          releaseSend = resolve;
        });
        return base.sendBotMessage(botId, command);
      },
      // The demo never fails a reply; this one always reports the last as failed.
      subscribeConversation: (botId, onView, options) =>
        base.subscribeConversation(
          botId,
          (view) =>
            onView({
              ...view,
              lastReplyError: {
                message: "The model timed out.",
                at: "2026-10-31T12:00:00.000Z",
              },
            }),
          options,
        ),
    });
    await heading("Kite");
    expect(await screen.findByText("The model timed out.")).toBeTruthy();
    send("Message Kite", "Hi again");
    // Still pending: the old failure is stale and hidden.
    expect(screen.queryByText("The model timed out.")).toBeNull();
    await act(async () => releaseSend());
    expect(screen.queryByText("The model timed out.")).toBeNull();
    // The new reply "fails" too, and that one shows.
    expect(await screen.findByText("The model timed out.")).toBeTruthy();
  });

  it("fills in a new task card at once", async () => {
    window.history.replaceState(null, "", "/#/bots/bot-kite");
    renderApp();
    await heading("Kite");
    send("Message Kite", "Write the release notes");
    const card = await screen.findByRole("link", {
      name: /Write the release notes/,
    });
    expect(card.textContent).not.toContain("Open the task");
  });
});

describe("bot inspector", () => {
  it("archives a bot, opens the next one and focuses its heading", async () => {
    window.history.replaceState(null, "", "/#/bots/bot-kite");
    renderApp();
    await heading("Kite");
    click(screen.getByRole("button", { name: "Profile" }));
    click(screen.getByRole("button", { name: "Archive bot" }));
    const dialog = await screen.findByRole("dialog", { name: "Archive Kite?" });
    click(within(dialog).getByRole("button", { name: "Archive" }));
    const next = await heading("Juno");
    expect(window.location.hash).toBe("#/bots/bot-juno");
    await waitFor(() => expect(document.activeElement).toBe(next));
    expect(screen.queryByRole("button", { name: /^Kite/ })).toBeNull();
  });

  it("shows form errors in place and only sends what changed", async () => {
    window.history.replaceState(null, "", "/#/bots/bot-kite");
    let memoryCalls = 0;
    const base = createDemoApi({ autoplay: false });
    const updateBot = vi.fn(async () => {
      throw new ApiError("VALIDATION_FAILED", "Role is too long.");
    });
    renderApp({
      updateBot,
      getMemory: async (botId) => {
        memoryCalls += 1;
        if (memoryCalls === 1)
          throw new ApiError("INTERNAL", "Memory store unavailable.");
        return base.getMemory(botId);
      },
      archiveBot: async () => {
        throw new ApiError("CONFLICT", "Kite is still in 1 active task(s).");
      },
    });
    await heading("Kite");
    click(screen.getByRole("button", { name: "Profile" }));

    // Memory: the load failure is shown with a retry, which recovers.
    expect(
      await screen.findByText(
        /Memory did not load: Memory store unavailable\./,
      ),
    ).toBeTruthy();
    const memory = screen.getByLabelText("Memory") as HTMLTextAreaElement;
    expect(memory.disabled).toBe(true);
    click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(memory.disabled).toBe(false));
    expect(screen.queryByText(/Memory did not load/)).toBeNull();

    // Details: only the edited field is sent, and the refusal shows in place.
    fireEvent.change(screen.getByLabelText("Role"), {
      target: { value: "Research lead" },
    });
    click(screen.getByRole("button", { name: "Save details" }));
    expect(await screen.findByText("Role is too long.")).toBeTruthy();
    expect(updateBot).toHaveBeenCalledWith("bot-kite", {
      role: "Research lead",
    });

    // Archive: the refusal shows in the dialog and is gone when it reopens.
    click(screen.getByRole("button", { name: "Archive bot" }));
    let dialog = await screen.findByRole("dialog", { name: "Archive Kite?" });
    click(within(dialog).getByRole("button", { name: "Archive" }));
    expect(
      await within(dialog).findByText("Kite is still in 1 active task(s)."),
    ).toBeTruthy();
    click(within(dialog).getByRole("button", { name: "Cancel" }));
    click(screen.getByRole("button", { name: "Archive bot" }));
    dialog = await screen.findByRole("dialog", { name: "Archive Kite?" });
    expect(within(dialog).queryByText(/still in 1 active task/)).toBeNull();
  });
});
