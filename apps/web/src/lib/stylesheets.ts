/**
 * Stylesheets that failed to load, so no lazy part renders without one. Vite
 * fetches a lazy chunk's stylesheets with a `<link rel="stylesheet">` before
 * it imports the chunk, but asks for each stylesheet once per page: after a
 * failure it skips it, and a later chunk that shares it (the New task dialog
 * and the Tasks screen share tasks.css) would render unstyled. The chunk whose
 * stylesheet failed shows its error instead (`lazyComponent`); before a later
 * chunk loads, `restoreStylesheets` asks again for the failed ones that chunk
 * needs, and only those: one that fails offline must not stop a part that
 * does not use it.
 */

/** The `<meta name>` the build lists each lazy chunk's stylesheets in (apps/web/chunkStylesheets.ts). */
const LIST = "jj-chunk-stylesheets";

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

/**
 * The stylesheets chunk `name` loads with, as URLs; null when the page has
 * no list (the dev server, unit tests) or the list does not name it, and so
 * every failed stylesheet counts.
 */
export function stylesheetsOf(
  name: string,
  doc: Document = document,
): Set<string> | null {
  const list = doc.querySelector<HTMLMetaElement>(`meta[name="${LIST}"]`);
  const entry = list?.content
    .split(";")
    .find((part) => part.startsWith(`${name}=`));
  if (entry === undefined) return null;
  return new Set(
    entry
      .slice(name.length + 1)
      .split(" ")
      .filter(Boolean)
      .map((path) => new URL(path, doc.baseURI).href),
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
 * Loads again, in place of its broken link, every failed stylesheet that
 * chunk `name` needs (every failed one when the page does not say which);
 * resolves at once when none did, and rejects when one fails again.
 */
export function restoreStylesheets(name?: string): Promise<void> {
  const needed = name === undefined ? null : stylesheetsOf(name);
  return Promise.all(
    [...failed]
      .filter(([href]) => !needed || needed.has(href))
      .map(([href, broken]) => {
        let pending = restoring.get(href);
        if (!pending) {
          pending = restore(href, broken);
          restoring.set(href, pending);
        }
        return pending;
      }),
  ).then(() => undefined);
}
