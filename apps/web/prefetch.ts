/**
 * Prefetch for what the first screen offers but does not show. `prefetchChunks`
 * adds a `<link rel="prefetch">` to the built `index.html` for every file a
 * listed module loads on demand: the chunk that carries it, the chunks that
 * chunk imports statically and their stylesheets, less what the page loads
 * anyway. The browser fetches them at idle priority into its HTTP cache (the
 * service worker, which stores what `index.html` names, keeps them too) and
 * never runs them, so the first `import()` (the click) finds them there. A
 * prefetch that fails commits nothing: the click fetches the files itself.
 * A background `import()` would not do: Chromium keeps a failed dynamic import
 * for the page's life, and Vite never asks again for a stylesheet it has
 * tried, so one failure in the background would cost the click.
 */
import type { HtmlTagDescriptor, Plugin, Rolldown } from "vite";
import { moduleName } from "./bundleSize.ts";

type OutputChunk = Rolldown.OutputChunk;

/** Modules to prefetch, as `moduleName` spells them: the first screen's on-demand parts. */
export const PREFETCH_MODULES = [
  "src/features/tasks/NewTaskDialog.tsx",
  "src/features/bots/BotInspector.tsx",
] as const;

/** A JavaScript chunk of the bundle, with what it imports and its stylesheets. */
type Chunk = Pick<OutputChunk, "fileName" | "imports" | "moduleIds"> & {
  viteMetadata?: { importedCss: Set<string> };
};

/**
 * The build files to prefetch for `modules` in `bundle`, whose page loads
 * `entry`: each module's chunk, its static imports and their stylesheets,
 * without the files the entry loads itself. Throws for a module in no chunk,
 * or loaded with the entry: there is nothing to prefetch then, and the list
 * is wrong.
 */
export function prefetchFiles(
  bundle: Record<string, Chunk>,
  entry: string,
  modules: readonly string[],
  root: string,
): string[] {
  const css = (file: string) => [
    ...(bundle[file]?.viteMetadata?.importedCss ?? []),
  ];
  const withImports = (file: string, into = new Set<string>()) => {
    if (into.has(file)) return into;
    into.add(file);
    for (const dep of bundle[file]?.imports ?? []) withImports(dep, into);
    return into;
  };
  const initial = withImports(entry);
  const initialCss = new Set([...initial].flatMap(css));
  const files = new Set<string>();
  for (const id of modules) {
    const chunk = Object.values(bundle).find((candidate) =>
      candidate.moduleIds.some((moduleId) => moduleName(moduleId, root) === id),
    );
    if (!chunk) throw new Error(`prefetchChunks: ${id} is in no chunk.`);
    if (initial.has(chunk.fileName))
      throw new Error(
        `prefetchChunks: ${id} loads with the page (${chunk.fileName}), so there is nothing to prefetch.`,
      );
    for (const file of withImports(chunk.fileName))
      if (!initial.has(file)) {
        files.add(file);
        for (const sheet of css(file))
          if (!initialCss.has(sheet)) files.add(sheet);
      }
  }
  return [...files].sort();
}

/** The Vite plugin that adds the prefetch links to the built `index.html`. */
export function prefetchChunks(
  modules: readonly string[] = PREFETCH_MODULES,
): Plugin {
  let root = "";
  let base = "/";
  return {
    name: "jj-prefetch-chunks",
    apply: "build",
    configResolved(config) {
      root = config.root;
      base = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(_html, { bundle, chunk }) {
        if (!bundle || !chunk) return;
        const chunks: Record<string, Chunk> = {};
        for (const output of Object.values(bundle))
          if (output.type === "chunk") chunks[output.fileName] = output;
        return prefetchFiles(chunks, chunk.fileName, modules, root).map(
          (file): HtmlTagDescriptor => ({
            tag: "link",
            // crossorigin: fetched as the module import and Vite's
            // stylesheet link will ask for them, so the cache entry fits.
            attrs: { rel: "prefetch", href: `${base}${file}`, crossorigin: "" },
            injectTo: "head",
          }),
        );
      },
    },
  };
}
