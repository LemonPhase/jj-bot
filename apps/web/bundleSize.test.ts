import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AssetSize,
  type ChunkModules,
  chunkModules,
  formatReport,
  htmlAssets,
  initialJs,
  LAZY_MODULES,
  type LazyModule,
  lazyRules,
  MODULES_FILE,
  measureBundle,
  moduleName,
  notLazy,
  overBudget,
  readChunkModules,
  staticImports,
} from "./bundleSize";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true })));
});

/** A build directory shaped like `vite build` output. */
async function fakeDist(files: Record<string, string>): Promise<string> {
  const dist = await mkdtemp(join(tmpdir(), "jj-bundle-size-"));
  dirs.push(dist);
  await mkdir(join(dist, "assets"));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(dist, file)), { recursive: true });
    await writeFile(join(dist, file), content);
  }
  return dist;
}

const INDEX_HTML = `<!doctype html>
<html><head>
<script>(function () { document.documentElement.dataset.theme = "x"; })();</script>
<script type="module" crossorigin src="/assets/index-a1.js"></script>
<link rel="modulepreload" crossorigin href="/assets/vendor-b2.js">
<link rel="stylesheet" crossorigin href="/assets/index-c3.css">
<link rel="icon" type="image/svg+xml" href="/favicon.svg" />
<script type="module" src="https://cdn.example.com/x.js"></script>
</head><body><div id="root"></div></body></html>`;

describe("web bundle size", () => {
  it("reads the module scripts, modulepreloads and stylesheets index.html loads", () => {
    expect(htmlAssets(INDEX_HTML)).toEqual([
      "assets/index-a1.js",
      "assets/vendor-b2.js",
      "assets/index-c3.css",
    ]);
  });

  it("follows static imports, not dynamic ones", () => {
    const code =
      'import{a as e}from"./vendor-b2.js";import"./side-d4.js";' +
      'const t=()=>import("./Lazy-e5.js"),n=__vitePreload(()=>import("./Office3D-f6.js"),__vite__mapDeps([0]));';
    expect(staticImports(code, "assets/index-a1.js")).toEqual([
      "assets/vendor-b2.js",
      "assets/side-d4.js",
    ]);
  });

  it("counts the entry and everything it imports statically as the initial load", async () => {
    const dist = await fakeDist({
      "index.html": INDEX_HTML,
      "assets/index-a1.js": `import{x}from"./vendor-b2.js";import"./side-d4.js";const lazy=()=>import("./Lazy-e5.js");${"a".repeat(3000)}`,
      "assets/vendor-b2.js": `export const x=1;${"b".repeat(2000)}`,
      // Imported by the entry but not preloaded: still part of the initial load.
      "assets/side-d4.js": `import{x}from"./vendor-b2.js";${"d".repeat(500)}`,
      "assets/Lazy-e5.js": `import{x}from"./vendor-b2.js";${"e".repeat(9000)}`,
      "assets/index-c3.css": `.app{color:red}${".x{}".repeat(100)}`,
      "assets/Lazy-g7.css": ".lazy{color:blue}",
      "assets/font-h8.woff2": "not measured",
    });

    const sizes = measureBundle(dist);
    expect(sizes.map(({ file, initial }) => [file, initial])).toEqual([
      ["assets/index-a1.js", true],
      ["assets/vendor-b2.js", true],
      ["assets/side-d4.js", true],
      ["assets/index-c3.css", true],
      ["assets/Lazy-e5.js", false],
      ["assets/Lazy-g7.css", false],
    ]);
    const entry = sizes[0] as AssetSize;
    expect(entry.raw).toBe(
      'import{x}from"./vendor-b2.js";import"./side-d4.js";const lazy=()=>import("./Lazy-e5.js");'
        .length + 3000,
    );
    expect(entry.gzip).toBeGreaterThan(0);
    expect(entry.gzip).toBeLessThan(entry.raw);
    expect(entry.brotli).toBeGreaterThan(0);
    expect(entry.brotli).toBeLessThan(entry.raw);

    // Only the initial JavaScript counts against the budget: not CSS, not lazy chunks.
    const js = initialJs(sizes);
    const initialFiles = sizes.slice(0, 3);
    expect(js.raw).toBe(initialFiles.reduce((sum, s) => sum + s.raw, 0));
    expect(js.gzip).toBe(initialFiles.reduce((sum, s) => sum + s.gzip, 0));
    expect(overBudget(sizes, { raw: js.raw, gzip: js.gzip })).toEqual([]);
    expect(overBudget(sizes, { raw: js.raw - 1, gzip: js.gzip })).toEqual([
      expect.stringMatching(/^Initial JS is [\d.]+ kB raw, over its/),
    ]);
    expect(overBudget(sizes, { raw: js.raw, gzip: js.gzip - 1 })).toEqual([
      expect.stringMatching(/^Initial JS is [\d.]+ kB gzip, over its/),
    ]);

    const report = formatReport(sizes, { raw: 600_000, gzip: 200_000 });
    expect(report).toMatch(/^initial +assets\/index-a1\.js +[\d.]+/m);
    expect(report).toMatch(/^lazy +assets\/Lazy-e5\.js +[\d.]+/m);
    expect(report).toContain("Initial JS budget: 600.0 kB raw, 200.0 kB gzip");
  });

  it("fails when it finds no initial JavaScript, rather than passing at 0 kB", async () => {
    const dist = await fakeDist({
      // A script tag it cannot read: not a module script.
      "index.html": '<script src="/assets/index-a1.js"></script>',
      "assets/index-a1.js": "console.log(1);",
    });
    const sizes = measureBundle(dist);
    expect(sizes.map(({ file, initial }) => [file, initial])).toEqual([
      ["assets/index-a1.js", false],
    ]);
    expect(overBudget(sizes)).toEqual([
      "Found no initial JavaScript under assets/ from index.html.",
    ]);
  });
});

/** What the fixture apps below must load on demand. */
const FIXTURE_LAZY: Record<string, LazyModule> = {
  "lazy.js": { what: "the lazy module" },
  "@lazy/pkg": { what: "its dependency" },
};

const pkg = (name: string, code: string) => ({
  [`node_modules/${name}/package.json`]: JSON.stringify({
    name,
    type: "module",
    main: "index.js",
  }),
  [`node_modules/${name}/index.js`]: code,
});

const lines = (...code: (string | false)[]) => code.filter(Boolean).join("\n");

const LAZY_JS = lines(
  'import { big } from "@lazy/pkg";',
  "export const lazyWord = `lazy ${big}`;",
);

/**
 * A tiny app built by Vite with `chunkModules`, into its `dist`: `index.html`
 * loads `main.js`, with `files` and two packages, `eagerpkg` and `@lazy/pkg`.
 */
async function buildApp(
  files: Record<string, string>,
  { sharedChunk }: { sharedChunk?: RegExp } = {},
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jj-bundle-app-"));
  dirs.push(root);
  const all: Record<string, string> = {
    "index.html":
      '<!doctype html><script type="module" src="/main.js"></script>',
    ...pkg("eagerpkg", 'export const word = "eager";'),
    ...pkg("@lazy/pkg", 'export const big = "x".repeat(10);'),
    ...files,
  };
  for (const [file, content] of Object.entries(all)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content);
  }
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [chunkModules()],
    // `sharedChunk` groups the modules it matches into one chunk, `shared`.
    build: sharedChunk && {
      rolldownOptions: {
        output: {
          codeSplitting: { groups: [{ name: "shared", test: sharedChunk }] },
        },
      },
    },
  });
  return join(root, "dist");
}

/**
 * `main.js` loads `lazy.js` with import(), and with `eager` also imports it
 * statically, the regression the lazy-module check is for.
 */
const lazyApp = ({ eager }: { eager: boolean }) => ({
  "main.js": lines(
    eager && 'import { lazyWord } from "./lazy.js";',
    'import { word } from "eagerpkg";',
    eager && "console.log(lazyWord);",
    "console.log(word);",
    'document.body.onclick = () => import("./lazy.js").then((m) => console.log(m.lazyWord));',
  ),
  "lazy.js": LAZY_JS,
});

/** The office loads on demand from either screen, which load on demand too. */
const OFFICE_LAZY: Record<string, LazyModule> = {
  "screen.js": { what: "the screen" },
  "office.js": { what: "the office", after: ["screen.js"] },
  "@lazy/pkg": { what: "its dependency", after: ["screen.js"] },
};

/**
 * `main.js` opens `screen.js` or `other.js` on demand, and each opens
 * `office.js` on demand; with `eager` both also import it statically, so it
 * lands in a chunk the two screens' chunks import.
 */
const officeApp = ({ eager }: { eager: boolean }) => {
  const screen = (name: string) =>
    lines(
      eager && 'import { officeWord } from "./office.js";',
      eager && `console.log("${name}", officeWord);`,
      'export const open = () => import("./office.js").then((m) => console.log(m.officeWord));',
    );
  return {
    "main.js": lines(
      'document.body.onclick = () => import("./screen.js").then((m) => m.open());',
      'document.body.onkeydown = () => import("./other.js").then((m) => m.open());',
    ),
    "screen.js": screen("screen"),
    "other.js": screen("other"),
    "office.js": lines(
      'import { big } from "@lazy/pkg";',
      "export const officeWord = `office ${big}`;",
    ),
  };
};

/** The built chunk that carries `id`. */
const chunkOf = (chunks: ChunkModules, id: string) =>
  Object.keys(chunks).find((file) => chunks[file]?.modules.includes(id));

describe("modules that must load on demand", () => {
  it("names a module by its path under the Vite root, or its npm package", () => {
    const root = "/repo/apps/web";
    expect(moduleName("/repo/apps/web/src/main.tsx", root)).toBe(
      "src/main.tsx",
    );
    expect(
      moduleName("/repo/node_modules/three/build/three.module.js", root),
    ).toBe("three");
    expect(
      moduleName("/repo/node_modules/@scope/pkg/dist/x.js?commonjs-es", root),
    ).toBe("@scope/pkg");
    expect(
      moduleName("/repo/node_modules/a/node_modules/b/index.js", root),
    ).toBe("b");
    expect(moduleName("/repo/packages/contracts/src/api.ts", root)).toBe(
      "../../packages/contracts/src/api.ts",
    );
    expect(moduleName("\0vite/preload-helper.js", root)).toBe(
      "vite/preload-helper.js",
    );
    // A file imported as its source text, a URL or a worker is not the file.
    expect(
      moduleName("/repo/apps/web/src/features/office/Office3D.tsx?raw", root),
    ).toBe("src/features/office/Office3D.tsx?raw");
  });

  it("lists every chunk's modules and static imports from a real build", async () => {
    const dist = await buildApp(lazyApp({ eager: false }));
    const sizes = measureBundle(dist);
    const chunks = readChunkModules(dist);
    const js = sizes.filter((size) => size.file.endsWith(".js"));
    const entry = js.find((size) => size.initial) as AssetSize;
    const lazy = js.find((size) => !size.initial) as AssetSize;
    expect(chunks?.[entry.file]?.modules).toEqual(
      expect.arrayContaining(["main.js", "eagerpkg"]),
    );
    expect(chunks?.[entry.file]?.modules).not.toContain("lazy.js");
    expect(chunks?.[entry.file]?.imports).toEqual([]);
    expect(chunks?.[lazy.file]?.modules).toEqual(
      expect.arrayContaining(["lazy.js", "@lazy/pkg"]),
    );
    expect(notLazy(sizes, chunks, FIXTURE_LAZY)).toEqual([]);
  });

  it("fails a module a static import pulls into the initial load, however small", async () => {
    const dist = await buildApp(lazyApp({ eager: true }));
    const sizes = measureBundle(dist);
    expect(overBudget(sizes)).toEqual([]);
    expect(notLazy(sizes, readChunkModules(dist), FIXTURE_LAZY)).toEqual([
      expect.stringMatching(
        /^lazy\.js \(the lazy module\) is in the initial load \(assets\/[\w-]+\.js\) but must load on demand/,
      ),
      expect.stringMatching(
        /^@lazy\/pkg \(its dependency\) is in the initial load \(assets\/[\w-]+\.js\)/,
      ),
    ]);
  });

  it("fails a lazy module in a shared chunk the entry imports statically", async () => {
    // The app's entry imports shared chunks (contracts, React): a lazy
    // module that lands in one loads with the entry. Here a code-splitting
    // group puts lazy.js in one with shared.js, which the entry imports.
    const app = {
      "main.js": lines(
        'import { shared } from "./shared.js";',
        "console.log(shared);",
        'document.body.onclick = () => import("./lazy.js").then((m) => console.log(m.lazyWord));',
      ),
      "shared.js": 'export const shared = "shared";',
      "lazy.js": LAZY_JS,
    };
    const dist = await buildApp(app, { sharedChunk: /\/(shared|lazy)\.js$/ });
    const sizes = measureBundle(dist);
    const chunks = readChunkModules(dist) as ChunkModules;
    const entry = chunkOf(chunks, "main.js") as string;
    const shared = chunkOf(chunks, "lazy.js") as string;
    expect(shared).toMatch(/^assets\/shared-[\w-]+\.js$/);
    expect(chunks[shared]?.modules).toContain("shared.js");
    expect(chunks[entry]?.imports).toContain(shared);
    expect(sizes.find((size) => size.file === shared)?.initial).toBe(true);
    expect(notLazy(sizes, chunks, FIXTURE_LAZY)).toEqual([
      `lazy.js (the lazy module) is in the initial load (${shared}) but must load on demand: a static import from the entry's module graph pulls it in. Import it with import() or React.lazy instead.`,
      expect.stringMatching(
        /^@lazy\/pkg \(its dependency\) is in the initial load \(assets\/[\w-]+\.js\)/,
      ),
    ]);
  });

  it("fails a module that loads with one it must only come after", async () => {
    const lazyDist = await buildApp(officeApp({ eager: false }));
    expect(
      notLazy(measureBundle(lazyDist), readChunkModules(lazyDist), OFFICE_LAZY),
    ).toEqual([]);

    const dist = await buildApp(officeApp({ eager: true }));
    const sizes = measureBundle(dist);
    const chunks = readChunkModules(dist) as ChunkModules;
    // Not in the initial load, nor in the screen's own chunk, but in one
    // that chunk imports statically.
    const office = chunkOf(chunks, "office.js") as string;
    const screen = chunkOf(chunks, "screen.js") as string;
    expect(office).not.toBe(screen);
    expect(chunks[screen]?.imports).toContain(office);
    expect(sizes.find((size) => size.file === office)?.initial).toBe(false);
    expect(overBudget(sizes)).toEqual([]);
    expect(notLazy(sizes, chunks, OFFICE_LAZY)).toEqual([
      `office.js (the office) loads with screen.js (${office}) but must load only after it, on demand: a static import from that module's graph pulls it in. Import it with import() or React.lazy instead.`,
      expect.stringMatching(
        `^@lazy/pkg \\(its dependency\\) loads with screen\\.js \\(${office}\\)`,
      ),
    ]);
    expect(lazyRules(OFFICE_LAZY)).toEqual([
      "Not in the initial load: screen.js, office.js, @lazy/pkg.",
      "Not loaded with screen.js, only after it: office.js, @lazy/pkg.",
    ]);
  });

  it("fails without a module list, with one from another build, or when a lazy module is gone", async () => {
    const dist = await fakeDist({
      "index.html": INDEX_HTML,
      "assets/index-a1.js": 'const lazy=()=>import("./Lazy-e5.js");',
      "assets/vendor-b2.js": "export const x=1;",
      "assets/Lazy-e5.js": "export const y=2;",
    });
    const sizes = measureBundle(dist);
    expect(readChunkModules(dist)).toBeNull();
    expect(notLazy(sizes, null, FIXTURE_LAZY)).toEqual([
      expect.stringMatching(`^Found no ${MODULES_FILE} in the build`),
    ]);
    const chunk = (...modules: string[]) => ({ modules, imports: [] });
    expect(
      notLazy(sizes, { "assets/index-z9.js": chunk("main.js") }, FIXTURE_LAZY),
    ).toEqual([
      `${MODULES_FILE} does not list assets/index-a1.js, assets/vendor-b2.js: it is from another build. Rebuild the web app.`,
    ]);
    const chunks = {
      "assets/index-a1.js": chunk("main.js"),
      "assets/vendor-b2.js": chunk("eagerpkg"),
      "assets/Lazy-e5.js": chunk("lazy.js"),
    };
    expect(
      notLazy(sizes, chunks, {
        "lazy.js": { what: "the lazy module", after: ["gone.js"] },
        "@lazy/pkg": { what: "its dependency" },
      }),
    ).toEqual([
      "gone.js (which lazy.js loads after) is in no chunk of the build: if it moved or was renamed, update LAZY_MODULES in apps/web/bundleSize.ts.",
      "@lazy/pkg (its dependency) is in no chunk of the build: if it moved or was renamed, update LAZY_MODULES in apps/web/bundleSize.ts.",
    ]);
  });

  it("lists the web app's lazy files where they are", () => {
    const files = [
      ...Object.keys(LAZY_MODULES),
      ...Object.values(LAZY_MODULES).flatMap((module) => module.after ?? []),
    ].filter((id) => id.startsWith("src/"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files)
      expect(existsSync(fileURLToPath(new URL(file, import.meta.url)))).toBe(
        true,
      );
  });
});
