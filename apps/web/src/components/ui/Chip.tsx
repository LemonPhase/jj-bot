import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";
import "./ui.css";

export interface ChipProps
  extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-pressed"> {
  /** On: --bg-active fill, --ink text, --line-chip-on border. */
  selected: boolean;
  /** Before the label, e.g. a 14px shape silhouette. */
  leading?: ReactNode;
}

/**
 * Toggle chip (SPEC §11): 30px pill, 12.5px, `aria-pressed`. Used for the
 * Studio part pickers; fits any pick-one or pick-many list.
 *
 * @example <Chip selected={shape === "gem"} onClick={() => setShape("gem")}>Gem</Chip>
 */
export function Chip({
  selected,
  leading,
  className,
  children,
  type = "button",
  ...rest
}: ChipProps) {
  return (
    <button
      type={type}
      className={cx("ui-chip", className)}
      aria-pressed={selected}
      {...rest}
    >
      {leading}
      {children}
    </button>
  );
}
