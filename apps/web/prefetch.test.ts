import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { build } from "vite";
import { afterEach, describe, expect, it } from "vitest";
import { chunkModules, htmlAssets, measureBundle } from "./bundleSize";
import { PREFETCH_MODULES, prefetchChunks, prefetchFiles } from "./prefetch";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true })));
});

const chunk = (
  fileName: string,
  moduleIds: string[],
  imports: string[] = [],
  css: string[] = [],
) => ({
  fileName,
  moduleIds: moduleIds.map((id) => `/app/${id}`),
  imports,
  viteMetadata: { importedCss: new Set(css) },
});

/**
 * A bundle as Vite builds it: the entry with a shared chunk, a dialog that
 * imports a helper the Tasks screen shares, and the stylesheets they bring.
 */
const BUNDLE = Object.fromEntries(
  [
    chunk(
      "assets/index-a.js",
      ["src/main.tsx"],
      ["assets/vendor-b.js"],
      ["assets/index-c.css"],
    ),
    chunk("assets/vendor-b.js", ["src/lib/x.ts"]),
    chunk(
      "assets/Dialog-d.js",
      ["src/Dialog.tsx"],
      ["assets/vendor-b.js", "assets/helper-e.js"],
      ["assets/index-c.css", "assets/dialog-f.css"],
    ),
    chunk("assets/helper-e.js", ["src/helper.ts"], [], ["assets/helper-g.css"]),
    chunk("assets/Tasks-h.js", ["src/Tasks.tsx"], ["assets/helper-e.js"]),
  ].map((c) => [c.fileName, c]),
);

describe("prefetch of the first screen's on-demand parts", () => {
  it("lists a module's chunk, its static imports and their stylesheets, less what the page loads", () => {
    expect(
      prefetchFiles(BUNDLE, "assets/index-a.js", ["src/Dialog.tsx"], "/app"),
    ).toEqual([
      "assets/Dialog-d.js",
      "assets/dialog-f.css",
      "assets/helper-e.js",
      "assets/helper-g.css",
    ]);
  });

  it("refuses a module in no chunk, or one the page loads anyway", () => {
    expect(() =>
      prefetchFiles(BUNDLE, "assets/index-a.js", ["src/Gone.tsx"], "/app"),
    ).toThrow("prefetchChunks: src/Gone.tsx is in no chunk.");
    expect(() =>
      prefetchFiles(BUNDLE, "assets/index-a.js", ["src/lib/x.ts"], "/app"),
    ).toThrow(/src\/lib\/x\.ts loads with the page \(assets\/vendor-b\.js\)/);
  });

  it("names the web app's modules by their files", () => {
    expect(PREFETCH_MODULES).toEqual([
      "src/features/tasks/NewTaskDialog.tsx",
      "src/features/bots/BotInspector.tsx",
    ]);
  });

  it("adds prefetch links to a real build's index.html, outside the initial load", async () => {
    const root = await mkdtemp(join(tmpdir(), "jj-prefetch-app-"));
    dirs.push(root);
    const files: Record<string, string> = {
      "index.html":
        '<!doctype html><script type="module" src="/main.js"></script>',
      "main.js": 'document.body.onclick = () => import("./lazy.js");',
      "lazy.js": 'import "./lazy.css";\nexport const lazy = "lazy";',
      "lazy.css": ".lazy { color: red; }",
    };
    for (const [file, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, file)), { recursive: true });
      await writeFile(join(root, file), content);
    }
    await build({
      root,
      configFile: false,
      logLevel: "silent",
      plugins: [chunkModules(), prefetchChunks(["lazy.js"])],
    });
    const dist = join(root, "dist");
    const html = await readFile(join(dist, "index.html"), "utf8");
    const prefetched = [
      ...html.matchAll(/<link rel="prefetch" href="\/([^"]+)" crossorigin/g),
    ].map(([, file]) => file);
    expect(prefetched).toHaveLength(2);
    expect(prefetched).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^assets\/lazy-[\w-]+\.css$/),
        expect.stringMatching(/^assets\/lazy-[\w-]+\.js$/),
      ]),
    );
    // The size check counts them as on demand, not as the initial load.
    expect(htmlAssets(html).some((file) => file.includes("lazy"))).toBe(false);
    const lazy = measureBundle(dist).filter((s) => s.file.includes("lazy"));
    expect(lazy.map((s) => s.initial)).toEqual([false, false]);
  });
});
