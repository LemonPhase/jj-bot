import {
  BOT_COLOURS,
  BOT_FACES,
  BOT_SHAPES,
  BOT_TOPPERS,
  type BotAppearance,
} from "@jj/contracts";
import { describe, expect, it } from "vitest";
import { APPEARANCE_PRESETS } from "../../lib/appearance";
import { COLOUR_RAMPS } from "../../lib/colour";
import { MOODS, type Mood } from "../../lib/status";
import {
  composeSprite,
  EYE_ROW,
  moodGlyph,
  spritePalette,
  spritePaths,
  spritePathsFor,
} from "./compose";
import { SHAPES, TOPPERS } from "./parts";

type Parts = Pick<BotAppearance, "shape" | "face" | "topper">;

const ALL_PARTS: Parts[] = BOT_SHAPES.flatMap((shape) =>
  BOT_FACES.flatMap((face) =>
    BOT_TOPPERS.map((topper) => ({ shape, face, topper })),
  ),
);

const cellAt = (grid: readonly string[], x: number, y: number) =>
  grid[y]?.[x] ?? ".";

// Flattened Studio presets, copied verbatim from the design's sprites.json.
const PRESET_GRIDS: Record<string, string[]> = {
  Juno: [
    ".....ll.....",
    ".....dd.....",
    "..bbbbbbbb..",
    ".bbbbbbbbbb.",
    ".bbbbbbbbbb.",
    "dbkwwkkwwkbd",
    "dbkkkkkkkkbd",
    "dbbbbbbbbbbd",
    ".bbbbbbbbbb.",
    ".bbbbbbbbbb.",
    "..bbbbbbbb..",
    "............",
  ],
  Kite: [
    "........l.l.",
    ".........d..",
    "...bbbbbd...",
    "..bbbbbbbb..",
    ".bbbbbbbbbb.",
    ".bbkwbbkwbb.",
    ".bbkkbbkkbb.",
    ".bbbbbbbbbb.",
    ".bbbbkkbbbb.",
    "..bbbbbbbb..",
    "...dddddd...",
    "............",
  ],
  Moss: [
    "...ee..ee...",
    ".....ss.....",
    "............",
    ".bbbbbbbbbb.",
    ".bbbbbbbbbb.",
    ".bbkwbbkwbb.",
    "dbbkkbbkkbbd",
    "dbbbbbbbbbbd",
    ".bbbbkkbbbb.",
    ".bbbbbbbbbb.",
    ".dddddddddd.",
    "............",
  ],
  Vesper: [
    ".....ll.....",
    "....llll....",
    "....bbbb....",
    "...bbbbbb...",
    "..bbwwwwbb..",
    ".bbbwwwwbbb.",
    ".bbbwwwwbbb.",
    ".bbbwwwwbbb.",
    "..bbbbbbbb..",
    "...bbkkbb...",
    "....dddd....",
    ".....dd.....",
  ],
  "Teal Dome": [
    ".ggggddgggg.",
    ".....dd.....",
    "....bbbb....",
    "...bbbbbb...",
    "..kkkkkkkk..",
    ".bkllkkllkb.",
    ".bkllkkllkb.",
    ".bkkkllkkkb.",
    ".bkkkkkkkkb.",
    ".bbbbbbbbbb.",
    ".dddddddddd.",
    "............",
  ],
  "Pink Halo": [
    "...yyyyyy...",
    "............",
    "...bbbbbb...",
    "..bbbbbbbb..",
    ".bbbwwwwbbb.",
    ".bbbwwwwbbb.",
    ".bbbwwwwbbb.",
    ".bbbwwwwbbb.",
    ".bbbbbbbbbb.",
    "..bbbkkbbb..",
    "...dddddd...",
    "............",
  ],
  "Amber Block": [
    ".....ll.....",
    ".....dd.....",
    "............",
    ".bbbbbbbbbb.",
    ".bbbbbbbbbb.",
    ".bkwwkkwwkb.",
    "dbkkkkkkkkbd",
    "dbbbbbbbbbbd",
    ".bbbbbbbbbb.",
    ".bbbbbbbbbb.",
    ".dddddddddd.",
    "............",
  ],
  "Lime Sprout": [
    "...ee..ee...",
    ".....ss.....",
    "..bbbbbbbb..",
    ".bbbbbbbbbb.",
    ".bkkkkkkkkb.",
    "dbkllkkllkbd",
    "dbkllkkllkbd",
    "dbkkkllkkkbd",
    ".bkkkkkkkkb.",
    ".bbbbbbbbbb.",
    "..bbbbbbbb..",
    "............",
  ],
};

// The System sheet's hand-drawn Moss (a block head with a dots-style face and
// bottom eye row 6) below its topper, rows 3–11, copied from sprites.json.
const MOSS_BELOW_TOPPER: Record<Exclude<Mood, "idle">, string[]> = {
  thinking: [
    ".bbbbbbbbbb.",
    ".bbbkbbbkbb.",
    ".bbbkbbbkbb.",
    "dbbbbbbbbbbd",
    "dbbbbbbbbbbd",
    ".bbbbbkbbbb.",
    ".bbbbbbbbbb.",
    ".dddddddddd.",
    "............",
  ],
  working: [
    ".bbbbbbbbbb.",
    ".bbbbbbbbbb.",
    ".bbbkbbkbbb.",
    "dbbkkbbkkbbd",
    "dbbbbbbbbbbd",
    ".bbbkkkkbbb.",
    ".bbbbbbbbbb.",
    ".dddddddddd.",
    "............",
  ],
  verifying: [
    ".bbbbbbkkbb.",
    ".bbbbbbbbbb.",
    ".bbbbbbkkbb.",
    "dbbkkbbkkbbd",
    "dbbbbbbbbbbd",
    ".bbbbbkkbbb.",
    ".bbbbbbbbbb.",
    ".dddddddddd.",
    "............",
  ],
  done: [
    ".bbbbbbbbbb.",
    ".bbbbbbbbbb.",
    ".bbkbbbbkbb.",
    "dbkbkbbkbkbd",
    "dbbbbbbbbbbd",
    ".bbbkbbkbbb.",
    ".bbbbkkbbbb.",
    ".dddddddddd.",
    "............",
  ],
  stuck: [
    ".bbbbbbbbbb.",
    ".bkbkbbkbkb.",
    ".bbkbbbbkbb.",
    "dbkbkbbkbkbd",
    "dbbbbbbbbbbd",
    ".bbbbkbkbbb.",
    ".bbbkbkbbbb.",
    ".dddddddddd.",
    "............",
  ],
};

const NON_IDLE = MOODS.filter((mood) => mood !== "idle") as Exclude<
  Mood,
  "idle"
>[];

describe("composeSprite", () => {
  it("produces a 12×12 grid of known cells for every enum combination and mood", () => {
    let count = 0;
    for (const parts of ALL_PARTS)
      for (const mood of MOODS) {
        const grid = composeSprite(parts, mood);
        expect(grid).toHaveLength(12);
        for (const row of grid) expect(row).toMatch(/^[.bdlkwgyes]{12}$/);
        count += 1;
      }
    expect(count).toBe(5 * 4 * 7 * 6);
  });

  it("reproduces every design preset in the idle mood", () => {
    for (const { name, appearance } of APPEARANCE_PRESETS) {
      const expected = [...(PRESET_GRIDS[name] ?? [])];
      if (appearance.face === "mono") {
        // Design defect fix: the pupil is painted over the white eye.
        for (const y of [5, 6]) {
          const row = expected[y] ?? "";
          expected[y] = `${row.slice(0, 5)}kk${row.slice(7)}`;
        }
      }
      expect(composeSprite(appearance, "idle"), name).toEqual(expected);
    }
  });

  it("matches the System sheet's Moss below the topper in every mood", () => {
    for (const mood of NON_IDLE) {
      const grid = composeSprite(
        { shape: "block", face: "dots", topper: "none" },
        mood,
      );
      expect(grid.slice(3), mood).toEqual(MOSS_BELOW_TOPPER[mood]);
    }
  });

  it("gives each mood of every combination its own picture", () => {
    for (const parts of ALL_PARTS) {
      const pictures = new Set(
        MOODS.map((mood) => composeSprite(parts, mood).join("\n")),
      );
      expect(pictures.size, JSON.stringify(parts)).toBe(MOODS.length);
    }
  });

  it("keeps the silhouette: moods only repaint cells already on the head", () => {
    for (const parts of ALL_PARTS) {
      const idle = composeSprite(parts, "idle");
      for (const mood of NON_IDLE) {
        const grid = composeSprite(parts, mood);
        for (let y = 0; y < 12; y += 1)
          for (let x = 0; x < 12; x += 1) {
            const isDot =
              mood === "thinking" && y === 0 && cellAt(grid, x, y) === "g";
            if (isDot) continue;
            expect(cellAt(grid, x, y) === ".", `${mood} ${x},${y}`).toBe(
              cellAt(idle, x, y) === ".",
            );
          }
      }
    }
  });

  it("applies the mood rule glyphs in each face's colours", () => {
    for (const shape of BOT_SHAPES)
      for (const mood of NON_IDLE) {
        const glyph = moodGlyph(mood);
        const eyes = [...glyph.left, ...glyph.right, ...glyph.brow];
        const at = (face: Parts["face"], x: number, y: number) =>
          cellAt(composeSprite({ shape, face, topper: "none" }, mood), x, y);

        for (const [x, y] of [...eyes, ...glyph.mouth])
          expect(at("dots", x, y), `dots ${shape} ${mood}`).toBe("k");

        // Visor: white glyphs on a plate spanning rows B-3..B; the mouth is ink.
        for (const [x, y] of eyes)
          expect(at("visor", x, y), `visor ${shape} ${mood}`).toBe("w");
        for (const [x, y] of glyph.mouth) expect(at("visor", x, y)).toBe("k");

        // Screen: colour.l on the rows 4–8 plate, ink where a glyph leaves it.
        for (const [x, y] of [...eyes, ...glyph.mouth])
          expect(at("screen", x, y), `screen ${shape} ${mood} ${x},${y}`).toBe(
            y >= 4 && y <= 8 ? "l" : "k",
          );

        // Mono: the right-eye glyph in ink, two columns left, inside the white eye.
        for (const [x, y] of glyph.right)
          expect(at("mono", x - 2, y), `mono ${shape} ${mood}`).toBe("k");
        for (const [x, y] of glyph.mouth) expect(at("mono", x, y)).toBe("k");
      }
  });

  it("uses bottom eye row 6 so every glyph lands on every head shape", () => {
    expect(EYE_ROW).toBe(6);
    for (const shape of BOT_SHAPES)
      for (const mood of NON_IDLE) {
        const glyph = moodGlyph(mood);
        for (const [x, y] of [
          ...glyph.left,
          ...glyph.right,
          ...glyph.brow,
          ...glyph.mouth,
        ])
          expect(
            cellAt(SHAPES[shape], x, y),
            `${shape} ${mood} ${x},${y}`,
          ).toBe("b");
      }
  });

  it("removes the idle face in moods", () => {
    // The dots face's white highlights and the visor's idle eyes do not survive a mood.
    for (const mood of NON_IDLE) {
      const dots = composeSprite(
        { shape: "round", face: "dots", topper: "none" },
        mood,
      );
      expect(dots.join("")).not.toContain("w");
    }
  });

  it("draws thinking dots only when the topper leaves row 0 free", () => {
    for (const topper of BOT_TOPPERS) {
      const grid = composeSprite(
        { shape: "squircle", face: "dots", topper },
        "thinking",
      );
      const topperUsesRow0 = /[^.]/.test(TOPPERS[topper][0] ?? "");
      const dots = [7, 9, 11].map((x) => cellAt(grid, x, 0));
      if (topperUsesRow0) expect(dots, topper).not.toEqual(["g", "g", "g"]);
      else expect(dots, topper).toEqual(["g", "g", "g"]);
    }
    expect(
      composeSprite(
        { shape: "squircle", face: "dots", topper: "none" },
        "idle",
      )[0],
    ).toBe("............");
  });
});

describe("spritePaths", () => {
  /** Rebuilds a grid of hex fills from paths, to prove the SVG draws exactly the grid. */
  function rasterise(paths: ReturnType<typeof spritePaths>): string[][] {
    const out = Array.from({ length: 12 }, () => Array<string>(12).fill("."));
    for (const { fill, d } of paths)
      for (const match of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)) {
        const [x, y, width] = [match[1], match[2], match[3]].map(Number) as [
          number,
          number,
          number,
        ];
        for (let i = 0; i < width; i += 1) {
          const row = out[y];
          if (row) {
            expect(row[x + i], "overlapping runs").toBe(".");
            row[x + i] = fill;
          }
        }
      }
    return out;
  }

  it("draws every cell of every combination exactly once, in its colour", () => {
    for (const parts of ALL_PARTS)
      for (const colour of BOT_COLOURS)
        for (const mood of MOODS) {
          const grid = composeSprite(parts, mood);
          const palette = spritePalette(colour);
          const drawn = rasterise(spritePathsFor({ ...parts, colour }, mood));
          const expected = grid.map((row) =>
            [...row].map((cell) =>
              cell === "." ? "." : palette[cell as keyof typeof palette],
            ),
          );
          expect(drawn).toEqual(expected);
        }
  });

  it("colours body, shade and light from the bot's ramp", () => {
    for (const colour of BOT_COLOURS) {
      const palette = spritePalette(colour);
      expect(palette.b).toBe(COLOUR_RAMPS[colour].f);
      expect(palette.d).toBe(COLOUR_RAMPS[colour].d);
      expect(palette.l).toBe(COLOUR_RAMPS[colour].l);
    }
  });
});
