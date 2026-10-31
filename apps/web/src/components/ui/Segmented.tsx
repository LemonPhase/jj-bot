import type { ReactNode } from "react";
import { cx } from "./cx";
import "./ui.css";

export interface SegmentedOption<Value extends string> {
  value: Value;
  label: ReactNode;
  /** Mono count after the label, as on the Bots / Tasks switch. */
  count?: number;
  disabled?: boolean;
}

export interface SegmentedProps<Value extends string> {
  options: readonly SegmentedOption<Value>[];
  value: Value;
  onChange: (value: Value) => void;
  /** Names the group for assistive technology. */
  label: string;
  /**
   * `default`: the sidebar Bots / Tasks switch (13px, track radius 10).
   * `compact`: Studio "Preview motion" (28px items, 12.5px).
   * `mono`: the 2D / 3D switch (92px track, mono 11.5px).
   */
  variant?: "default" | "compact" | "mono";
  /**
   * `choice` (default): a group of `aria-pressed` buttons.
   * `nav`: primary navigation in a <nav>; the active item gets `aria-current="page"`.
   */
  kind?: "choice" | "nav";
  className?: string;
}

/**
 * A segmented control (SPEC §4): equal-width items on a --bg-surface track,
 * the active one on --bg-active.
 *
 * @example
 * <Segmented label="Primary" kind="nav" value={tab} onChange={setTab}
 *   options={[{ value: "bots", label: "Bots", count: bots.length },
 *             { value: "tasks", label: "Tasks", count: tasks.length }]} />
 */
export function Segmented<Value extends string>({
  options,
  value,
  onChange,
  label,
  variant = "default",
  kind = "choice",
  className,
}: SegmentedProps<Value>) {
  const classes = cx(
    "ui-seg",
    variant !== "default" && `ui-seg--${variant}`,
    className,
  );
  const items = options.map((option) => {
    const active = option.value === value;
    return (
      <button
        key={option.value}
        type="button"
        className="ui-seg__item"
        disabled={option.disabled}
        aria-pressed={kind === "choice" ? active : undefined}
        aria-current={kind === "nav" && active ? "page" : undefined}
        onClick={() => {
          if (!active) onChange(option.value);
        }}
      >
        {option.label}
        {option.count !== undefined && (
          <span className="ui-seg__count">{option.count}</span>
        )}
      </button>
    );
  });
  return kind === "nav" ? (
    <nav className={classes} aria-label={label}>
      {items}
    </nav>
  ) : (
    <div className={classes} role="group" aria-label={label}>
      {items}
    </div>
  );
}
