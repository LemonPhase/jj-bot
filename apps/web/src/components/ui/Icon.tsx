/**
 * Stroke icons from SPEC §3 (24-unit viewBox, round caps and joins, stroked
 * in currentColor). `close`, `chevron-down`, `settings` and `arrow-left` are
 * not in the design; they follow the same drawing rules.
 */
const ICONS = {
  plus: { d: "M12 5v14M5 12h14", width: 2 },
  sun: {
    d: "M16 12a4 4 0 1 1-8 0a4 4 0 1 1 8 0zM12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4",
    width: 1.8,
  },
  moon: { d: "M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z", width: 1.8 },
  panel: {
    d: "M6.5 4.5h11a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3h-11a3 3 0 0 1-3-3v-9a3 3 0 0 1 3-3zM14.5 4.5v15",
    width: 1.8,
  },
  send: { d: "M12 19V5M5.5 11.5L12 5l6.5 6.5", width: 2 },
  "arrow-right": { d: "M5 12h14M13 6l6 6-6 6", width: 2 },
  close: { d: "M6 6l12 12M18 6L6 18", width: 2 },
  "chevron-down": { d: "M6 9l6 6 6-6", width: 1.8 },
  "arrow-left": { d: "M19 12H5M11 6l-6 6 6 6", width: 2 },
  /** Sliders: the Settings entry in the sidebar footer. */
  settings: {
    d: "M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4",
    width: 1.8,
  },
} as const;

export type IconName = keyof typeof ICONS;
export const ICON_NAMES = Object.keys(ICONS) as IconName[];

export interface IconProps {
  name: IconName;
  /** CSS px. The design uses 16 (plus, send, sun, moon), 17 (panel) and 15 (arrow). */
  size?: number;
  /** Accessible name. Without it the icon is decorative. */
  label?: string;
  className?: string;
}

export function Icon({ name, size = 16, label, className }: IconProps) {
  const icon = ICONS[name];
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={icon.width}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...(label
        ? { role: "img", "aria-label": label }
        : { "aria-hidden": true, focusable: false })}
    >
      <path d={icon.d} />
    </svg>
  );
}
