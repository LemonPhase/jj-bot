import {
  type HTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  useId,
  useRef,
} from "react";
import { cx } from "./cx";
import { rovingTabStop, rovingTarget } from "./roving";
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
  /** Names the tab list, e.g. "View" for Progress | Graph | Office. */
  label: string;
  /**
   * The id of the panel each tab controls. Render that panel with
   * `<TabPanel id={panelId(value)}>`; the tab and panel then reference each
   * other (`aria-controls`, `aria-labelledby`).
   */
  panelId?: (value: Value) => string;
  className?: string;
}

/** The id Tabs gives the tab that controls the panel `panelId`. */
export const tabIdForPanel = (panelId: string): string => `${panelId}-tab`;

/**
 * Underlined text tabs (SPEC §4), as an ARIA tab list: one Tab stop, Left and
 * Right arrows (and Home, End) move to and select the neighbouring tab.
 *
 * @example
 * const panel = (view: View) => `task-view-${view}`;
 * <Tabs label="View" value={view} onChange={setView} panelId={panel}
 *   items={[{ value: "progress", label: "Progress" }, { value: "graph", label: "Graph" }]} />
 * <TabPanel id={panel(view)}>…</TabPanel>
 */
export function Tabs<Value extends string>({
  items,
  value,
  onChange,
  label,
  panelId,
  className,
}: TabsProps<Value>) {
  const fallbackPrefix = useId();
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const disabled = items.map((item) => Boolean(item.disabled));
  const tabStop = rovingTabStop(
    disabled,
    items.findIndex((item) => item.value === value),
  );

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, from: number) => {
    const target = rovingTarget(disabled, from, event.key, "horizontal");
    const item = target === null ? undefined : items[target];
    if (target === null || !item) return;
    event.preventDefault();
    tabs.current[target]?.focus();
    if (item.value !== value) onChange(item.value);
  };

  return (
    <div
      className={cx("ui-tabs", className)}
      role="tablist"
      aria-label={label}
      aria-orientation="horizontal"
    >
      {items.map((item, index) => {
        const active = item.value === value;
        const controls = panelId?.(item.value);
        return (
          <button
            key={item.value}
            ref={(element) => {
              tabs.current[index] = element;
            }}
            type="button"
            role="tab"
            id={
              controls
                ? tabIdForPanel(controls)
                : `${fallbackPrefix}-${item.value}`
            }
            className="ui-tab"
            disabled={item.disabled}
            aria-selected={active}
            aria-controls={controls}
            tabIndex={index === tabStop ? 0 : -1}
            onKeyDown={(event) => onKeyDown(event, index)}
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

export interface TabPanelProps extends HTMLAttributes<HTMLDivElement> {
  /** The id from the Tabs `panelId(value)` for the tab that shows this panel. */
  id: string;
  children: ReactNode;
}

/**
 * The region a tab shows: `role="tabpanel"`, labelled by its tab, and
 * focusable so keyboard users can reach content without controls.
 */
export function TabPanel({ id, children, ...rest }: TabPanelProps) {
  return (
    <div
      role="tabpanel"
      id={id}
      aria-labelledby={tabIdForPanel(id)}
      tabIndex={0}
      {...rest}
    >
      {children}
    </div>
  );
}
