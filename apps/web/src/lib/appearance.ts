import type {
  BotAppearance,
  BotBody,
  BotColour,
  BotFace,
  BotGait,
  BotShape,
  BotTopper,
} from "@jj/contracts";

/**
 * UI labels, notes and presets for the Bot Studio appearance enums (design
 * appearance.json). The enum values themselves live in @jj/contracts.
 */

export const SHAPE_LABELS: Readonly<Record<BotShape, string>> = {
  squircle: "Squircle",
  round: "Round",
  block: "Block",
  gem: "Gem",
  dome: "Dome",
};

export const FACE_LABELS: Readonly<Record<BotFace, string>> = {
  dots: "Dots",
  visor: "Visor",
  screen: "Screen",
  mono: "Mono",
};

export const TOPPER_LABELS: Readonly<Record<BotTopper, string>> = {
  antenna: "Antenna",
  dish: "Dish",
  sprout: "Sprout",
  crest: "Crest",
  propeller: "Propeller",
  halo: "Halo",
  none: "None",
};

/** Shown next to the TOPPER heading in Studio. */
export const TOPPER_NOTES: Readonly<Record<BotTopper, string>> = {
  antenna: "Tip pulses while it talks",
  dish: "Dish sweeps while it works",
  sprout: "Leaves wiggle while it walks",
  crest: "Crest glows while it talks",
  propeller: "Spins up while it walks",
  halo: "Floats, bobs faster while it talks",
  none: "No topper",
};

export const COLOUR_LABELS: Readonly<Record<BotColour, string>> = {
  coral: "Coral",
  amber: "Amber",
  lime: "Lime",
  green: "Green",
  teal: "Teal",
  blue: "Blue",
  violet: "Violet",
  pink: "Pink",
};

export const BODY_LABELS: Readonly<Record<BotBody, string>> = {
  ivory: "Ivory",
  graphite: "Graphite",
};

/** Studio labels the gait group "WALK". */
export const GAIT_LABELS: Readonly<Record<BotGait, string>> = {
  hop: "Hop",
  glide: "Glide",
  waddle: "Waddle",
};

/** Shown next to the WALK heading in Studio. */
export const GAIT_NOTES: Readonly<Record<BotGait, string>> = {
  hop: "bouncy hop with swinging arms",
  glide: "hovers forward, arms trailing",
  waddle: "wide side-to-side sway",
};

export interface AppearancePreset {
  name: string;
  appearance: BotAppearance;
}

/** Studio "Start from" presets, in design order. Studio opens on "Teal Dome". */
export const APPEARANCE_PRESETS: readonly AppearancePreset[] = [
  {
    name: "Juno",
    appearance: {
      shape: "squircle",
      face: "visor",
      topper: "antenna",
      colour: "coral",
      body: "ivory",
      gait: "hop",
    },
  },
  {
    name: "Kite",
    appearance: {
      shape: "round",
      face: "dots",
      topper: "dish",
      colour: "blue",
      body: "ivory",
      gait: "hop",
    },
  },
  {
    name: "Moss",
    appearance: {
      shape: "block",
      face: "dots",
      topper: "sprout",
      colour: "green",
      body: "ivory",
      gait: "waddle",
    },
  },
  {
    name: "Vesper",
    appearance: {
      shape: "gem",
      face: "mono",
      topper: "crest",
      colour: "violet",
      body: "ivory",
      gait: "glide",
    },
  },
  {
    name: "Teal Dome",
    appearance: {
      shape: "dome",
      face: "screen",
      topper: "propeller",
      colour: "teal",
      body: "graphite",
      gait: "glide",
    },
  },
  {
    name: "Pink Halo",
    appearance: {
      shape: "round",
      face: "mono",
      topper: "halo",
      colour: "pink",
      body: "ivory",
      gait: "glide",
    },
  },
  {
    name: "Amber Block",
    appearance: {
      shape: "block",
      face: "visor",
      topper: "antenna",
      colour: "amber",
      body: "graphite",
      gait: "waddle",
    },
  },
  {
    name: "Lime Sprout",
    appearance: {
      shape: "squircle",
      face: "screen",
      topper: "sprout",
      colour: "lime",
      body: "ivory",
      gait: "hop",
    },
  },
];

/** "Squircle · Visor · Antenna · Coral · Ivory · Hop", as the Studio preview summary shows it. */
export function appearanceSummary(appearance: BotAppearance): string {
  return [
    SHAPE_LABELS[appearance.shape],
    FACE_LABELS[appearance.face],
    TOPPER_LABELS[appearance.topper],
    COLOUR_LABELS[appearance.colour],
    BODY_LABELS[appearance.body],
    GAIT_LABELS[appearance.gait],
  ].join(" · ");
}

/** The pre-sprite avatar glyph drawn for each appearance face. Legacy: PixelSprite replaces it. */
export type BotGlyph = "visor" | "radar" | "pixel" | "prism";

const FACE_GLYPHS: Readonly<Record<BotFace, BotGlyph>> = {
  visor: "visor",
  dots: "radar",
  screen: "pixel",
  mono: "prism",
};

export const faceGlyph = (face: BotFace): BotGlyph => FACE_GLYPHS[face];
