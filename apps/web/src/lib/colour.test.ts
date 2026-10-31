import { BOT_COLOURS } from "@jj/contracts";
import { describe, expect, it } from "vitest";
import {
  COLOUR_RAMPS,
  colourRamp,
  contrastRatio,
  LIGHT_MENTION_GROUNDS,
  mentionColour,
  parseHex,
  relativeLuminance,
  TEXT_CONTRAST,
} from "./colour";

describe("contrastRatio", () => {
  it("matches the WCAG reference points", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#777777")).toBe(1);
    // #767676 is the classic lightest grey that passes 4.5:1 on white.
    expect(contrastRatio("#767676", "#FFFFFF")).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio("#777777", "#FFFFFF")).toBeLessThan(4.5);
  });

  it("parses short and long hex", () => {
    expect(parseHex("#fff")).toEqual([255, 255, 255]);
    expect(parseHex("0B0E14")).toEqual([11, 14, 20]);
    expect(() => parseHex("rgba(0,0,0,1)")).toThrow();
    expect(relativeLuminance("#000")).toBe(0);
  });
});

describe("colourRamp", () => {
  it("has seven tones for every bot colour", () => {
    for (const colour of BOT_COLOURS)
      expect(Object.keys(colourRamp(colour)).sort()).toEqual(
        ["d", "f", "glow", "l", "s", "t", "v"].sort(),
      );
  });
});

describe("mentionColour (brief decision 3)", () => {
  const DARK_GROUNDS = ["#0B0B0D", "#1A1A1F"]; // --bg-app, --bg-bubble

  it("uses the fill colour as drawn in dark, and it reads at 4.5:1", () => {
    for (const colour of BOT_COLOURS) {
      const hex = mentionColour(colour, "dark");
      expect(hex).toBe(COLOUR_RAMPS[colour].f);
      for (const ground of DARK_GROUNDS)
        expect(contrastRatio(hex, ground), colour).toBeGreaterThanOrEqual(
          TEXT_CONTRAST,
        );
    }
  });

  it("uses the lightest ramp tone that reaches 4.5:1 on the light grounds", () => {
    for (const colour of BOT_COLOURS) {
      const ramp = COLOUR_RAMPS[colour];
      const hex = mentionColour(colour, "light");
      expect(Object.values(ramp)).toContain(hex);
      for (const ground of LIGHT_MENTION_GROUNDS)
        expect(contrastRatio(hex, ground), colour).toBeGreaterThanOrEqual(
          TEXT_CONTRAST,
        );
      // No lighter tone of the ramp would also pass.
      for (const tone of [ramp.f, ramp.d, ramp.l, ramp.t, ramp.s, ramp.v])
        if (relativeLuminance(tone) > relativeLuminance(hex))
          expect(
            LIGHT_MENTION_GROUNDS.every(
              (ground) => contrastRatio(tone, ground) >= TEXT_CONTRAST,
            ),
            `${colour} ${tone}`,
          ).toBe(false);
    }
  });

  it("lands on the shade tone where it is dark enough", () => {
    expect(
      Object.fromEntries(
        BOT_COLOURS.map((c) => [c, mentionColour(c, "light")]),
      ),
    ).toEqual({
      coral: COLOUR_RAMPS.coral.d,
      amber: COLOUR_RAMPS.amber.v,
      lime: COLOUR_RAMPS.lime.v,
      green: COLOUR_RAMPS.green.v,
      teal: COLOUR_RAMPS.teal.v,
      blue: COLOUR_RAMPS.blue.d,
      violet: COLOUR_RAMPS.violet.d,
      pink: COLOUR_RAMPS.pink.d,
    });
  });
});
