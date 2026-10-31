/** UI-only data derived from `bot.appearance`. */
import { BOT_COLOURS, type BotColour, type BotFace } from "@jj/contracts";

/** Position of the colour in `BOT_COLOURS`, for indexed tokens such as `--bot-3`. */
export const colourIndex = (colour: BotColour): number =>
  BOT_COLOURS.indexOf(colour);

/** Fill tone of each bot colour (design appearance.json); the same in both themes. */
export const BOT_COLOUR_HEX: Record<BotColour, string> = {
  coral: "#FF7A66",
  amber: "#F5B544",
  lime: "#A3E635",
  green: "#34D399",
  teal: "#2DD4BF",
  blue: "#6AA2FF",
  violet: "#A78BFA",
  pink: "#F472B6",
};

export const colourHex = (colour: BotColour): string => BOT_COLOUR_HEX[colour];

/** The pre-sprite avatar glyph drawn for each appearance face. */
export type BotGlyph = "visor" | "radar" | "pixel" | "prism";

const FACE_GLYPHS: Record<BotFace, BotGlyph> = {
  visor: "visor",
  dots: "radar",
  screen: "pixel",
  mono: "prism",
};

export const faceGlyph = (face: BotFace): BotGlyph => FACE_GLYPHS[face];
