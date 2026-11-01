// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { COLOUR_RAMPS } from "../../lib/colour";
import { PixelIcon } from "./PixelIcon";

// Under jsdom the global URL is jsdom's; node:fs wants Node's.
const read = (path: string) =>
  readFileSync(new NodeURL(path, import.meta.url), "utf8");
const tokens = read("../../styles/tokens.css");

/** An SVG file parsed as XML, as a browser loads a favicon. */
function parseSvg(text: string): Document {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const error = doc.getElementsByTagName("parsererror")[0];
  if (error) throw new Error(`Malformed SVG: ${error.textContent}`);
  return doc;
}

/** The rendered brand mark as an element. */
function brandMark(size?: number): Element {
  const host = document.createElement("div");
  host.innerHTML = renderToStaticMarkup(<PixelIcon name="brand" size={size} />);
  const svg = host.firstElementChild;
  if (!svg) throw new Error("PixelIcon rendered nothing");
  return svg;
}

/** Each `<path>` as its fill and `d`. */
function paths(svg: Document | Element) {
  return [...svg.querySelectorAll("path")].map((path) => ({
    fill: path.getAttribute("fill")?.toLowerCase(),
    d: path.getAttribute("d"),
  }));
}

/** The value of `--ink` in the token rule that starts at `marker`. */
function ink(marker: string): string | undefined {
  const start = tokens.indexOf(marker);
  if (start < 0) throw new Error(`Missing token rule: ${marker}`);
  return /--ink:\s*([^;]+);/.exec(tokens.slice(start))?.[1]?.toLowerCase();
}

const coral = COLOUR_RAMPS.coral.f.toLowerCase();

describe("PixelIcon brand", () => {
  it("draws the mark on the 12×12 sprite grid, square at multiples of 12", () => {
    const mark = brandMark(36);
    expect(mark.getAttribute("viewBox")).toBe("0 0 12 12");
    expect(mark.getAttribute("width")).toBe("36");
    expect(mark.getAttribute("height")).toBe("36");
    // The default is a multiple of 12 too, so a bare brand mark stays square.
    expect(brandMark().outerHTML).toBe(brandMark(24).outerHTML);
  });

  it("draws the head in --ink and only the antenna tip in bot coral", () => {
    const [head, tip, ...rest] = paths(brandMark());
    expect(head?.fill).toBe("var(--ink)");
    expect(tip).toEqual({ fill: coral, d: "M5 0h2v1h-2z" });
    // The eyes are holes: nothing else is drawn, so the ground shows through.
    expect(rest).toEqual([]);
  });
});

describe("favicon.svg", () => {
  const text = read("../../../public/favicon.svg");
  const favicon = () => parseSvg(text);

  it("is well-formed XML, or browsers show no icon at all", () => {
    expect(favicon).not.toThrow();
  });

  it("is linked from index.html", () => {
    expect(read("../../../index.html")).toContain(
      '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />',
    );
  });

  it("draws the same grid as the brand mark, with crisp edges", () => {
    const svg = favicon().documentElement;
    expect(svg.getAttribute("viewBox")).toBe("0 0 12 12");
    expect(svg.getAttribute("shape-rendering")).toBe("crispEdges");
    const [head, tip] = paths(brandMark());
    const [faviconHead, faviconTip, ...rest] = paths(favicon());
    expect(faviconHead?.d).toBe(head?.d);
    expect(faviconTip).toEqual(tip);
    expect(rest).toEqual([]);
  });

  it("draws the head in --ink for the browser's colour scheme", () => {
    const doc = favicon();
    const head = doc.querySelector("path.head");
    expect(head).toBe(doc.querySelector("path"));
    expect(head?.getAttribute("fill")?.toLowerCase()).toBe(
      ink(':root[data-theme="light"],'),
    );
    const style = doc.querySelector("style")?.textContent ?? "";
    const dark =
      /prefers-color-scheme:\s*dark\)\s*\{\s*\.head\s*\{\s*fill:\s*([^;\s}]+)/.exec(
        style,
      )?.[1];
    expect(dark?.toLowerCase()).toBe(ink(':root[data-theme="dark"] {'));
  });
});
