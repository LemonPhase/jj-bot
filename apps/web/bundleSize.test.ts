import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AssetSize,
  chunkModules,
  formatReport,
  htmlAssets,
  initialJs,
  LAZY_MODULES,
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

/** What the fixture app below must load on demand. */
const FIXTURE_LAZY = {
  "lazy.js": "the lazy module",
  "@lazy/pkg": "its dependency",
};

/**
 * A tiny app built by Vite with `chunkModules`, into its `dist`: `main.js`
 * loads `lazy.js` with import(), and with `eager` also imports it statically,
 * the regression the lazy-module check is for.
 */
async function buildApp({ eager }: { eager: boolean }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "jj-bundle-app-"));
  dirs.push(root);
  const pkg = (name: string, code: string) => ({
    [`node_modules/${name}/package.json`]: JSON.stringify({
      name,
      type: "module",
      main: "index.js",
    }),
    [`node_modules/${name}/index.js`]: code,
  });
  const files: Record<string, string> = {
    "index.html":
      '<!doctype html><script type="module" src="/main.js"></script>',
    "main.js": [
      eager && 'import { lazyWord } from "./lazy.js";',
      'import { word } from "eagerpkg";',
      eager && "console.log(lazyWord);",
      "console.log(word);",
      'document.body.onclick = () => import("./lazy.js").then((m) => console.log(m.lazyWord));',
    ]
      .filter(Boolean)
      .join("\n"),
    "lazy.js":
      'import { big } from "@lazy/pkg";\nexport const lazyWord = `lazy ${big}`;',
    ...pkg("eagerpkg", 'export const word = "eager";'),
    ...pkg("@lazy/pkg", 'export const big = "x".repeat(10);'),
  };
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content);
  }
  await build({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [chunkModules()],
  });
  return join(root, "dist");
}

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
  });

  it("lists every chunk's modules from a real build", async () => {
    const dist = await buildApp({ eager: false });
    const sizes = measureBundle(dist);
    const chunks = readChunkModules(dist);
    const js = sizes.filter((size) => size.file.endsWith(".js"));
    const entry = js.find((size) => size.initial) as AssetSize;
    const lazy = js.find((size) => !size.initial) as AssetSize;
    expect(chunks?.[entry.file]).toEqual(
      expect.arrayContaining(["main.js", "eagerpkg"]),
    );
    expect(chunks?.[entry.file]).not.toContain("lazy.js");
    expect(chunks?.[lazy.file]).toEqual(
      expect.arrayContaining(["lazy.js", "@lazy/pkg"]),
    );
    expect(notLazy(sizes, chunks, FIXTURE_LAZY)).toEqual([]);
  });

  it("fails a module a static import pulls into the initial load, however small", async () => {
    const dist = await buildApp({ eager: true });
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
    expect(
      notLazy(sizes, { "assets/index-z9.js": ["main.js"] }, FIXTURE_LAZY),
    ).toEqual([
      `${MODULES_FILE} does not list assets/index-a1.js, assets/vendor-b2.js: it is from another build. Rebuild the web app.`,
    ]);
    const chunks = {
      "assets/index-a1.js": ["main.js"],
      "assets/vendor-b2.js": ["eagerpkg"],
      "assets/Lazy-e5.js": ["lazy.js"],
    };
    expect(notLazy(sizes, chunks, FIXTURE_LAZY)).toEqual([
      "@lazy/pkg (its dependency) is in no chunk of the build: if it moved or was renamed, update LAZY_MODULES in apps/web/bundleSize.ts.",
    ]);
  });

  it("lists the web app's lazy files where they are", () => {
    const files = Object.keys(LAZY_MODULES).filter((id) =>
      id.startsWith("src/"),
    );
    expect(files.length).toBeGreaterThan(0);
    for (const file of files)
      expect(existsSync(fileURLToPath(new URL(file, import.meta.url)))).toBe(
        true,
      );
  });
});
