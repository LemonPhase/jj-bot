/**
 * Stylesheets that failed to load, so no lazy part renders without one. Vite
 * fetches a lazy chunk's stylesheets with a `<link rel="stylesheet">` before
 * it imports the chunk, but asks for each stylesheet once per page: after a
 * failure it skips it, and a later chunk that shares it (the New task dialog
 * and the Tasks screen share tasks.css) would render unstyled. The chunk whose
 * stylesheet failed shows its error instead (`lazyComponent`); before any
 * later chunk loads, `restoreStylesheets` asks for the failed ones again.
 */

/** Failed stylesheets by URL: the link that failed, or its retry. */
const failed = new Map<string, HTMLLinkElement>();
const restoring = new Map<string, Promise<void>>();

/**
 * Notes every stylesheet link that fails to load. Called once at boot,
 * before any lazy chunk loads.
 */
export function watchStylesheets(doc: Document = document): void {
  doc.addEventListener(
    "error",
    (event) => {
      const link = event.target;
      if (link instanceof HTMLLinkElement && link.rel === "stylesheet")
        failed.set(link.href, link);
    },
    // Load errors do not bubble.
    true,
  );
}

function restore(href: string, broken: HTMLLinkElement): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const link = broken.ownerDocument.createElement("link");
    link.rel = "stylesheet";
    link.crossOrigin = "";
    link.href = href;
    link.addEventListener("load", () => {
      failed.delete(href);
      resolve();
    });
    link.addEventListener("error", () =>
      reject(new Error(`Unable to load the stylesheet ${href}`)),
    );
    if (broken.isConnected) broken.replaceWith(link);
    else broken.ownerDocument.head.append(link);
  }).finally(() => restoring.delete(href));
}

/**
 * Loads again every stylesheet that failed, in place of its broken link;
 * resolves at once when none did, and rejects when one fails again.
 */
export function restoreStylesheets(): Promise<void> {
  return Promise.all(
    [...failed].map(([href, broken]) => {
      let pending = restoring.get(href);
      if (!pending) {
        pending = restore(href, broken);
        restoring.set(href, pending);
      }
      return pending;
    }),
  ).then(() => undefined);
}
