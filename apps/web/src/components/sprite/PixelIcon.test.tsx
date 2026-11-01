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
const tokens = read("../../styles/tokens.css").replace(/\/\*[\s\S]*?\*\//g, "");

const SVG_NS = "http://www.w3.org/2000/svg";

/** An SVG file parsed as XML, as a browser loads a favicon. */
function parseSvg(text: string): Document {
  const doc = new DOMParser().parseFromString(text, "image/svg+xml");
  const error = doc.getElementsByTagName("parsererror")[0];
  if (error) throw new Error(`Malformed SVG: ${error.textContent}`);
  if (doc.documentElement.namespaceURI !== SVG_NS)
    throw new Error(`The root is not in the SVG namespace (${SVG_NS})`);
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

/** The grid cells a path of one-unit-high runs fills, as "x,y". */
function cells(d: string | null | undefined): Set<string> {
  const run = /M(\d+) (\d+)h(\d+)v1h-\3z/g;
  if (!d || d.replace(run, "") !== "") throw new Error(`Not runs: ${d}`);
  const filled = new Set<string>();
  for (const [, x, y, width] of d.matchAll(run))
    for (let dx = 0; dx < Number(width); dx += 1)
      filled.add(`${Number(x) + dx},${y}`);
  return filled;
}

const xy = (cell: string) => cell.split(",").map(Number) as [number, number];

/** The value of `--ink` in the token rule that starts at `marker`. */
function ink(marker: string): string | undefined {
  const start = tokens.indexOf(marker);
  if (start < 0) throw new Error(`Missing token rule: ${marker}`);
  const rule = tokens.slice(start, tokens.indexOf("}", start));
  return /--ink:\s*([^;]+);/.exec(rule)?.[1]?.toLowerCase();
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

  it("draws the head in --ink and nothing but the antenna tip in bot coral", () => {
    const [head, tip, ...rest] = paths(brandMark());
    expect(head?.fill).toBe("var(--ink)");
    expect(tip?.fill).toBe(coral);
    expect(rest).toEqual([]);
  });

  it("is a bot head: a centred antenna, two 2×2 eye holes, mirror-symmetric", () => {
    const [head = new Set<string>(), tip = new Set<string>()] = paths(
      brandMark(),
    ).map(({ d }) => cells(d));
    const drawn = new Set([...head, ...tip]);
    for (const cell of drawn) {
      const [x, y] = xy(cell);
      expect(Math.max(x, y)).toBeLessThan(12);
      expect(drawn.has(`${11 - x},${y}`), `mirror of ${cell}`).toBe(true);
    }
    // The coral is the antenna's top row, 2px wide and centred, on an ink stem.
    expect([...tip].sort()).toEqual(["5,0", "6,0"]);
    expect(head.has("5,1") && head.has("6,1")).toBe(true);
    // Each eye is undrawn and ringed by the head, so the ground shows through.
    const eyes = ["3,5", "4,5", "3,6", "4,6", "7,5", "8,5", "7,6", "8,6"];
    for (const eye of eyes) {
      expect(drawn.has(eye), `eye ${eye}`).toBe(false);
      const [x, y] = xy(eye);
      for (const next of [
        `${x - 1},${y}`,
        `${x + 1},${y}`,
        `${x},${y - 1}`,
        `${x},${y + 1}`,
      ])
        if (!eyes.includes(next))
          expect(head.has(next), `head around ${eye}`).toBe(true);
    }
  });
});

describe("favicon.svg", () => {
  const text = read("../../../public/favicon.svg");
  const favicon = () => parseSvg(text);

  it("is well-formed XML in the SVG namespace, or browsers show no icon", () => {
    expect(favicon).not.toThrow();
  });

  it("is linked from index.html", () => {
    const html = new DOMParser().parseFromString(
      read("../../../index.html"),
      "text/html",
    );
    const icon = html.querySelector('link[rel="icon"]');
    expect(icon?.getAttribute("type")).toBe("image/svg+xml");
    expect(icon?.getAttribute("href")).toBe("/favicon.svg");
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
