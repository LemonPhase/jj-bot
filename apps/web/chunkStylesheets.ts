/**
 * Each lazy chunk's stylesheets, for the page to read: `chunkStylesheets`
 * adds `<meta name="jj-chunk-stylesheets">` to the built `index.html`,
 * listing for every chunk the app imports on demand the stylesheets Vite
 * loads with it (its own and those of the chunks it imports statically,
 * less the page's own). The key is the file name of the module the chunk
 * loads, without its extension (`NewTaskDialog`), which is also the name a
 * `lazyComponent` is given. `src/lib/stylesheets.ts` reads it, so a load
 * asks again only for the failed stylesheets its own chunk needs.
 *
 * The format has no quotes, so the attribute needs no escaping:
 * `NewTaskDialog=/assets/a.css /assets/b.css;TasksScreen=;…`.
 */
import { basename, extname } from "node:path";
import type { HtmlTagDescriptor, Plugin, Rolldown } from "vite";

/** The `<meta name>` the page reads. */
export const STYLESHEETS_META = "jj-chunk-stylesheets";

type Chunk = Pick<
  Rolldown.OutputChunk,
  "fileName" | "imports" | "isDynamicEntry" | "facadeModuleId"
> & { viteMetadata?: { importedCss: Set<string> } };

/**
 * For each chunk of `bundle` imported on demand, by its module's name: the
 * stylesheets that load with it, outside what the page `entry` loads.
 */
export function chunkStylesheetList(
  bundle: Record<string, Chunk>,
  entry: string,
): Record<string, string[]> {
  const withImports = (file: string, into = new Set<string>()) => {
    if (into.has(file)) return into;
    into.add(file);
    for (const dep of bundle[file]?.imports ?? []) withImports(dep, into);
    return into;
  };
  const css = (files: Set<string>) =>
    new Set(
      [...files].flatMap((file) => [
        ...(bundle[file]?.viteMetadata?.importedCss ?? []),
      ]),
    );
  const initial = css(withImports(entry));
  const list: Record<string, Set<string>> = {};
  for (const chunk of Object.values(bundle)) {
    if (!chunk.isDynamicEntry || !chunk.facadeModuleId) continue;
    const id = chunk.facadeModuleId.replace(/[?#].*$/, "");
    const name = basename(id, extname(id));
    list[name] ??= new Set();
    for (const sheet of css(withImports(chunk.fileName)))
      if (!initial.has(sheet)) list[name].add(sheet);
  }
  return Object.fromEntries(
    Object.entries(list)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, sheets]) => [name, [...sheets].sort()]),
  );
}

/** The meta content for `list`, with each stylesheet's URL under `base`. */
export function formatStylesheetList(
  list: Record<string, string[]>,
  base = "/",
): string {
  return Object.entries(list)
    .map(([name, sheets]) => `${name}=${sheets.map((s) => base + s).join(" ")}`)
    .join(";");
}

/** The Vite plugin that adds the list to the built `index.html`. */
export function chunkStylesheets(): Plugin {
  let base = "/";
  return {
    name: "jj-chunk-stylesheets",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(_html, { bundle, chunk }) {
        if (!bundle || !chunk) return;
        const chunks: Record<string, Chunk> = {};
        for (const output of Object.values(bundle))
          if (output.type === "chunk") chunks[output.fileName] = output;
        const tag: HtmlTagDescriptor = {
          tag: "meta",
          attrs: {
            name: STYLESHEETS_META,
            content: formatStylesheetList(
              chunkStylesheetList(chunks, chunk.fileName),
              base,
            ),
          },
          injectTo: "head",
        };
        return [tag];
      },
    },
  };
}
