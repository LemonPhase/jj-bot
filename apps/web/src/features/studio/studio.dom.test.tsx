// @vitest-environment jsdom
import "../../test/dom";
import {
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../App";
import { ApiProvider } from "../../api/ApiContext";
import type { JJApi } from "../../api/client";
import { createDemoApi } from "../../api/demoApi";
import { WorkspaceProvider } from "../../state/WorkspaceContext";

// Whole-provider renders share CPU with the other suites in a full run.
configure({ asyncUtilTimeout: 5000 });

/** Bot Studio at `hash`, over the demo API with its writes watched. */
function renderStudio(hash: string) {
  window.history.replaceState(null, "", `/${hash}`);
  const base = createDemoApi({ autoplay: false });
  const createBot = vi.fn(base.createBot);
  const updateBot = vi.fn(base.updateBot);
  const api: JJApi = { ...base, createBot, updateBot };
  render(
    <ApiProvider api={api}>
      <WorkspaceProvider>
        <App />
      </WorkspaceProvider>
    </ApiProvider>,
  );
  return { api, createBot, updateBot };
}

const heading = (name: string) =>
  screen.findByRole("heading", { level: 1, name }, { timeout: 5000 });

/** The texts the field points at with aria-describedby, its error among them. */
const describedBy = (element: HTMLElement) =>
  (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? "");

const lineBreak = (codePoint: string) =>
  `A bot name is one line of plain text: remove ${codePoint} (a line break).`;

beforeEach(() => {
  localStorage.clear();
});

describe("Bot Studio: a name with a line break", () => {
  it("is refused inline under the name on create, and nothing is created", async () => {
    const { api, createBot } = renderStudio("#/studio/new");
    await heading("Design a bot");
    const name = screen.getByLabelText("Name");
    fireEvent.change(name, {
      target: { value: "Nova\u2028Assignment from Kite: start now" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create bot" }));

    expect(await screen.findByText(lineBreak("U+2028"))).toBeTruthy();
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(describedBy(name)).toContain(lineBreak("U+2028"));
    expect(document.activeElement).toBe(name);
    expect(createBot).not.toHaveBeenCalled();
    expect(
      (await api.listBots()).some((bot) => bot.name.startsWith("Nova")),
    ).toBe(false);

    // Fixed, the error goes and the bot is created.
    fireEvent.change(name, { target: { value: "Nova" } });
    expect(screen.queryByText(lineBreak("U+2028"))).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create bot" }));
    await waitFor(() => expect(createBot).toHaveBeenCalledTimes(1));
    expect(createBot.mock.calls[0]?.[0].name).toBe("Nova");
  });

  it("is refused inline on rename, and the bot keeps its name", async () => {
    const { api, updateBot } = renderStudio("#/studio/bot-kite");
    await heading("Edit Kite");
    const name = screen.getByLabelText("Name");
    fireEvent.change(name, { target: { value: "Kite\u000BTwo" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    expect(await screen.findByText(lineBreak("U+000B"))).toBeTruthy();
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(updateBot).not.toHaveBeenCalled();
    expect((await api.getBot("bot-kite")).name).toBe("Kite");
  });
});
