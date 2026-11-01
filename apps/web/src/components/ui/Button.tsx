import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";
import "./ui.css";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
/** sm 28px (Studio turntable, speed pill), md 30px (headers), lg 32px (System sheet, steer). */
export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonStyleOptions {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Geist Mono at 12px (11.5px when `sm`), as on the steer toggle and the speed pill. */
  mono?: boolean;
}

/**
 * The class list of a pill button, for elements that must not be a <button>
 * (for example an <a> that navigates): `<a className={buttonClass({ variant: "secondary" })}>`.
 */
export function buttonClass({
  variant = "secondary",
  size = "md",
  mono = false,
}: ButtonStyleOptions = {}): string {
  return cx(
    "ui-btn",
    `ui-btn--${variant}`,
    size !== "md" && `ui-btn--${size}`,
    mono && "ui-btn--mono",
  );
}

export interface ButtonProps
  extends ButtonStyleOptions,
    Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-pressed"> {
  /**
   * Makes the pill a toggle (`aria-pressed`). Secondary toggles read --ink-3
   * when off and get an --ink border when on, like the steer toggle.
   */
  pressed?: boolean;
  /** Content before the label, such as an icon. */
  leading?: ReactNode;
}

/**
 * Pill button (SPEC §4). `danger` is the Stop pill: a secondary pill led by
 * an 8×8 failed square; the label stays monochrome.
 *
 * @example <Button variant="primary" onClick={create}>Create bot</Button>
 * @example <Button size="lg" mono pressed={steering} onClick={toggle}>steer</Button>
 */
export function Button({
  variant = "secondary",
  size = "md",
  mono = false,
  pressed,
  leading,
  className,
  children,
  type = "button",
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cx(buttonClass({ variant, size, mono }), className)}
      aria-pressed={pressed}
      {...rest}
    >
      {variant === "danger" && (
        <span className="ui-btn__square" aria-hidden="true" />
      )}
      {leading}
      {children}
    </button>
  );
}
