import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COLOUR_RAMPS } from "../../lib/colour";
import { PixelIcon } from "./PixelIcon";

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");
const favicon = read("../../../public/favicon.svg");
const tokens = read("../../styles/tokens.css");

/** Each `<path>` in an SVG as its fill and `d`. */
function paths(svg: string) {
  return [...svg.matchAll(/<path\b[^>]*>/g)].map(([tag]) => ({
    fill: /\sfill="([^"]+)"/.exec(tag)?.[1]?.toLowerCase(),
    d: /\sd="([^"]+)"/.exec(tag)?.[1],
  }));
}

/** The value of `--ink` in the token rule that starts at `marker`. */
function ink(marker: string): string | undefined {
  const start = tokens.indexOf(marker);
  if (start < 0) throw new Error(`Missing token rule: ${marker}`);
  return /--ink:\s*([^;]+);/.exec(tokens.slice(start))?.[1]?.toLowerCase();
}

const coral = COLOUR_RAMPS.coral.f.toLowerCase();
const brand = renderToStaticMarkup(<PixelIcon name="brand" size={24} />);

describe("PixelIcon brand", () => {
  it("draws the mark on the 12×12 sprite grid, square at multiples of 12", () => {
    expect(brand).toContain('viewBox="0 0 12 12"');
    expect(brand).toContain('width="24"');
    expect(brand).toContain('height="24"');
  });

  it("draws the head in --ink and only the antenna tip in bot coral", () => {
    const [head, tip, ...rest] = paths(brand);
    expect(head?.fill).toBe("var(--ink)");
    expect(tip).toEqual({ fill: coral, d: "M5 0h2v1h-2z" });
    // The eyes are holes: nothing else is drawn, so the ground shows through.
    expect(rest).toEqual([]);
  });
});

describe("favicon.svg", () => {
  it("is linked from index.html", () => {
    expect(read("../../../index.html")).toContain(
      '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />',
    );
  });

  it("draws the same grid as the brand mark, with crisp edges", () => {
    expect(favicon).toContain('viewBox="0 0 12 12"');
    expect(favicon).toContain('shape-rendering="crispEdges"');
    const [head, tip] = paths(brand);
    const [faviconHead, faviconTip, ...rest] = paths(favicon);
    expect(faviconHead?.d).toBe(head?.d);
    expect(faviconTip).toEqual(tip);
    expect(rest).toEqual([]);
  });

  it("draws the head in --ink for the browser's colour scheme", () => {
    const [head] = paths(favicon);
    expect(head?.fill).toBe(ink(':root[data-theme="light"],'));
    const dark =
      /prefers-color-scheme:\s*dark\)\s*\{\s*\.head\s*\{\s*fill:\s*([^;\s}]+)/
        .exec(favicon)?.[1]
        ?.toLowerCase();
    expect(dark).toBe(ink(':root[data-theme="dark"] {'));
    expect(favicon).toMatch(/<path class="head"/);
  });
});
