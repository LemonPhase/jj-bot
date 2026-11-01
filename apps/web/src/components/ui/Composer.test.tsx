// @vitest-environment jsdom
import "../../test/dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";

const field = () =>
  screen.getByRole("textbox", { name: "Message Juno" }) as HTMLTextAreaElement;
const send = () =>
  screen.getByRole("button", { name: "Send" }) as HTMLButtonElement;

describe("Composer", () => {
  it("labels the field and can only send once there is text", () => {
    render(
      <Composer
        label="Message Juno"
        placeholder="Message Juno…"
        onSubmit={() => {}}
      />,
    );
    expect(field().placeholder).toBe("Message Juno…");
    expect(send().disabled).toBe(true);
    fireEvent.change(field(), { target: { value: "   " } });
    expect(send().disabled).toBe(true);
    fireEvent.change(field(), { target: { value: "hi" } });
    expect(send().disabled).toBe(false);
  });

  it("sends the trimmed text on Enter and clears; Shift+Enter and IME do not send", () => {
    const onSubmit = vi.fn();
    render(<Composer label="Message Juno" onSubmit={onSubmit} />);
    fireEvent.change(field(), { target: { value: "  hello  " } });
    fireEvent.keyDown(field(), { key: "Enter", shiftKey: true });
    fireEvent.keyDown(field(), { key: "Enter", isComposing: true });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("hello");
    expect(field().value).toBe("");
  });

  it("sends with the button too", () => {
    const onSubmit = vi.fn();
    render(<Composer label="Message Juno" onSubmit={onSubmit} />);
    fireEvent.change(field(), { target: { value: "ship it" } });
    fireEvent.click(send());
    expect(onSubmit).toHaveBeenCalledWith("ship it");
  });

  it("puts the text back when the send fails", async () => {
    let settle: (ok: boolean) => void = () => {};
    render(
      <Composer
        label="Message Juno"
        onSubmit={() =>
          new Promise<boolean>((resolve) => {
            settle = resolve;
          })
        }
      />,
    );
    fireEvent.change(field(), { target: { value: "try again" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(field().value).toBe("");
    await act(async () => settle(false));
    expect(field().value).toBe("try again");
  });

  it("waits while sending and refuses input when disabled", () => {
    const onSubmit = vi.fn();
    const { rerender } = render(
      <Composer label="Message Juno" sending onSubmit={onSubmit} />,
    );
    fireEvent.change(field(), { target: { value: "queued" } });
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
    expect(field().value).toBe("queued");
    rerender(
      <Composer
        label="Message Juno"
        variant="task"
        disabled
        leading={<button type="button">steer</button>}
        onSubmit={onSubmit}
      />,
    );
    expect(field().disabled).toBe(true);
    expect(send().disabled).toBe(true);
    expect(screen.getByRole("button", { name: "steer" })).toBeTruthy();
  });
});
