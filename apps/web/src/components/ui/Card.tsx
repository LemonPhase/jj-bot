import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";
import "./ui.css";

export interface CardStyleOptions {
  /** `compact`: padding 10px 12px, radius 10 (graph nodes, gate). Default: 12px 14px, radius 12. */
  density?: "default" | "compact";
  /** Selected look: --ink border on --bg-selected (selected graph node). */
  selected?: boolean;
}

/** The class list of a card, for custom elements. */
export function cardClass({
  density = "default",
  selected = false,
}: CardStyleOptions = {}): string {
  return cx(
    "ui-card",
    density === "compact" && "ui-card--compact",
    selected && "ui-card--selected",
  );
}

export interface CardProps
  extends CardStyleOptions,
    HTMLAttributes<HTMLElement> {
  /** Landmark or grouping element; `section` with an aria-label for named cards. */
  as?: "div" | "section" | "article" | "li";
  children: ReactNode;
}

/**
 * A raised box (SPEC §5): --bg-raised, 1px --line, radius 12, column gap 8.
 *
 * @example <Card as="section" aria-label="Selected session">…</Card>
 */
export function Card({
  as: Element = "div",
  density,
  selected,
  className,
  children,
  ...rest
}: CardProps) {
  return (
    <Element
      className={cx(cardClass({ density, selected }), className)}
      {...rest}
    >
      {children}
    </Element>
  );
}

export interface CardButtonProps
  extends CardStyleOptions,
    Omit<ButtonHTMLAttributes<HTMLButtonElement>, "aria-pressed"> {
  /** Emits `aria-pressed` (and the selected look unless `selected` says otherwise). */
  pressed?: boolean;
}

/**
 * A clickable card (graph node, expanded session card). `selected` sets the
 * look only; pass `pressed` for toggle semantics (`aria-pressed`).
 */
export function CardButton({
  density,
  selected,
  pressed,
  className,
  type = "button",
  children,
  ...rest
}: CardButtonProps) {
  return (
    <button
      type={type}
      className={cx(
        cardClass({ density, selected: selected ?? pressed }),
        "ui-card--interactive",
        className,
      )}
      aria-pressed={pressed}
      {...rest}
    >
      {children}
    </button>
  );
}

export interface PanelProps extends HTMLAttributes<HTMLElement> {
  /** Accessible name of the landmark, e.g. "Progress", "Execution graph", "Office". */
  label: string;
  as?: "aside" | "section";
  children: ReactNode;
}

/**
 * Right-panel chrome (SPEC §5.2): padding 16px 22px, 1px --line-subtle left
 * border, column gap 18. Size it with flex in the screen layout.
 */
export function Panel({
  label,
  as: Element = "aside",
  className,
  children,
  ...rest
}: PanelProps) {
  return (
    <Element className={cx("ui-panel", className)} aria-label={label} {...rest}>
      {children}
    </Element>
  );
}
