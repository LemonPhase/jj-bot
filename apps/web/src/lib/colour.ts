import type { BotBody, BotColour } from "@jj/contracts";

/**
 * Bot colour data and colour maths. Bot colours are the same in both themes
 * (design appearance.json `colour.ramp`); the only theme-dependent use is
 * @mention text, see `mentionColour`.
 */

/**
 * The tones of a bot colour. The design's seven:
 * f fill (sprite body, swatch), d shade, l light highlight, t and s the 3D top
 * and side faces, v very dark (3D face plate), glow the topper glow.
 * Plus `text`, not in the design: a same-hue tone dark enough for 4.5:1 text
 * on the light grounds. It equals `d` where `d` already reaches that, and is a
 * darker `d` (same hue and saturation) for amber, lime, green and teal.
 */
export interface ColourRamp {
  f: string;
  d: string;
  l: string;
  t: string;
  s: string;
  v: string;
  glow: string;
  text: string;
}

export const COLOUR_RAMPS: Readonly<Record<BotColour, Readonly<ColourRamp>>> = {
  coral: {
    f: "#FF7A66",
    d: "#B8412F",
    l: "#FFD9D1",
    t: "#FF9585",
    s: "#D16454",
    v: "#381B16",
    glow: "rgba(255,122,102,.75)",
    text: "#B8412F",
  },
  amber: {
    f: "#F5B544",
    d: "#A8741C",
    l: "#FCE3B0",
    t: "#F7C469",
    s: "#C99438",
    v: "#36280F",
    glow: "rgba(245,181,68,.75)",
    text: "#8D6118",
  },
  lime: {
    f: "#A3E635",
    d: "#5E8A1A",
    l: "#E3F7C0",
    t: "#B5EB5D",
    s: "#86BD2B",
    v: "#24330C",
    glow: "rgba(163,230,53,.75)",
    text: "#4F7416",
  },
  green: {
    f: "#34D399",
    d: "#138A5E",
    l: "#A7F3D0",
    t: "#5DDCAD",
    s: "#2BAD7D",
    v: "#0B2E22",
    glow: "rgba(52,211,153,.75)",
    text: "#117852",
  },
  teal: {
    f: "#2DD4BF",
    d: "#0F8C7E",
    l: "#B5F1E8",
    t: "#57DDCC",
    s: "#25AE9D",
    v: "#0A2F2A",
    glow: "rgba(45,212,191,.75)",
    text: "#0D776B",
  },
  blue: {
    f: "#6AA2FF",
    d: "#2F5FC0",
    l: "#CFE0FF",
    t: "#88B5FF",
    s: "#5785D1",
    v: "#172438",
    glow: "rgba(106,162,255,.75)",
    text: "#2F5FC0",
  },
  violet: {
    f: "#A78BFA",
    d: "#6A4BC9",
    l: "#E4DAFF",
    t: "#B9A2FB",
    s: "#8972CD",
    v: "#251F37",
    glow: "rgba(167,139,250,.75)",
    text: "#6A4BC9",
  },
  pink: {
    f: "#F472B6",
    d: "#B23B7A",
    l: "#FBD0E6",
    t: "#F68EC5",
    s: "#C85D95",
    v: "#361928",
    glow: "rgba(244,114,182,.75)",
    text: "#B23B7A",
  },
};

/** The ramp for a bot colour. */
export function colourRamp(colour: BotColour): Readonly<ColourRamp> {
  return COLOUR_RAMPS[colour];
}

/** Body tones of the 3D block character (top, front, side). The 2D sprite does not use them. */
export const BODY_TONES: Readonly<
  Record<BotBody, Readonly<{ t: string; f: string; s: string }>>
> = {
  ivory: { t: "#ECECF0", f: "#D6D6DC", s: "#B6B6C0" },
  graphite: { t: "#4B4B55", f: "#3B3B45", s: "#2D2D35" },
};

/** Parses `#RGB` or `#RRGGBB` into 0–255 channels. */
export function parseHex(hex: string): [number, number, number] {
  const value = hex.trim().replace(/^#/, "");
  const full =
    value.length === 3
      ? value
          .split("")
          .map((char) => char + char)
          .join("")
      : value;
  if (!/^[0-9a-f]{6}$/i.test(full)) throw new Error(`Not a hex colour: ${hex}`);
  return [0, 2, 4].map((index) =>
    Number.parseInt(full.slice(index, index + 2), 16),
  ) as [number, number, number];
}

/** WCAG 2.x relative luminance of a hex colour. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio between two hex colours, from 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort(
    (x, y) => y - x,
  ) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Minimum contrast for body text (WCAG AA). */
export const TEXT_CONTRAST = 4.5;

/**
 * Light-theme grounds that @mentions sit on: the page (bot messages) and the
 * user bubble. Values mirror `--bg-app` and `--bg-bubble` in tokens.css.
 */
export const LIGHT_MENTION_GROUNDS = ["#F7F7F8", "#ECECF0"] as const;

const HEX_TONES = ["f", "d", "l", "t", "s", "v", "text"] as const;

/**
 * The light-theme mention colour (brief decision 3): of the colour's ramp, the
 * lightest tone that still reaches 4.5:1 on every light mention ground. Coral,
 * blue, violet and pink land on `d`. Amber, lime, green and teal fall short on
 * `d` (3.8–4.1:1) and land on their `text` tone, which keeps the hue instead of
 * the near-black `v`.
 */
function lightMentionColour(colour: BotColour): string {
  const ramp = COLOUR_RAMPS[colour];
  const passing = HEX_TONES.map((tone) => ramp[tone])
    .filter((hex) =>
      LIGHT_MENTION_GROUNDS.every(
        (ground) => contrastRatio(hex, ground) >= TEXT_CONTRAST,
      ),
    )
    .sort((a, b) => relativeLuminance(b) - relativeLuminance(a));
  // `v` passes for every colour, so `passing` is never empty.
  return passing[0] ?? ramp.v;
}

/**
 * The text colour of an @mention of a bot with this colour. Dark uses the fill
 * colour as drawn; light uses `lightMentionColour`. In CSS, use the matching
 * `--mention-<colour>` token, which follows the theme on its own.
 */
export function mentionColour(
  colour: BotColour,
  theme: "light" | "dark",
): string {
  return theme === "dark" ? COLOUR_RAMPS[colour].f : lightMentionColour(colour);
}
