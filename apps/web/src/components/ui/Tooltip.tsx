import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useEffect,
  useId,
  useState,
} from "react";
import { cx } from "./cx";
import "./ui.css";

export interface TooltipProps {
  /** Short text; shown as an inverted pixel overlay. */
  content: ReactNode;
  /**
   * The trigger. A focusable element (button, link) receives `aria-describedby`
   * directly. Wrap anything else with `focusable` so keyboard users can reach it.
   */
  children: ReactElement<{ "aria-describedby"?: string }>;
  /** Makes the wrapper itself focusable, for non-interactive triggers like a StatusTag. */
  focusable?: boolean;
  placement?: "top" | "bottom";
  className?: string;
}

/**
 * A simple tooltip: shown on hover and keyboard focus, dismissed with Escape,
 * and wired to the trigger with `aria-describedby`. Use it for supplementary
 * text only; never hide required information in it.
 *
 * @example <Tooltip content="waiting for you" focusable><StatusTag status={session} /></Tooltip>
 */
export function Tooltip({
  content,
  children,
  focusable = false,
  placement = "top",
  className,
}: TooltipProps) {
  const id = useId();
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const trigger = focusable ? (
    <span className="ui-tooltip__trigger" tabIndex={0} aria-describedby={id}>
      {children}
    </span>
  ) : isValidElement(children) ? (
    cloneElement(children, { "aria-describedby": id })
  ) : (
    children
  );

  return (
    <span
      className={cx("ui-tooltip", className)}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      {trigger}
      <span
        role="tooltip"
        id={id}
        className={cx(
          "ui-tooltip__bubble",
          placement === "bottom" && "ui-tooltip__bubble--bottom",
        )}
        hidden={!open}
      >
        {content}
      </span>
    </span>
  );
}
