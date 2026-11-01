import { describe, expect, it } from "vitest";
import type { ApiBadge } from "../../api/client";
import { createDemoApi } from "../../api/demoApi";
import { nextFocusIndex, tabStopIndex } from "./listNavigation";
import { modeBadgeFor } from "./modeBadge";

describe("list keyboard navigation", () => {
  it("moves with the arrows and stops at the ends", () => {
    expect(nextFocusIndex("ArrowDown", 0, 3)).toBe(1);
    expect(nextFocusIndex("ArrowDown", 2, 3)).toBe(2);
    expect(nextFocusIndex("ArrowUp", 2, 3)).toBe(1);
    expect(nextFocusIndex("ArrowUp", 0, 3)).toBe(0);
  });

  it("jumps with Home and End and ignores other keys", () => {
    expect(nextFocusIndex("Home", 2, 3)).toBe(0);
    expect(nextFocusIndex("End", 0, 3)).toBe(2);
    expect(nextFocusIndex("Enter", 1, 3)).toBeNull();
    expect(nextFocusIndex("ArrowDown", 0, 0)).toBeNull();
  });

  it("puts the tab stop on the selected item, else the first", () => {
    expect(tabStopIndex(2, 3)).toBe(2);
    expect(tabStopIndex(-1, 3)).toBe(0);
    expect(tabStopIndex(5, 3)).toBe(0);
  });
});

describe("modeBadgeFor", () => {
  const badge = (label: ApiBadge["label"], tone: ApiBadge["tone"]) => ({
    label,
    tone,
    title: `why ${label}`,
  });

  it("maps every API badge to its sidebar kind and keeps the tooltip", () => {
    expect(modeBadgeFor(badge("Demo data", "demo"))).toEqual({
      kind: "demo",
      title: "why Demo data",
    });
    expect(modeBadgeFor(badge("Live", "live")).kind).toBe("live");
    expect(modeBadgeFor(badge("No model configured", "warning")).kind).toBe(
      "no-model",
    );
    expect(modeBadgeFor(badge("Scripted model", "warning")).kind).toBe(
      "scripted",
    );
  });

  it("never says live for the demo API", () => {
    const api = createDemoApi({ autoplay: false, reason: "test" });
    expect(modeBadgeFor(api.badge).kind).toBe("demo");
  });
});
