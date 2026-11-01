import type { BotAppearance, BotColour } from "@jj/contracts";
import { COLOUR_RAMPS } from "../../lib/colour";
import type { Mood } from "../../lib/status";
import {
  FACES,
  GRID_SIZE,
  SHAPES,
  type SpriteCell,
  type SpriteGrid,
  TOPPERS,
} from "./parts";

/**
 * Composes a bot's 12×12 sprite from its appearance and a mood.
 *
 * Paint order (design `layerOrder`): shape (main, shade) → face → topper.
 * Body and gait have no pixels in the 2D sprite; they only drive the 3D
 * character, exactly as in the design.
 *
 * Idle draws the Studio face as designed. The other moods apply the System
 * sheet's mood rule (SPEC §7, brief decision 1) to every face, with the bottom
 * eye row B = 6, the row at which every glyph cell lands on the head for all
 * five shapes:
 *
 *   mood       left eye                 right eye                       mouth (rows 8–9)
 *   working    (3,B)(4,B)(4,B-1)        (7,B)(8,B)(7,B-1)               (4..7,8)
 *   thinking   (4,B-2)(4,B-1)           (8,B-2)(8,B-1)                  (6,8)    + grey dots (7,0)(9,0)(11,0)
 *   verifying  (3,B)(4,B)               (7..8,B-1..B) + brow (7..8,B-3) (6,8)(7,8)
 *   done       (2,B)(3,B-1)(4,B)        (7,B)(8,B-1)(9,B)               (4,8)(5,9)(6,9)(7,8)
 *   stuck      X (2..4,B-2..B)          X (7..9,B-2..B)                 (4,9)(5,8)(6,9)(7,8)
 *
 * How each face draws the glyphs (the SPEC §7 proposal, with the closest
 * faithful rendering where the parts cannot express the rule exactly):
 *   dots    the idle eyes and mouth are replaced by the glyphs in ink.
 *   visor   the plate grows to rows B-3..B (as on the System's Juno), clipped
 *           to the head outline because gem and dome are narrower at row 3;
 *           glyphs on the plate are white, glyphs off it (the mouth) are ink.
 *   screen  the plate stays at rows 4–8; glyphs on it glow in colour.l and the
 *           few that fall off it (the verifying brow, the lower lip of done and
 *           stuck) are drawn in ink, the plate colour, as Juno draws its mouth.
 *   mono    SPEC proposes no mood glyphs for the one-eyed face, but the brief
 *           asks for the rule on every combination. The right-eye glyph is
 *           drawn in ink inside the white eye (shifted two columns left to sit
 *           in it), the eye narrows to rows 4–6 so the mouth keeps the idle
 *           face's one-row gap, and the mouth follows the table.
 *
 * The thinking dots share row 0 with every topper except "none"; they are
 * skipped whenever the topper uses row 0 (SPEC §7 proposal).
 */

type Cell = readonly [x: number, y: number];

interface MoodGlyph {
  left: readonly Cell[];
  right: readonly Cell[];
  brow: readonly Cell[];
  mouth: readonly Cell[];
  dots: readonly Cell[];
}

/** Bottom eye row used for every Studio face. */
export const EYE_ROW = 6;

const THINKING_DOTS: readonly Cell[] = [
  [7, 0],
  [9, 0],
  [11, 0],
];

/** The System sheet's mood glyphs for bottom eye row `b`. Idle has none. */
export function moodGlyph(mood: Exclude<Mood, "idle">, b = EYE_ROW): MoodGlyph {
  const none: readonly Cell[] = [];
  switch (mood) {
    case "working":
      return {
        left: [
          [3, b],
          [4, b],
          [4, b - 1],
        ],
        right: [
          [7, b],
          [8, b],
          [7, b - 1],
        ],
        brow: none,
        mouth: [
          [4, 8],
          [5, 8],
          [6, 8],
          [7, 8],
        ],
        dots: none,
      };
    case "thinking":
      return {
        left: [
          [4, b - 2],
          [4, b - 1],
        ],
        right: [
          [8, b - 2],
          [8, b - 1],
        ],
        brow: none,
        mouth: [[6, 8]],
        dots: THINKING_DOTS,
      };
    case "verifying":
      return {
        left: [
          [3, b],
          [4, b],
        ],
        right: [
          [7, b - 1],
          [8, b - 1],
          [7, b],
          [8, b],
        ],
        brow: [
          [7, b - 3],
          [8, b - 3],
        ],
        mouth: [
          [6, 8],
          [7, 8],
        ],
        dots: none,
      };
    case "done":
      return {
        left: [
          [2, b],
          [3, b - 1],
          [4, b],
        ],
        right: [
          [7, b],
          [8, b - 1],
          [9, b],
        ],
        brow: none,
        mouth: [
          [4, 8],
          [5, 9],
          [6, 9],
          [7, 8],
        ],
        dots: none,
      };
    case "stuck":
      return {
        left: [
          [2, b - 2],
          [4, b - 2],
          [3, b - 1],
          [2, b],
          [4, b],
        ],
        right: [
          [7, b - 2],
          [9, b - 2],
          [8, b - 1],
          [7, b],
          [9, b],
        ],
        brow: none,
        mouth: [
          [4, 9],
          [5, 8],
          [6, 9],
          [7, 8],
        ],
        dots: none,
      };
  }
}

/** Plate rows and columns (inclusive) for the faces that draw on a plate. */
const VISOR_PLATE = { rows: [EYE_ROW - 3, EYE_ROW], cols: [2, 9] } as const;
const SCREEN_PLATE = { rows: [4, 8], cols: [2, 9] } as const;
const MONO_EYE = { rows: [4, 6], cols: [4, 7] } as const;
/** The mono face draws the right-eye glyph this many columns to the left. */
const MONO_SHIFT = -2;

type Box = { rows: readonly [number, number]; cols: readonly [number, number] };

const inBox = ([x, y]: Cell, box: Box): boolean =>
  y >= box.rows[0] && y <= box.rows[1] && x >= box.cols[0] && x <= box.cols[1];

const boxCells = (box: Box): Cell[] => {
  const cells: Cell[] = [];
  for (let y = box.rows[0]; y <= box.rows[1]; y += 1)
    for (let x = box.cols[0]; x <= box.cols[1]; x += 1) cells.push([x, y]);
  return cells;
};

class Canvas {
  readonly cells: SpriteCell[][] = Array.from({ length: GRID_SIZE }, () =>
    Array<SpriteCell>(GRID_SIZE).fill("."),
  );

  /** Paints every non-transparent cell of `grid` (rows beyond its length are empty). */
  layer(grid: SpriteGrid): void {
    grid.forEach((row, y) => {
      for (let x = 0; x < row.length; x += 1) {
        const cell = row[x] as SpriteCell;
        if (cell !== ".") this.set([x, y], cell);
      }
    });
  }

  set([x, y]: Cell, cell: SpriteCell): void {
    const row = this.cells[y];
    if (row && x >= 0 && x < GRID_SIZE) row[x] = cell;
  }

  get([x, y]: Cell): SpriteCell {
    return this.cells[y]?.[x] ?? ".";
  }

  /** Paints only where the head already has a pixel, so glyphs never float off it. */
  onHead(cells: readonly Cell[], cell: SpriteCell | ((c: Cell) => SpriteCell)) {
    for (const c of cells)
      if (this.get(c) !== ".")
        this.set(c, typeof cell === "function" ? cell(c) : cell);
  }

  toGrid(): string[] {
    return this.cells.map((row) => row.join(""));
  }
}

function drawMoodFace(
  canvas: Canvas,
  face: BotAppearance["face"],
  glyph: MoodGlyph,
): void {
  const eyes = [...glyph.left, ...glyph.right, ...glyph.brow];
  switch (face) {
    case "dots":
      canvas.onHead([...eyes, ...glyph.mouth], "k");
      return;
    case "visor":
    case "screen": {
      const plate = face === "visor" ? VISOR_PLATE : SCREEN_PLATE;
      const onPlate = face === "visor" ? "w" : "l";
      canvas.onHead(boxCells(plate), "k");
      canvas.onHead([...eyes, ...glyph.mouth], (c) =>
        inBox(c, plate) ? onPlate : "k",
      );
      return;
    }
    case "mono": {
      const shift = (cells: readonly Cell[]): Cell[] =>
        cells.map(([x, y]) => [x + MONO_SHIFT, y] as const);
      canvas.onHead(boxCells(MONO_EYE), "w");
      canvas.onHead(
        [...shift(glyph.right), ...shift(glyph.brow), ...glyph.mouth],
        "k",
      );
      return;
    }
  }
}

/** The sprite's cells: 12 strings of 12 `SpriteCell` characters. */
export function composeSprite(
  appearance: Pick<BotAppearance, "shape" | "face" | "topper">,
  mood: Mood = "idle",
): SpriteGrid {
  const canvas = new Canvas();
  canvas.layer(SHAPES[appearance.shape]);
  if (mood === "idle") {
    canvas.layer(FACES[appearance.face]);
  } else {
    drawMoodFace(canvas, appearance.face, moodGlyph(mood));
  }
  const topper = TOPPERS[appearance.topper];
  canvas.layer(topper);
  if (mood === "thinking" && !/[^.]/.test(topper[0] ?? "")) {
    for (const dot of THINKING_DOTS) canvas.set(dot, "g");
  }
  return canvas.toGrid();
}

/** Hex colour per cell character for a bot colour. Identical in both themes. */
export function spritePalette(
  colour: BotColour,
): Readonly<Record<Exclude<SpriteCell, ".">, string>> {
  const ramp = COLOUR_RAMPS[colour];
  return {
    b: ramp.f,
    d: ramp.d,
    l: ramp.l,
    k: "#0B0E14",
    w: "#F4F7FB",
    g: "#C9D1E0",
    y: "#F5C66B",
    e: "#A7F3D0",
    s: "#138A5E",
  };
}

export interface SpritePath {
  fill: string;
  /** Horizontal runs in a 12×12 viewBox, e.g. "M2 2h8v1h-8z". */
  d: string;
}

/** One SVG path per colour, built from horizontal runs of equal cells. */
export function spritePaths(
  grid: SpriteGrid,
  palette: Readonly<Record<Exclude<SpriteCell, ".">, string>>,
): SpritePath[] {
  const byFill = new Map<string, string[]>();
  grid.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      const cell = row[x] as SpriteCell;
      let end = x + 1;
      while (end < row.length && row[end] === cell) end += 1;
      if (cell !== ".") {
        const fill = palette[cell];
        const runs = byFill.get(fill) ?? [];
        runs.push(`M${x} ${y}h${end - x}v1h-${end - x}z`);
        byFill.set(fill, runs);
      }
      x = end;
    }
  });
  return [...byFill].map(([fill, runs]) => ({ fill, d: runs.join("") }));
}

const pathCache = new Map<string, SpritePath[]>();

/** Cached `spritePaths(composeSprite(...))` for an appearance and mood. */
export function spritePathsFor(
  appearance: Pick<BotAppearance, "shape" | "face" | "topper" | "colour">,
  mood: Mood,
): SpritePath[] {
  const key = `${appearance.shape}|${appearance.face}|${appearance.topper}|${appearance.colour}|${mood}`;
  let paths = pathCache.get(key);
  if (!paths) {
    paths = spritePaths(
      composeSprite(appearance, mood),
      spritePalette(appearance.colour),
    );
    pathCache.set(key, paths);
  }
  return paths;
}
