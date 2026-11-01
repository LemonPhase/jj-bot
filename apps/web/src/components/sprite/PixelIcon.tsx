import "./sprite.css";

/**
 * The design's non-bot pixel icons (sprites.json `ui`). Colours come from
 * tokens, so they follow the theme:
 *   brand  JJ Bot mark, body in --ink; the eyes are holes that show the ground
 *   gate   verification gate, frame --gate-frame, tick --status-completed
 *   play   / pause  Office replay controls, in currentColor (use on a primary circle)
 */
export type PixelIconName = "brand" | "gate" | "play" | "pause";

interface IconData {
  viewBox: string;
  grid: readonly string[];
  fills: Readonly<Record<string, string>>;
}

const ICONS: Readonly<Record<PixelIconName, IconData>> = {
  brand: {
    viewBox: "0 0 10 10",
    grid: [
      "....a.....",
      "....a.....",
      ".aaaaaaaa.",
      ".aaaaaaaa.",
      ".aa.aa.aa.",
      ".aa.aa.aa.",
      ".aaaaaaaa.",
      ".aaaaaaaa.",
      ".aaaaaaaa.",
      "..........",
    ],
    fills: { a: "var(--ink)" },
  },
  gate: {
    // The design draws it in a "-1 -1 12 12" viewBox; this grid includes that margin.
    viewBox: "0 0 12 12",
    grid: [
      "............",
      "............",
      "..aaaaaaaa..",
      "..a......a..",
      "..a......a..",
      "..a....b.a..",
      "..a.b.b..a..",
      "..a..b...a..",
      "..a......a..",
      "...aaaaaa...",
      "............",
      "............",
    ],
    fills: { a: "var(--gate-frame)", b: "var(--status-completed)" },
  },
  play: {
    viewBox: "0 0 7 8",
    grid: [
      ".......",
      "..a....",
      "..aa...",
      "..aaa..",
      "..aaa..",
      "..aa...",
      "..a....",
    ],
    fills: { a: "currentColor" },
  },
  pause: {
    viewBox: "0 0 6 6",
    grid: ["......", ".a..a.", ".a..a.", ".a..a.", ".a..a.", "......"],
    fills: { a: "currentColor" },
  },
};

/** Horizontal runs of `char` as an SVG path. */
function runs(grid: readonly string[], char: string): string {
  let d = "";
  grid.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (row[x] !== char) {
        x += 1;
        continue;
      }
      let end = x + 1;
      while (row[end] === char) end += 1;
      d += `M${x} ${y}h${end - x}v1h-${end - x}z`;
      x = end;
    }
  });
  return d;
}

export interface PixelIconProps {
  name: PixelIconName;
  /** Width in CSS px (brand: 20 in the sidebar; gate: 24; play/pause: 12). */
  size?: number;
  /** Accessible name. Without it the icon is decorative. */
  label?: string;
  className?: string;
}

export function PixelIcon({
  name,
  size = 20,
  label,
  className,
}: PixelIconProps) {
  const icon = ICONS[name];
  const [, , width = 1, height = 1] = icon.viewBox.split(" ").map(Number);
  return (
    <svg
      className={className ? `ui-sprite ${className}` : "ui-sprite"}
      viewBox={icon.viewBox}
      width={size}
      height={(size * height) / width}
      shapeRendering="crispEdges"
      {...(label
        ? { role: "img", "aria-label": label }
        : { "aria-hidden": true, focusable: false })}
    >
      {Object.entries(icon.fills).map(([char, fill]) => (
        <path key={char} fill={fill} d={runs(icon.grid, char)} />
      ))}
    </svg>
  );
}
