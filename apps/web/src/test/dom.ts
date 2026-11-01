/**
 * Shared setup for component tests. Import it first in a test file that starts
 * with the `// @vitest-environment jsdom` docblock:
 *
 *   // @vitest-environment jsdom
 *   import "../../test/dom";
 *
 * It unmounts after each test and fills in browser behaviour jsdom lacks.
 */
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
  cleanup();
});

/**
 * jsdom has no HTMLDialogElement.showModal or close. These follow the browser:
 * `close()` removes `open` at once but fires the `close` event later, in a
 * queued task. That delay is what exposes stale close events (the StrictMode
 * double effect), so keep it.
 */
const dialog = globalThis.HTMLDialogElement?.prototype as
  | (HTMLDialogElement & { __polyfilled?: boolean })
  | undefined;
if (dialog && typeof dialog.showModal !== "function") {
  dialog.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  dialog.show = function show(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  dialog.close = function close(this: HTMLDialogElement) {
    if (!this.hasAttribute("open")) return;
    this.removeAttribute("open");
    setTimeout(() => this.dispatchEvent(new Event("close")), 0);
  };
}

/** Lets queued tasks (such as the dialog `close` event) run. */
export const flushTasks = () =>
  new Promise<void>((resolve) => setTimeout(resolve, 20));

export interface FakeMediaQuery {
  /** Changes the OS preference and notifies listeners, like the browser. */
  set(matches: boolean): void;
}

/**
 * Replaces `window.matchMedia` with one whose `prefers-color-scheme: dark`
 * answer the test controls. Call it before importing code that reads it.
 */
export function fakeColorScheme(initialDark: boolean): FakeMediaQuery {
  let matches = initialDark;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();
  const query = {
    get matches() {
      return matches;
    },
    media: "(prefers-color-scheme: dark)",
    onchange: null,
    addEventListener: (
      _type: string,
      listener: (event: MediaQueryListEvent) => void,
    ) => listeners.add(listener),
    removeEventListener: (
      _type: string,
      listener: (event: MediaQueryListEvent) => void,
    ) => listeners.delete(listener),
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  };
  window.matchMedia = ((media: string) =>
    media === query.media
      ? query
      : {
          ...query,
          media,
          matches: false,
        }) as unknown as typeof window.matchMedia;
  return {
    set(next: boolean) {
      matches = next;
      for (const listener of listeners)
        listener({ matches: next, media: query.media } as MediaQueryListEvent);
    },
  };
}
