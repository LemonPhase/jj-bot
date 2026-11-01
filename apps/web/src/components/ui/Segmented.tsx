import { type KeyboardEvent, type ReactNode, useRef } from "react";
import { cx } from "./cx";
import { rovingTabStop, rovingTarget } from "./roving";
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
   * `choice` (default): a radio group. One Tab stop; arrow keys, Home and End
   * move the selection.
   * `nav`: primary navigation in a <nav>; each item is a button and the active
   * one gets `aria-current="page"`.
   */
  kind?: "choice" | "nav";
  /** Ids of hint or error text describing a `choice` group (`aria-describedby`). */
  describedBy?: string;
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
  describedBy,
  className,
}: SegmentedProps<Value>) {
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const classes = cx(
    "ui-seg",
    variant !== "default" && `ui-seg--${variant}`,
    className,
  );
  const disabled = options.map((option) => Boolean(option.disabled));
  const tabStop = rovingTabStop(
    disabled,
    options.findIndex((option) => option.value === value),
  );

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, from: number) => {
    const target = rovingTarget(disabled, from, event.key, "both");
    const option = target === null ? undefined : options[target];
    if (target === null || !option) return;
    event.preventDefault();
    items.current[target]?.focus();
    if (option.value !== value) onChange(option.value);
  };

  const content = (option: SegmentedOption<Value>) => (
    <>
      {option.label}
      {option.count !== undefined && (
        <span className="ui-seg__count">{option.count}</span>
      )}
    </>
  );

  if (kind === "nav") {
    return (
      <nav className={classes} aria-label={label}>
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              className="ui-seg__item"
              disabled={option.disabled}
              aria-current={active ? "page" : undefined}
              onClick={() => {
                if (!active) onChange(option.value);
              }}
            >
              {content(option)}
            </button>
          );
        })}
      </nav>
    );
  }

  return (
    <div
      className={classes}
      role="radiogroup"
      aria-label={label}
      aria-describedby={describedBy}
    >
      {options.map((option, index) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            ref={(element) => {
              items.current[index] = element;
            }}
            type="button"
            role="radio"
            className="ui-seg__item"
            disabled={option.disabled}
            aria-checked={active}
            tabIndex={index === tabStop ? 0 : -1}
            onKeyDown={(event) => onKeyDown(event, index)}
            onClick={() => {
              if (!active) onChange(option.value);
            }}
          >
            {content(option)}
          </button>
        );
      })}
    </div>
  );
}
