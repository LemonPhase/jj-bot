import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AssetSize,
  formatReport,
  htmlAssets,
  initialJs,
  measureBundle,
  overBudget,
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
  for (const [file, content] of Object.entries(files))
    await writeFile(join(dist, file), content);
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
