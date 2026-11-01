// @vitest-environment jsdom
import "../../test/dom";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CardButton } from "./Card";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import { ListItem } from "./ListItem";
import { StatusTag } from "./Status";
import { Tooltip } from "./Tooltip";

afterEach(() => {
  vi.useRealTimers();
});

const bubble = () => document.querySelector<HTMLElement>('[role="tooltip"]');

describe("Tooltip", () => {
  it("stays open while the pointer is on the bubble and hides after a delay", () => {
    vi.useFakeTimers();
    render(
      <Tooltip content="Switch views">
        <button type="button">2D</button>
      </Tooltip>,
    );
    const wrapper = screen.getByRole("button", { name: "2D" })
      .parentElement as HTMLElement;
    fireEvent.mouseEnter(wrapper);
    expect(bubble()?.hidden).toBe(false);
    // Leaving towards the bubble: a short delay, then re-entering keeps it.
    fireEvent.mouseLeave(wrapper);
    act(() => {
      vi.advanceTimersByTime(60);
    });
    fireEvent.mouseEnter(wrapper);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(bubble()?.hidden).toBe(false);
    fireEvent.mouseLeave(wrapper);
    act(() => {
      vi.advanceTimersByTime(500);
    });
    expect(bubble()?.hidden).toBe(true);
  });

  it("describes a focusable trigger and hides on Escape", () => {
    render(
      <Tooltip content="Switch views">
        <button type="button">2D</button>
      </Tooltip>,
    );
    const button = screen.getByRole("button", { name: "2D" });
    expect(button.getAttribute("aria-describedby")).toBe(bubble()?.id);
    fireEvent.focus(button);
    expect(bubble()?.hidden).toBe(false);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(bubble()?.hidden).toBe(true);
  });

  it("wraps non-interactive content in a real button when focusable", () => {
    render(
      <Tooltip content="waiting on delegated work" focusable>
        <span>waiting</span>
      </Tooltip>,
    );
    const trigger = screen.getByRole("button", { name: "waiting" });
    expect(trigger.getAttribute("type")).toBe("button");
    expect(trigger.getAttribute("aria-describedby")).toBe(bubble()?.id);
    fireEvent.click(trigger);
    expect(bubble()?.hidden).toBe(false);
  });
});

describe("IconButton", () => {
  it("has no native title and shows its label in a tooltip without repeating it", () => {
    render(<IconButton label="New bot" icon={<Icon name="plus" />} />);
    const button = screen.getByRole("button", { name: "New bot" });
    expect(button.hasAttribute("title")).toBe(false);
    expect(button.hasAttribute("aria-describedby")).toBe(false);
    expect(bubble()?.textContent).toBe("New bot");
  });

  it("describes with a different hint, or renders bare with tooltip={false}", () => {
    const { unmount } = render(
      <IconButton label="Send" tooltip="Enter" icon={<Icon name="send" />} />,
    );
    expect(
      screen
        .getByRole("button", { name: "Send" })
        .getAttribute("aria-describedby"),
    ).toBe(bubble()?.id);
    unmount();
    render(
      <IconButton label="Send" tooltip={false} icon={<Icon name="send" />} />,
    );
    expect(bubble()).toBeNull();
  });
});

describe("StatusTag", () => {
  it("explains waiting with a tooltip and hidden text, not a title", () => {
    render(<StatusTag status={{ status: "waiting", waitingFor: "user" }} />);
    expect(document.querySelector("[title]")).toBeNull();
    expect(bubble()?.textContent).toBe("waiting for you");
    expect(screen.getByText("(waiting for you)").className).toBe(
      "visually-hidden",
    );
    // Not a tab stop by default, so it can sit inside a list-row button.
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("can be a keyboard tooltip trigger when standalone", () => {
    render(
      <StatusTag
        status={{ status: "waiting", waitingFor: "delegations" }}
        focusableTooltip
      />,
    );
    const trigger = screen.getByRole("button");
    expect(trigger.getAttribute("aria-describedby")).toBe(bubble()?.id);
    expect(bubble()?.textContent).toBe("waiting on delegated work");
  });

  it("adds no tooltip for words that need none", () => {
    render(<StatusTag status="running" detail="Moss" />);
    expect(bubble()).toBeNull();
    expect(screen.getByText(/working · Moss/)).toBeTruthy();
  });
});

describe("pressed semantics", () => {
  it("ListItem and CardButton emit aria-pressed only when pressed is passed", () => {
    render(
      <>
        <ListItem title="Selected look only" selected />
        <ListItem title="Toggle" pressed={false} />
        <CardButton selected>Card look only</CardButton>
        <CardButton pressed>Card toggle</CardButton>
      </>,
    );
    const look = screen.getByRole("button", { name: "Selected look only" });
    expect(look.hasAttribute("aria-pressed")).toBe(false);
    expect(look.className).toContain("ui-list-item--selected");
    expect(
      screen
        .getByRole("button", { name: "Toggle" })
        .getAttribute("aria-pressed"),
    ).toBe("false");
    const card = screen.getByRole("button", { name: "Card look only" });
    expect(card.hasAttribute("aria-pressed")).toBe(false);
    expect(card.className).toContain("ui-card--selected");
    const toggle = screen.getByRole("button", { name: "Card toggle" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.className).toContain("ui-card--selected");
  });
});
