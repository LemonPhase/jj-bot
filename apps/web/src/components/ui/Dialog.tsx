import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useRef,
} from "react";
import { Icon } from "./Icon";
import { IconButton } from "./IconButton";
import "./ui.css";

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled]):not([type='hidden'])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function focusableIn(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) =>
      !element.hasAttribute("hidden") && element.offsetParent !== null,
  );
}

export interface DialogProps {
  open: boolean;
  /** Called on Escape, the close button and (when `dismissible`) a backdrop click. */
  onClose: () => void;
  /** Visible heading; also the dialog's accessible name. */
  title: string;
  /** Optional line under the title; also the accessible description. */
  description?: ReactNode;
  children?: ReactNode;
  /** Actions, right-aligned; usually a secondary "Cancel" and a primary pill. */
  footer?: ReactNode;
  /** Close on a backdrop click. Default true; turn off for forms with unsaved input. */
  dismissible?: boolean;
  /** Element to focus on open. Default: the first control in the body, else the close button. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  /** Panel width in CSS px. Default 480. */
  width?: number;
}

/**
 * Modal dialog on the native <dialog> element: the page behind is inert, Tab
 * and Shift+Tab stay inside, Escape closes it, and focus returns to the element
 * that opened it. Controlled: render it with `open` and handle `onClose`.
 *
 * @example
 * <Dialog open={open} onClose={() => setOpen(false)} title="Delete profile?"
 *   footer={<><Button onClick={cancel}>Cancel</Button><Button variant="danger" onClick={remove}>Delete</Button></>}>
 *   Sessions using it fall back to the default profile.
 * </Dialog>
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  dismissible = true,
  initialFocusRef,
  width,
}: DialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const pressStartedOnBackdrop = useRef(false);
  const onCloseRef = useRef(onClose);
  const openRef = useRef(open);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    onCloseRef.current = onClose;
    openRef.current = open;
  });

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog || !open) return;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    // Prefer the first control in the body over the header's close button.
    const items = panelRef.current ? focusableIn(panelRef.current) : [];
    const target =
      initialFocusRef?.current ??
      items.find((element) => !element.hasAttribute("data-dialog-close")) ??
      items[0] ??
      panelRef.current;
    target?.focus();
    return () => {
      if (dialog.open) dialog.close();
      previous?.focus();
    };
  }, [open, initialFocusRef]);

  const trapTab = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== "Tab" || !panelRef.current) return;
    const items = focusableIn(panelRef.current);
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panelRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <dialog
      ref={dialogRef}
      className="ui-dialog"
      style={
        width ? { width: `min(${width}px, calc(100vw - 32px))` } : undefined
      }
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      onCancel={(event) => {
        // Escape: stay controlled; the parent decides by flipping `open`.
        event.preventDefault();
        onCloseRef.current();
      }}
      onClose={(event) => {
        // `close` fires asynchronously. A dialog that is open again by then was
        // reopened after our own effect cleanup closed it (StrictMode mounts a
        // dialog that starts open twice), so that event is stale.
        if (event.currentTarget.open) return;
        // The browser closed it anyway (some Escape paths cannot be cancelled).
        if (openRef.current) onCloseRef.current();
      }}
      onKeyDown={trapTab}
      onMouseDown={(event) => {
        pressStartedOnBackdrop.current = event.target === event.currentTarget;
      }}
      onClick={(event) => {
        if (
          dismissible &&
          pressStartedOnBackdrop.current &&
          event.target === event.currentTarget
        )
          onCloseRef.current();
        pressStartedOnBackdrop.current = false;
      }}
    >
      {open && (
        <div ref={panelRef} className="ui-dialog__panel" tabIndex={-1}>
          <div className="ui-dialog__head">
            <div className="ui-dialog__titles">
              <h2 id={titleId} className="ui-dialog__title">
                {title}
              </h2>
              {description && (
                <p id={descriptionId} className="ui-dialog__description">
                  {description}
                </p>
              )}
            </div>
            <IconButton
              data-dialog-close=""
              label="Close"
              icon={<Icon name="close" size={16} />}
              onClick={() => onCloseRef.current()}
            />
          </div>
          {children}
          {footer && <div className="ui-dialog__footer">{footer}</div>}
        </div>
      )}
    </dialog>
  );
}
