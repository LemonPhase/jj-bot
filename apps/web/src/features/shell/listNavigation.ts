import { type KeyboardEvent, useCallback } from "react";

/**
 * Keyboard navigation for the sidebar lists (a roving tab stop): Tab reaches
 * the list once, on the selected item; ArrowUp/ArrowDown move focus, Home/End
 * jump to the ends, and Enter or Space opens the focused item (it is a button).
 */

/** The index to focus after a key press, or null when the key is not handled. */
export function nextFocusIndex(
  key: string,
  index: number,
  count: number,
): number | null {
  if (count === 0) return null;
  switch (key) {
    case "ArrowDown":
      return Math.min(index + 1, count - 1);
    case "ArrowUp":
      return Math.max(index - 1, 0);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * Which item holds the tab stop: the selected one, else the first. Give it
 * `tabIndex={0}` and every other item `tabIndex={-1}`.
 */
export function tabStopIndex(selectedIndex: number, count: number): number {
  return selectedIndex >= 0 && selectedIndex < count ? selectedIndex : 0;
}

/** Marks the focusable item of each list row. */
export const LIST_ITEM_ATTRIBUTE = "data-list-item";

/** `onKeyDown` for the list container. Items carry `data-list-item`. */
export function useListKeyboard() {
  return useCallback((event: KeyboardEvent<HTMLElement>) => {
    const items = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        `[${LIST_ITEM_ATTRIBUTE}]`,
      ),
    );
    const index = items.findIndex((item) => item === document.activeElement);
    if (index < 0) return;
    const next = nextFocusIndex(event.key, index, items.length);
    if (next === null) return;
    event.preventDefault();
    items[next]?.focus();
  }, []);
}
