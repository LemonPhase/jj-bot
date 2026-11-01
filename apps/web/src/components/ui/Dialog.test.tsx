// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { flushTasks } from "../../test/dom";
import { Dialog } from "./Dialog";

function Harness({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <Dialog
        open={open}
        onClose={() => {
          onClose?.();
          setOpen(false);
        }}
        title="Delete profile?"
        description="Bots fall back to the default profile."
      >
        <input aria-label="Name" />
        <button type="button">Confirm</button>
      </Dialog>
    </>
  );
}

const dialogElement = () =>
  document.querySelector("dialog") as HTMLDialogElement;

describe("Dialog", () => {
  it("stays open when StrictMode runs its effects twice", async () => {
    const onClose = vi.fn();
    render(
      <StrictMode>
        <Dialog open onClose={onClose} title="Still here">
          <input aria-label="Name" />
        </Dialog>
      </StrictMode>,
    );
    await act(flushTasks);
    expect(onClose).not.toHaveBeenCalled();
    expect(dialogElement().open).toBe(true);
    expect(screen.getByRole("heading", { name: "Still here" })).toBeTruthy();
  });

  it("is named and described, and focuses the first field on open", async () => {
    render(
      <StrictMode>
        <Harness />
      </StrictMode>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await act(flushTasks);
    const dialog = dialogElement();
    expect(dialog.open).toBe(true);
    expect(
      document.getElementById(dialog.getAttribute("aria-labelledby") ?? "")
        ?.textContent,
    ).toBe("Delete profile?");
    expect(
      document.getElementById(dialog.getAttribute("aria-describedby") ?? "")
        ?.textContent,
    ).toBe("Bots fall back to the default profile.");
    expect(document.activeElement).toBe(screen.getByLabelText("Name"));
  });

  it("closes on Escape and returns focus to the opener", async () => {
    const onClose = vi.fn();
    render(
      <StrictMode>
        <Harness onClose={onClose} />
      </StrictMode>,
    );
    const opener = screen.getByRole("button", { name: "Open" });
    opener.focus();
    fireEvent.click(opener);
    await act(flushTasks);
    fireEvent.keyDown(screen.getByLabelText("Name"), { key: "Escape" });
    await act(flushTasks);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialogElement().open).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it("closes from the browser's cancel event (Escape via the platform)", async () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await act(flushTasks);
    const cancel = new Event("cancel", { cancelable: true });
    fireEvent(dialogElement(), cancel);
    await act(flushTasks);
    expect(cancel.defaultPrevented).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps Tab and Shift+Tab inside", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await act(flushTasks);
    const confirm = screen.getByRole("button", { name: "Confirm" });
    const close = screen.getByRole("button", { name: "Close" });
    confirm.focus();
    fireEvent.keyDown(confirm, { key: "Tab" });
    expect(document.activeElement).toBe(close);
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(confirm);
  });
});
