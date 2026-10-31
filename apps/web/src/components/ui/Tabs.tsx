import type { ReactNode } from "react";
import { cx } from "./cx";
import "./ui.css";

export interface TabItem<Value extends string> {
  value: Value;
  label: ReactNode;
  disabled?: boolean;
}

export interface TabsProps<Value extends string> {
  items: readonly TabItem<Value>[];
  value: Value;
  onChange: (value: Value) => void;
  /** Names the group, e.g. "View" for Progress | Graph | Office. */
  label: string;
  className?: string;
}

/**
 * Underlined text tabs (SPEC §4). As in the design, a `role="group"` of
 * `aria-pressed` buttons that switch the panel below.
 *
 * @example <Tabs label="View" value={view} onChange={setView}
 *   items={[{ value: "progress", label: "Progress" }, { value: "graph", label: "Graph" }]} />
 */
export function Tabs<Value extends string>({
  items,
  value,
  onChange,
  label,
  className,
}: TabsProps<Value>) {
  return (
    <div className={cx("ui-tabs", className)} role="group" aria-label={label}>
      {items.map((item) => {
        const active = item.value === value;
        return (
          <button
            key={item.value}
            type="button"
            className="ui-tab"
            disabled={item.disabled}
            aria-pressed={active}
            onClick={() => {
              if (!active) onChange(item.value);
            }}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
