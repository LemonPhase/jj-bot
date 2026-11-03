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
 * The budget caps the initial JavaScript, with headroom above its size when
 * the budget was set. Over budget, the command fails: keep code the first
 * screen does not need out of the entry (`React.lazy`, `import()`), or raise
 * the budget on purpose and say why in the pull request.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { brotliCompressSync, gzipSync } from "node:zlib";

/** Bytes the initial JavaScript may weigh, raw and gzipped. */
export const INITIAL_JS_BUDGET = { raw: 525_000, gzip: 162_000 } as const;

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
  const problems = overBudget(sizes);
  if (problems.length > 0) {
    console.error(
      [
        "",
        ...problems,
        "Load what the first screen does not need on demand, or raise INITIAL_JS_BUDGET in apps/web/bundleSize.ts and say why in the pull request.",
      ].join("\n"),
    );
    process.exit(1);
  }
}
