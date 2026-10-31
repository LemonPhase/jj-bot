import { readFileSync } from "node:fs";
import { BOT_COLOURS } from "@jj/contracts";
import { describe, expect, it } from "vitest";
import { contrastRatio, mentionColour, parseHex } from "../lib/colour";

const css = readFileSync(
  new URL("./tokens.css", import.meta.url),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

/** The declarations of the rule that starts at `marker`, as a name → value map. */
function block(marker: string): Map<string, string> {
  const start = css.indexOf(marker);
  if (start < 0) throw new Error(`Missing block: ${marker}`);
  const open = css.indexOf("{", start + marker.length - 1);
  let depth = 0;
  let end = open;
  for (let index = open; index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") depth -= 1;
    if (depth === 0) {
      end = index;
      break;
    }
  }
  const body = css.slice(open + 1, end);
  return new Map(
    [...body.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((match) => [
      match[1] as string,
      (match[2] as string).replace(/\s+/g, " ").trim(),
    ]),
  );
}

const shared = block("html:root {");
const light = block(':root[data-theme="light"],');
const dark = block(':root[data-theme="dark"] {');
const systemDark = block(
  "@media (prefers-color-scheme: dark) {\n  :root:not([data-theme]) {",
);

type Theme = Map<string, string>;

/** A token as an opaque hex colour; rgba values are composited over `over`. */
function hex(theme: Theme, name: string, over?: string): string {
  const value = theme.get(name);
  if (!value) throw new Error(`Missing token --${name}`);
  const rgba = value.match(
    /^rgba\(([\d.]+),\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)\)$/,
  );
  if (!rgba) return value;
  if (!over) throw new Error(`--${name} is translucent; pass a ground`);
  const [r, g, b, a] = rgba.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
  ];
  const base = parseHex(over);
  return `#${[r, g, b]
    .map((channel, index) =>
      Math.round(channel * a + (base[index] as number) * (1 - a))
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

const GROUNDS = [
  "bg-app",
  "bg-sidebar",
  "bg-surface",
  "bg-raised",
  "bg-selected",
  "bg-active",
  "bg-bubble",
  "bg-scene",
];
const TEXT = ["ink", "ink-2", "ink-3", "ink-muted"];

describe("tokens.css", () => {
  it("defines the same tokens in both themes", () => {
    expect([...light.keys()].sort()).toEqual([...dark.keys()].sort());
    expect(light.size).toBeGreaterThan(40);
  });

  it("keeps the system-default dark block identical to the explicit one", () => {
    expect(systemDark).toEqual(dark);
  });

  it("does not redefine theme tokens in the shared block", () => {
    for (const name of shared.keys()) expect(light.has(name), name).toBe(false);
  });

  for (const [themeName, theme] of [
    ["light", light],
    ["dark", dark],
  ] as const) {
    describe(`${themeName} text contrast (≥ 4.5:1)`, () => {
      it("text tokens on every ground", () => {
        for (const text of TEXT)
          for (const ground of GROUNDS) {
            const ratio = contrastRatio(hex(theme, text), hex(theme, ground));
            expect(
              ratio,
              `--${text} on --${ground}: ${ratio.toFixed(2)}`,
            ).toBeGreaterThanOrEqual(4.5);
          }
      });

      it("inverted and accent text", () => {
        const pairs: Array<[string, string]> = [
          ["btn-primary-ink", "btn-primary-bg"],
          ["pop-ink", "pop-bg"],
          ["pop-meta", "pop-bg"],
          ["ping-ink", "ping-bg"],
          ["status-failed-ink", "bg-app"],
          ["status-failed-ink", "bg-raised"],
        ];
        for (const [text, ground] of pairs) {
          const ratio = contrastRatio(hex(theme, text), hex(theme, ground));
          expect(ratio, `--${text} on --${ground}`).toBeGreaterThanOrEqual(4.5);
        }
        const scene = hex(theme, "bg-scene");
        const tagGround = hex(theme, "tag-bg", scene);
        expect(
          contrastRatio(hex(theme, "tag-ink"), tagGround),
        ).toBeGreaterThanOrEqual(4.5);
      });

      it("mention tokens match mentionColour() and read on chat grounds", () => {
        for (const colour of BOT_COLOURS) {
          const value = hex(theme, `mention-${colour}`);
          expect(value.toLowerCase(), colour).toBe(
            mentionColour(colour, themeName).toLowerCase(),
          );
          for (const ground of ["bg-app", "bg-bubble"])
            expect(
              contrastRatio(value, hex(theme, ground)),
              `${colour} on --${ground}`,
            ).toBeGreaterThanOrEqual(4.5);
        }
      });
    });
  }
});
