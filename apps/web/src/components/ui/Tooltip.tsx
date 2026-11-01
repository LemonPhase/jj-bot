import {
  cloneElement,
  isValidElement,
  type ReactElement,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { cx } from "./cx";
import "./ui.css";

/** How long the bubble lingers after the pointer or focus leaves, in ms. */
const HIDE_DELAY = 120;
/** With `placement="auto"`, flip below the trigger when less than this fits above. */
const AUTO_FLIP_PX = 48;

export interface TooltipProps {
  /** Short text; shown as an inverted pixel overlay. */
  content: ReactNode;
  /**
   * The trigger. Without `focusable` it should be focusable itself (a button
   * or link); it receives `aria-describedby`. With `focusable`, any content.
   */
  children: ReactElement<{ "aria-describedby"?: string }> | ReactNode;
  /**
   * Wraps the content in a real <button> so keyboard and screen-reader users
   * can reach the tip (clicking it pins the tip open). Use it for
   * non-interactive triggers such as a StatusTag, never inside another button.
   */
  focusable?: boolean;
  /** `auto` places it below when the trigger is near the top of the viewport. */
  placement?: "top" | "bottom" | "auto";
  /**
   * Links the tip to the trigger with `aria-describedby` (default true). Turn
   * off when the tip repeats the trigger's accessible name, as for icon buttons.
   */
  describe?: boolean;
  className?: string;
}

/**
 * A simple tooltip: shown on hover and keyboard focus, kept open while the
 * pointer is over the bubble, dismissed with Escape. Use it for supplementary
 * text only; never hide required information in it. The bubble renders inline
 * (no portal), so an ancestor with `overflow: hidden | auto` clips it; turn it
 * off or place it inside such containers with care.
 *
 * @example <Tooltip content="waiting for you" focusable><StatusTag status={task} /></Tooltip>
 */
export function Tooltip({
  content,
  children,
  focusable = false,
  placement = "top",
  describe = true,
  className,
}: TooltipProps) {
  const id = useId();
  const wrapper = useRef<HTMLSpanElement>(null);
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [below, setBelow] = useState(placement === "bottom");

  const cancelHide = useCallback(() => {
    if (hideTimer.current) clearTimeout(hideTimer.current);
    hideTimer.current = null;
  }, []);

  const show = useCallback(() => {
    cancelHide();
    if (placement === "auto")
      setBelow(
        (wrapper.current?.getBoundingClientRect().top ?? AUTO_FLIP_PX) <
          AUTO_FLIP_PX,
      );
    setOpen(true);
  }, [cancelHide, placement]);

  const scheduleHide = useCallback(() => {
    cancelHide();
    hideTimer.current = setTimeout(() => setOpen(false), HIDE_DELAY);
  }, [cancelHide]);

  useEffect(() => cancelHide, [cancelHide]);

  useEffect(() => {
    if (placement !== "auto") setBelow(placement === "bottom");
  }, [placement]);

  const visible = open || pinned;
  useEffect(() => {
    if (!visible) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      cancelHide();
      setOpen(false);
      setPinned(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible, cancelHide]);

  const describedBy = describe ? id : undefined;
  let trigger: ReactNode;
  if (focusable) {
    trigger = (
      <button
        type="button"
        className="ui-tooltip__trigger"
        aria-describedby={describedBy}
        onClick={() => setPinned((value) => !value)}
      >
        {children}
      </button>
    );
  } else if (describedBy && isValidElement(children)) {
    trigger = cloneElement(
      children as ReactElement<{ "aria-describedby"?: string }>,
      { "aria-describedby": describedBy },
    );
  } else {
    trigger = children;
  }

  return (
    <span
      ref={wrapper}
      className={cx("ui-tooltip", className)}
      onMouseEnter={show}
      onMouseLeave={() => {
        setPinned(false);
        scheduleHide();
      }}
      onFocus={show}
      onBlur={() => {
        setPinned(false);
        scheduleHide();
      }}
    >
      {trigger}
      <span
        role="tooltip"
        id={id}
        className={cx(
          "ui-tooltip__bubble",
          below && "ui-tooltip__bubble--bottom",
        )}
        hidden={!visible}
      >
        {content}
      </span>
    </span>
  );
}
