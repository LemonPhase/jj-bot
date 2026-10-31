import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";
import "./ui.css";

export interface IconButtonProps
  extends Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "aria-label" | "aria-pressed" | "children"
  > {
  /** Accessible name; also the hover title. Required: the button has no text. */
  label: string;
  /** The icon, usually `<Icon name="plus" />` or `<PixelIcon name="play" />`. */
  icon: ReactNode;
  /**
   * `ghost` (default): 30×30, radius 8, transparent.
   * `primary`: a circle on --btn-primary-bg (send, play/pause).
   */
  variant?: "ghost" | "primary";
  /** md 30px (default), lg 34px (the composer's send button). */
  size?: "md" | "lg";
  /** Ghost icon colour: `muted` --ink-3 (default; theme toggle, panel) or `ink` (the sidebar plus). */
  tone?: "muted" | "ink";
  /** Toggle state (`aria-pressed`), shown on --bg-active, like the Profile toggle. */
  pressed?: boolean;
  /** Marks the button as the current page (`aria-current`), like New bot while on Studio. */
  current?: boolean;
}

/**
 * A square or round button holding one icon (SPEC §4).
 *
 * @example <IconButton label="New bot" icon={<Icon name="plus" />} tone="ink" />
 * @example <IconButton label="Send" variant="primary" size="lg" icon={<Icon name="send" />} type="submit" />
 */
export function IconButton({
  label,
  icon,
  variant = "ghost",
  size = "md",
  tone = "muted",
  pressed,
  current,
  className,
  type = "button",
  title,
  ...rest
}: IconButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        "ui-icon-btn",
        variant === "primary" && "ui-icon-btn--primary",
        size === "lg" && "ui-icon-btn--lg",
        variant === "ghost" && tone === "ink" && "ui-icon-btn--ink",
        className,
      )}
      aria-label={label}
      title={title ?? label}
      aria-pressed={pressed}
      aria-current={current ? "page" : undefined}
      {...rest}
    >
      {icon}
    </button>
  );
}
