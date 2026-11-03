import { type ReactNode, useEffect, useRef } from "react";
import { Icon, IconButton, ModeBadge, Wordmark } from "../../components/ui";
import { botHref } from "./router";
import type { ShellBadge } from "./Sidebar";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * The phone top bar (below 760px, `NARROW_QUERY`): the menu button that opens
 * the navigation drawer, the brand, and the mode badge, so what the app is
 * connected to stays in view with the sidebar folded away.
 */
export function TopBar({
  menuId,
  drawerId,
  menuOpen,
  onMenu,
  badge,
}: {
  menuId: string;
  drawerId: string;
  menuOpen: boolean;
  onMenu: () => void;
  badge: ShellBadge;
}) {
  return (
    <header className="shell-topbar">
      <IconButton
        id={menuId}
        label="Menu"
        tone="ink"
        tooltip={false}
        icon={<Icon name="menu" size={18} />}
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        aria-controls={drawerId}
        onClick={onMenu}
      />
      <a className="shell-brand" href={botHref(null)}>
        <Wordmark />
      </a>
      <ModeBadge
        kind={badge.kind}
        title={badge.title}
        className="shell-topbar__badge"
      />
    </header>
  );
}

/**
 * The sidebar as a modal drawer from the start edge: the page behind is
 * inert, focus moves to its first control, and Escape, the backdrop, the
 * close button, a link or a bot or task row in it closes it; the Bots/Tasks
 * switch keeps it open on the other list. Focus then returns to the menu
 * button. It stays mounted while closed, so the lists keep their scroll
 * position.
 */
export function NavDrawer({
  id,
  open,
  onClose,
  returnFocusTo,
  children,
}: {
  id: string;
  open: boolean;
  onClose: () => void;
  /** The id of the menu button, focused again once the drawer closes. */
  returnFocusTo: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const openRef = useRef(open);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    openRef.current = open;
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !open) return;
    if (!dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    dialog.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    return () => {
      if (dialog.open) {
        if (typeof dialog.close === "function") dialog.close();
        else dialog.removeAttribute("open");
      }
      document.getElementById(returnFocusTo)?.focus();
    };
  }, [open, returnFocusTo]);

  return (
    <dialog
      ref={ref}
      id={id}
      className="shell-drawer"
      aria-label="Menu"
      onCancel={(event) => {
        // Escape: stay controlled; the shell closes it by flipping `open`.
        event.preventDefault();
        onCloseRef.current();
      }}
      onClose={() => {
        // A close the browser made on its own (ours happen with `open` false).
        if (openRef.current && !ref.current?.open) onCloseRef.current();
      }}
      onClick={(event) => {
        const target = event.target as Element;
        // The drawer fills its box, so a click on the dialog itself is on
        // the backdrop; a link or a list row leaves for another screen.
        if (
          target === event.currentTarget ||
          target.closest("a[href], [data-list-item]")
        )
          onCloseRef.current();
      }}
    >
      {children}
    </dialog>
  );
}
