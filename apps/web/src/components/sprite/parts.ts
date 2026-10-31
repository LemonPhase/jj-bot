import type { BotFace, BotShape, BotTopper } from "@jj/contracts";

/**
 * Pixel data for the parametric 12×12 bot sprite, from the design's Bot Studio
 * parts (sprites.json `parts`). Row 0 is the top, column 0 the left, '.' is
 * transparent. Each part's layers are merged in the design's paint order
 * (shape: main, shade; face: dark, white, bright; topper: light, shade, leaf,
 * stem, grey, gold), which is lossless because no two layers of a part overlap,
 * with the one exception noted on `mono`.
 *
 * Cell characters and their colours (see `spritePalette` in compose.ts):
 *   b body  = colour.f      d shade = colour.d     l light = colour.l
 *   k ink   = #0B0E14       w white = #F4F7FB      g grey  = #C9D1E0
 *   y gold  = #F5C66B       e leaf  = #A7F3D0      s stem  = #138A5E
 */

export type SpriteCell =
  | "."
  | "b"
  | "d"
  | "l"
  | "k"
  | "w"
  | "g"
  | "y"
  | "e"
  | "s";

/** 12 rows of 12 cells. */
export type SpriteGrid = readonly string[];

export const GRID_SIZE = 12;

export const SHAPES: Readonly<Record<BotShape, SpriteGrid>> = {
  squircle: [
    "............",
    "............",
    "..bbbbbbbb..",
    ".bbbbbbbbbb.",
    ".bbbbbbbbbb.",
    "dbbbbbbbbbbd",
    "dbbbbbbbbbbd",
    "dbbbbbbbbbbd",
    ".bbbbbbbbbb.",
    ".bbbbbbbbbb.",
    "..bbbbbbbb..",
    "............",
  ],
  round: [
    "............",
    "............",
    "...bbbbbb...",
    "..bbbbbbbb..",
    ".bbbbbbbbbb.",
    ".bbbbbbbbbb.",
    ".bbbbbbbbbb.",
    ".bbbbbbbbbb.",
    ".bbbbbbbbbb.",
    "..bbbbbbbb..",
    "...dddddd...",
    "............",
  ],
  block: [
    "............",
    "............",
    "............",
    ".bbbbbbbbbb.",
    ".bbbbbbbbbb.",
    ".bbbbbbbbbb.",
    "dbbbbbbbbbbd",
    "dbbbbbbbbbbd",
    ".bbbbbbbbbb.",
    ".bbbbbbbbbb.",
    ".dddddddddd.",
    "............",
  ],
  gem: [
    "............",
    ".....bb.....",
    "....bbbb....",
    "...bbbbbb...",
    "..bbbbbbbb..",
    ".bbbbbbbbbb.",
    ".bbbbbbbbbb.",
    ".bbbbbbbbbb.",
    "..bbbbbbbb..",
    "...bbbbbb...",
    "....dddd....",
    ".....dd.....",
  ],
  dome: [
    "............",
    "............",
    "....bbbb....",
    "...bbbbbb...",
    "..bbbbbbbb..",
    ".bbbbbbbbbb.",
    ".bbbbbbbbbb.",
    ".bbbbbbbbbb.",
    ".bbbbbbbbbb.",
    ".bbbbbbbbbb.",
    ".dddddddddd.",
    "............",
  ],
};

/** Idle faces, as drawn in Studio. Moods replace them (see compose.ts). */
export const FACES: Readonly<Record<BotFace, SpriteGrid>> = {
  dots: [
    "............",
    "............",
    "............",
    "............",
    "............",
    "...kw..kw...",
    "...kk..kk...",
    "............",
    ".....kk.....",
    "............",
    "............",
    "............",
  ],
  visor: [
    "............",
    "............",
    "............",
    "............",
    "............",
    "..kwwkkwwk..",
    "..kkkkkkkk..",
    "............",
    "............",
    "............",
    "............",
    "............",
  ],
  screen: [
    "............",
    "............",
    "............",
    "............",
    "..kkkkkkkk..",
    "..kllkkllk..",
    "..kllkkllk..",
    "..kkkllkkk..",
    "..kkkkkkkk..",
    "............",
    "............",
    "............",
  ],
  // Design defect (SPEC §15): Studio paints the 2×2 pupil before the white eye,
  // hiding it. The pupil is painted over the white here, as the brief requires.
  mono: [
    "............",
    "............",
    "............",
    "............",
    "....wwww....",
    "....wkkw....",
    "....wkkw....",
    "....wwww....",
    "............",
    ".....kk.....",
    "............",
    "............",
  ],
};

/** Toppers use rows 0–2 only; the remaining rows are empty. */
export const TOPPERS: Readonly<Record<BotTopper, SpriteGrid>> = {
  antenna: [".....ll.....", ".....dd.....", "............"],
  dish: ["........l.l.", ".........d..", "........d..."],
  sprout: ["...ee..ee...", ".....ss.....", "............"],
  crest: [".....ll.....", "....llll....", "............"],
  propeller: [".ggggddgggg.", ".....dd.....", "............"],
  halo: ["...yyyyyy...", "............", "............"],
  none: ["............", "............", "............"],
};
