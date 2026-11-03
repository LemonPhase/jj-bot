/**
 * Size report and budget for the web build: `npm run size -w @jj/web`, after
 * `vite build`. The initial load is what `dist/index.html` makes the browser
 * fetch before the app runs: its module script, every chunk that script
 * imports statically (Vite also lists them as modulepreloads) and its
 * stylesheets. Every other chunk loads on demand: the Tasks, Studio and
 * Settings screens, the Three.js office and the demo data. Sizes are in kB
 * (1000 bytes), raw and compressed with Node's zlib gzip and brotli defaults
 * (Vite's build log computes its gzip column slightly differently).
 *
 * The command fails on either of two checks. The budget caps the initial
 * JavaScript, with headroom above its size when the budget was set: keep code
 * the first screen does not need out of the entry (`React.lazy`, `import()`),
 * or raise the budget on purpose and say why in the pull request. And the
 * modules in `LAZY_MODULES` stay out of the initial load, and out of what
 * loads with the modules they come after, whatever their size: a static
 * import that pulls one in fails even within the budget. The built code no
 * longer names its modules, so the build lists each chunk's modules and
 * static imports: `chunkModules`, a Vite plugin, writes them to
 * `dist/.vite/modules.json`.
 */
import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, posix, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { brotliCompressSync, gzipSync } from "node:zlib";
import type { Plugin } from "vite";

/** Bytes the initial JavaScript may weigh, raw and gzipped. */
export const INITIAL_JS_BUDGET = { raw: 525_000, gzip: 162_000 } as const;

/** A module that must load on demand. */
export interface LazyModule {
  /** What it is, for the messages. */
  what: string;
  /**
   * Modules it loads after, imported on demand from theirs: it must not be in
   * what loads with any of them (their chunks and everything those import
   * statically).
   */
  after?: readonly string[];
}

const TASKS_SCREEN = "src/features/tasks/TasksScreen.tsx";

/**
 * Code that only some visits use, which must load on demand and never be in
 * the initial load: module ids as `moduleName` spells them (a path under
 * `apps/web`, or an npm package's name). The Bots screen, the one the app
 * opens on, is in the entry. The 3D office and Three.js load only once its
 * view opens, so not with the Tasks screen either.
 */
export const LAZY_MODULES: Readonly<Record<string, LazyModule>> = {
  "src/api/demoApi.ts": { what: "the demo data, used only without a backend" },
  [TASKS_SCREEN]: { what: "the Tasks screen" },
  "src/features/studio/StudioScreen.tsx": { what: "Bot Studio" },
  "src/features/settings/SettingsScreen.tsx": { what: "the Settings screen" },
  "src/features/templates/TemplateDialog.tsx": {
    what: "the task template dialogs",
  },
  "src/features/schedules/ScheduleDialog.tsx": {
    what: "the schedule dialogs",
  },
  "src/features/office/Office3D.tsx": {
    what: "the 3D office",
    after: [TASKS_SCREEN],
  },
  three: { what: "Three.js, for the 3D office", after: [TASKS_SCREEN] },
};

/** Where the build lists each chunk's modules, inside the build directory. */
export const MODULES_FILE = ".vite/modules.json";

/** A built JavaScript chunk, as `MODULES_FILE` lists it. */
export interface BuiltChunk {
  /** The modules whose code it carries, as `moduleName` spells them. */
  modules: string[];
  /** The chunks it imports statically, which load with it. */
  imports: string[];
}

/** Each JavaScript chunk's file, such as `assets/index-abc123.js`, and what it holds. */
export type ChunkModules = Record<string, BuiltChunk>;

/**
 * A module id as `MODULES_FILE` lists it: a dependency's npm package name
 * (`three`, `@scope/name`), or a file's path relative to `root`, the Vite
 * root (`src/main.tsx`), without the virtual-module prefix. A file keeps its
 * query, so `src/x.ts?raw` (its source as a string) is not `src/x.ts`.
 */
export function moduleName(id: string, root: string): string {
  const bare = id.replace(/^\0/, "");
  const at = bare.indexOf("?");
  const path = at < 0 ? bare : bare.slice(0, at);
  const query = at < 0 ? "" : bare.slice(at);
  const posixPath = path.replaceAll("\\", "/");
  const pkg = posixPath.match(/.*\/node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1];
  if (pkg) return pkg;
  const name = isAbsolute(path)
    ? relative(root, path).replaceAll("\\", "/")
    : posixPath;
  return name + query;
}

/**
 * The Vite plugin that writes `MODULES_FILE` into the build: for every
 * JavaScript chunk, the modules that put code in it (those tree-shaken away
 * left out), as `moduleName` spells them, and the chunks it imports
 * statically.
 */
export function chunkModules(): Plugin {
  let root = "";
  return {
    name: "jj-chunk-modules",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    generateBundle(_options, bundle) {
      const chunks: ChunkModules = {};
      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk") continue;
        const ids = Object.entries(output.modules)
          .filter(([, module]) => module.renderedLength > 0)
          .map(([id]) => moduleName(id, root));
        chunks[output.fileName] = {
          modules: [...new Set(ids)].sort(),
          imports: [...output.imports].sort(),
        };
      }
      this.emitFile({
        type: "asset",
        fileName: MODULES_FILE,
        source: `${JSON.stringify(chunks, null, 2)}\n`,
      });
    },
  };
}

export type Budget = { raw: number; gzip: number };

export interface AssetSize {
  /** Path inside the build directory, such as `assets/index-abc123.js`. */
  file: string;
  /** Part of the initial load, or fetched on demand. */
  initial: boolean;
  raw: number;
  gzip: number;
  brotli: number;
}

const attribute = (tag: string, name: string) =>
  tag.match(new RegExp(`\\s${name}\\s*=\\s*["']([^"']*)["']`, "i"))?.[1];

/** A same-origin URL from the built `index.html`, as a build-relative path. */
const fromHtml = (url: string) =>
  /^([a-z]+:)?\/\//i.test(url)
    ? null
    : posix.normalize(url.replace(/^\//, "")).replace(/^\.\//, "");

/** The files `index.html` loads: module scripts, modulepreloads, stylesheets. */
export function htmlAssets(html: string): string[] {
  const files: string[] = [];
  for (const [tag] of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = attribute(tag, "src");
    if (src && attribute(tag, "type") === "module") files.push(src);
  }
  for (const [tag] of html.matchAll(/<link\b[^>]*>/gi)) {
    const rel = attribute(tag, "rel")?.toLowerCase();
    const href = attribute(tag, "href");
    if (href && (rel === "modulepreload" || rel === "stylesheet"))
      files.push(href);
  }
  return files.flatMap((url) => fromHtml(url) ?? []);
}

/**
 * The chunks a built module imports statically (`import … from "./x.js"`,
 * `import "./x.js"`), as build-relative paths. Dynamic `import("./x.js")`
 * calls are on-demand loads and are left out.
 */
export function staticImports(code: string, file: string): string[] {
  const dir = posix.dirname(file);
  return [
    ...code.matchAll(/(?:\bfrom|\bimport)\s*["'](\.{1,2}\/[^"']+)["']/g),
  ].map(([, spec]) => posix.join(dir, spec as string));
}

const compressible = (file: string) => /\.(js|css)$/.test(file);

/** Every JS and CSS file under `dist/assets`, initial load first, largest first. */
export function measureBundle(dist: string): AssetSize[] {
  const read = (file: string) => readFileSync(join(dist, file));
  const initial = new Set<string>();
  const visit = (file: string) => {
    if (initial.has(file)) return;
    initial.add(file);
    if (file.endsWith(".js"))
      for (const dep of staticImports(read(file).toString("utf8"), file))
        visit(dep);
  };
  for (const file of htmlAssets(read("index.html").toString("utf8")))
    visit(file);
  return readdirSync(join(dist, "assets"))
    .map((name) => `assets/${name}`)
    .filter(compressible)
    .map((file) => {
      const bytes = read(file);
      return {
        file,
        initial: initial.has(file),
        raw: bytes.length,
        gzip: gzipSync(bytes).length,
        brotli: brotliCompressSync(bytes).length,
      };
    })
    .sort((a, b) => Number(b.initial) - Number(a.initial) || b.raw - a.raw);
}

/** The build's `MODULES_FILE`; null when it has none. */
export function readChunkModules(dist: string): ChunkModules | null {
  try {
    return JSON.parse(
      readFileSync(join(dist, MODULES_FILE), "utf8"),
    ) as ChunkModules;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** The chunks that carry module `id`. */
const chunksWith = (chunks: ChunkModules, id: string) =>
  Object.keys(chunks).filter((file) => chunks[file]?.modules.includes(id));

/** What loads with module `id`: the chunks carrying it and their static imports. */
function loadedWith(chunks: ChunkModules, id: string): Set<string> {
  const files = new Set<string>();
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    for (const dep of chunks[file]?.imports ?? []) visit(dep);
  };
  for (const file of chunksWith(chunks, id)) visit(file);
  return files;
}

const notInBuild = (id: string, what: string) =>
  `${id} (${what}) is in no chunk of the build: if it moved or was renamed, update LAZY_MODULES in apps/web/bundleSize.ts.`;

/**
 * Why code that must load on demand does not; empty when every module in
 * `lazy` is in the build, none is in the initial load, and none loads with a
 * module it comes `after`.
 */
export function notLazy(
  sizes: AssetSize[],
  chunks: ChunkModules | null,
  lazy: Readonly<Record<string, LazyModule>> = LAZY_MODULES,
): string[] {
  if (!chunks)
    return [
      `Found no ${MODULES_FILE} in the build, so cannot tell what loads on demand: build with apps/web/vite.config.ts (npm run build -w @jj/web).`,
    ];
  const initial = sizes.filter((size) => size.initial && isJs(size));
  // A list from another build than the one measured vouches for nothing.
  const unlisted = initial.filter((size) => !Object.hasOwn(chunks, size.file));
  if (unlisted.length > 0)
    return [
      `${MODULES_FILE} does not list ${unlisted.map((size) => size.file).join(", ")}: it is from another build. Rebuild the web app.`,
    ];
  const initialFiles = new Set(initial.map((size) => size.file));
  return Object.entries(lazy).flatMap(([id, { what, after = [] }]) => {
    const files = chunksWith(chunks, id);
    if (files.length === 0) return [notInBuild(id, what)];
    const eager = files.filter((file) => initialFiles.has(file));
    if (eager.length > 0)
      return [
        `${id} (${what}) is in the initial load (${eager.join(", ")}) but must load on demand: a static import from the entry's module graph pulls it in. Import it with import() or React.lazy instead.`,
      ];
    return after.flatMap((before) => {
      const withBefore = loadedWith(chunks, before);
      if (withBefore.size === 0)
        return [notInBuild(before, `which ${id} loads after`)];
      const together = files.filter((file) => withBefore.has(file));
      return together.length === 0
        ? []
        : [
            `${id} (${what}) loads with ${before} (${together.join(", ")}) but must load only after it, on demand: a static import from that module's graph pulls it in. Import it with import() or React.lazy instead.`,
          ];
    });
  });
}

/** What `notLazy` enforces for `lazy`, one line per rule, for the report. */
export function lazyRules(
  lazy: Readonly<Record<string, LazyModule>> = LAZY_MODULES,
): string[] {
  const after = new Map<string, string[]>();
  for (const [id, module] of Object.entries(lazy))
    for (const before of module.after ?? [])
      after.set(before, [...(after.get(before) ?? []), id]);
  return [
    `Not in the initial load: ${Object.keys(lazy).join(", ")}.`,
    ...[...after].map(
      ([before, ids]) =>
        `Not loaded with ${before}, only after it: ${ids.join(", ")}.`,
    ),
  ];
}

type Totals = Pick<AssetSize, "raw" | "gzip" | "brotli">;

const total = (sizes: AssetSize[]): Totals =>
  sizes.reduce(
    (sum, size) => ({
      raw: sum.raw + size.raw,
      gzip: sum.gzip + size.gzip,
      brotli: sum.brotli + size.brotli,
    }),
    { raw: 0, gzip: 0, brotli: 0 },
  );

const isJs = (size: AssetSize) => size.file.endsWith(".js");

/** The initial JavaScript's totals. */
export const initialJs = (sizes: AssetSize[]): Totals =>
  total(sizes.filter((size) => size.initial && isJs(size)));

const kB = (bytes: number) => `${(bytes / 1000).toFixed(1)} kB`;

/** Why the initial JavaScript is over budget; empty when it is within. */
export function overBudget(
  sizes: AssetSize[],
  budget: Budget = INITIAL_JS_BUDGET,
): string[] {
  const js = initialJs(sizes);
  // An index.html this script cannot read must fail, not pass as 0 kB.
  if (js.raw === 0)
    return ["Found no initial JavaScript under assets/ from index.html."];
  return (["raw", "gzip"] as const)
    .filter((measure) => js[measure] > budget[measure])
    .map(
      (measure) =>
        `Initial JS is ${kB(js[measure])} ${measure}, over its ${kB(budget[measure])} budget.`,
    );
}

/** The table `npm run size` prints. */
export function formatReport(
  sizes: AssetSize[],
  budget: Budget = INITIAL_JS_BUDGET,
): string {
  const width = Math.max(...sizes.map((size) => size.file.length), 4);
  const row = (load: string, file: string, size: Totals) =>
    [
      load.padEnd(8),
      file.padEnd(width),
      ...[size.raw, size.gzip, size.brotli].map((n) =>
        (n / 1000).toFixed(1).padStart(9),
      ),
    ].join(" ");
  const header = [
    "load".padEnd(8),
    "file".padEnd(width),
    ..."raw gzip brotli".split(" ").map((name) => name.padStart(9)),
  ].join(" ");
  const js = initialJs(sizes);
  return [
    "Web build sizes (kB = 1000 bytes)",
    header,
    ...sizes.map((size) =>
      row(size.initial ? "initial" : "lazy", size.file, size),
    ),
    "",
    row("initial", "JS", js),
    row("initial", "CSS", total(sizes.filter((s) => s.initial && !isJs(s)))),
    row("all", "JS", total(sizes.filter(isJs))),
    "",
    `Initial JS budget: ${kB(budget.raw)} raw, ${kB(budget.gzip)} gzip (${kB(js.raw)} and ${kB(js.gzip)} used).`,
  ].join("\n");
}

const WEB_DIST = fileURLToPath(new URL("./dist", import.meta.url));

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const dist = process.argv[2] ?? WEB_DIST;
  const sizes = measureBundle(dist);
  console.log(formatReport(sizes));
  const eager = notLazy(sizes, readChunkModules(dist));
  if (eager.length === 0)
    console.log(
      ["Lazy-load checks (LAZY_MODULES) passed:", ...lazyRules()].join("\n  "),
    );
  const overSize = overBudget(sizes);
  if (eager.length > 0 || overSize.length > 0) {
    console.error(
      [
        "",
        ...eager,
        ...overSize,
        ...(overSize.length > 0
          ? [
              "Load what the first screen does not need on demand, or raise INITIAL_JS_BUDGET in apps/web/bundleSize.ts and say why in the pull request.",
            ]
          : []),
      ].join("\n"),
    );
    process.exit(1);
  }
}
