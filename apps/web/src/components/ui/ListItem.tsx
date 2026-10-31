import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";
import "./ui.css";

export interface ListItemProps
  extends Omit<
    ButtonHTMLAttributes<HTMLButtonElement>,
    "aria-pressed" | "title" | "children"
  > {
  /** Main line: 14px/500 (row) or 13.5px/500 clamped to two lines (stack). */
  title: ReactNode;
  /** Second line (row) or the left of the meta row (stack), usually a status. */
  subtitle?: ReactNode;
  /** Leading visual in `row` layout, usually a 36px sprite. */
  leading?: ReactNode;
  /** Right of the meta row in `stack` layout, usually participant sprites. */
  trailing?: ReactNode;
  /**
   * `row`: the bot item (sprite, then name over status line).
   * `stack`: the task item (title, then a meta row with status and sprites).
   */
  layout?: "row" | "stack";
  /**
   * Selected look (--bg-selected) only. Add the semantics that fit: `pressed`
   * for a toggle, or `aria-current` for the item whose view is shown.
   */
  selected?: boolean;
  /** Emits `aria-pressed` (and the selected look unless `selected` says otherwise). */
  pressed?: boolean;
  /** Dims the title to --ink-3, as for completed tasks. */
  muted?: boolean;
}

/**
 * Sidebar row (SPEC §3): a full-width button, radius 10, hover on
 * --bg-hover, selected on --bg-selected.
 *
 * @example
 * <ListItem pressed={bot.id === selectedId} onClick={() => select(bot.id)}
 *   leading={<Avatar appearance={bot.appearance} name={bot.name} size={36} decorative />}
 *   title={bot.name} subtitle={<StatusTag size="sans" status={bot.presence} />} />
 */
export function ListItem({
  title,
  subtitle,
  leading,
  trailing,
  layout = "row",
  selected,
  pressed,
  muted = false,
  className,
  type = "button",
  ...rest
}: ListItemProps) {
  const classes = cx(
    "ui-list-item",
    layout === "stack" && "ui-list-item--stack",
    (selected ?? pressed) && "ui-list-item--selected",
    muted && "ui-list-item--muted",
    className,
  );
  if (layout === "stack") {
    return (
      <button type={type} className={classes} aria-pressed={pressed} {...rest}>
        <span className="ui-list-item__title clamp2">{title}</span>
        {(subtitle || trailing) && (
          <span className="ui-list-item__meta">
            {subtitle}
            {trailing}
          </span>
        )}
      </button>
    );
  }
  return (
    <button type={type} className={classes} aria-pressed={pressed} {...rest}>
      {leading}
      <span className="ui-list-item__body">
        <span className="ui-list-item__title clamp1">{title}</span>
        {subtitle && <span className="ui-list-item__subtitle">{subtitle}</span>}
      </span>
      {trailing}
    </button>
  );
}

export interface SectionLabelProps {
  children: ReactNode;
  /** `label` .08em (BOTS, TASKS); `part` .06em (Studio parts, IN PARALLEL). */
  tracking?: "label" | "part";
  as?: "div" | "h2" | "h3" | "span";
  id?: string;
  className?: string;
}

/** Mono 11px uppercase label in --ink-muted. */
export function SectionLabel({
  children,
  tracking = "label",
  as: Element = "div",
  id,
  className,
}: SectionLabelProps) {
  return (
    <Element
      id={id}
      className={cx(
        "ui-section-label",
        tracking === "part" && "ui-section-label--part",
        className,
      )}
    >
      {children}
    </Element>
  );
}

/**
 * Day divider (SPEC §4): mono 11px uppercase label between two --line-subtle
 * rules. Plain text for assistive technology (a `separator` role would hide it).
 */
export function DayDivider({ children }: { children: ReactNode }) {
  return <div className="ui-divider">{children}</div>;
}
