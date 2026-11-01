// @vitest-environment jsdom
import "../../test/dom";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { Segmented, type SegmentedOption } from "./Segmented";
import { TabPanel, Tabs } from "./Tabs";

type Motion = "idle" | "walk" | "talk" | "work";
const MOTIONS: SegmentedOption<Motion>[] = [
  { value: "idle", label: "Idle" },
  { value: "walk", label: "Walk" },
  { value: "talk", label: "Talk", disabled: true },
  { value: "work", label: "Work" },
];

function MotionSwitch({ onChange }: { onChange?: (value: Motion) => void }) {
  const [value, setValue] = useState<Motion>("walk");
  return (
    <Segmented
      label="Preview motion"
      options={MOTIONS}
      value={value}
      onChange={(next) => {
        onChange?.(next);
        setValue(next);
      }}
    />
  );
}

const radio = (name: string) => screen.getByRole("radio", { name });

describe("Segmented (choice)", () => {
  it("is a radio group with one Tab stop on the checked item", () => {
    render(<MotionSwitch />);
    expect(
      screen.getByRole("radiogroup", { name: "Preview motion" }),
    ).toBeTruthy();
    expect(radio("Walk").getAttribute("aria-checked")).toBe("true");
    expect(radio("Idle").getAttribute("aria-checked")).toBe("false");
    expect(
      screen.getAllByRole("radio").map((item) => item.getAttribute("tabindex")),
    ).toEqual(["-1", "0", "-1", "-1"]);
    expect(radio("Walk").hasAttribute("aria-pressed")).toBe(false);
  });

  it("moves and selects with arrows, skipping disabled items and wrapping", () => {
    const onChange = vi.fn();
    render(<MotionSwitch onChange={onChange} />);
    radio("Walk").focus();
    fireEvent.keyDown(radio("Walk"), { key: "ArrowRight" });
    expect(onChange).toHaveBeenLastCalledWith("work");
    expect(document.activeElement).toBe(radio("Work"));
    expect(radio("Work").getAttribute("tabindex")).toBe("0");
    fireEvent.keyDown(radio("Work"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(radio("Idle"));
    fireEvent.keyDown(radio("Idle"), { key: "ArrowUp" });
    expect(document.activeElement).toBe(radio("Work"));
    fireEvent.keyDown(radio("Work"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(radio("Walk"));
  });

  it("jumps with Home and End and ignores other keys", () => {
    const onChange = vi.fn();
    render(<MotionSwitch onChange={onChange} />);
    fireEvent.keyDown(radio("Walk"), { key: "End" });
    expect(document.activeElement).toBe(radio("Work"));
    fireEvent.keyDown(radio("Work"), { key: "Home" });
    expect(document.activeElement).toBe(radio("Idle"));
    onChange.mockClear();
    fireEvent.keyDown(radio("Idle"), { key: "a" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("keeps navigation semantics in nav mode", () => {
    render(
      <Segmented
        label="Primary"
        kind="nav"
        value="bots"
        onChange={() => {}}
        options={[
          { value: "bots", label: "Bots", count: 4 },
          { value: "tasks", label: "Tasks", count: 3 },
        ]}
      />,
    );
    const nav = screen.getByRole("navigation", { name: "Primary" });
    const [bots, tasks] = Array.from(nav.querySelectorAll("button"));
    expect(bots?.getAttribute("aria-current")).toBe("page");
    expect(tasks?.hasAttribute("aria-current")).toBe(false);
    expect(screen.queryByRole("radio")).toBeNull();
  });
});

type View = "progress" | "graph" | "office";

function ViewTabs() {
  const [view, setView] = useState<View>("progress");
  const panel = (value: View) => `view-${value}`;
  return (
    <>
      <Tabs
        label="View"
        value={view}
        onChange={setView}
        panelId={panel}
        items={[
          { value: "progress", label: "Progress" },
          { value: "graph", label: "Graph" },
          { value: "office", label: "Office" },
        ]}
      />
      <TabPanel id={panel(view)}>{view} content</TabPanel>
    </>
  );
}

const tab = (name: string) => screen.getByRole("tab", { name });

describe("Tabs", () => {
  it("wires tabs to their panel", () => {
    render(<ViewTabs />);
    expect(screen.getByRole("tablist", { name: "View" })).toBeTruthy();
    expect(tab("Progress").getAttribute("aria-selected")).toBe("true");
    expect(tab("Graph").getAttribute("aria-selected")).toBe("false");
    const panel = screen.getByRole("tabpanel");
    expect(tab("Progress").getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.getAttribute("aria-labelledby")).toBe(tab("Progress").id);
    expect(screen.getByRole("tabpanel", { name: "Progress" })).toBe(panel);
  });

  it("moves with Left and Right, Home and End, with one Tab stop", () => {
    render(<ViewTabs />);
    tab("Progress").focus();
    fireEvent.keyDown(tab("Progress"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab("Graph"));
    expect(tab("Graph").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tabpanel", { name: "Graph" }).textContent).toBe(
      "graph content",
    );
    expect(
      screen.getAllByRole("tab").map((item) => item.getAttribute("tabindex")),
    ).toEqual(["-1", "0", "-1"]);
    fireEvent.keyDown(tab("Graph"), { key: "End" });
    expect(document.activeElement).toBe(tab("Office"));
    fireEvent.keyDown(tab("Office"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab("Progress"));
    fireEvent.keyDown(tab("Progress"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tab("Office"));
    fireEvent.keyDown(tab("Office"), { key: "Home" });
    expect(document.activeElement).toBe(tab("Progress"));
    // Vertical arrows do nothing in a horizontal tab list.
    fireEvent.keyDown(tab("Progress"), { key: "ArrowDown" });
    expect(document.activeElement).toBe(tab("Progress"));
  });
});
