import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { chunkStylesheetList, formatStylesheetList } from "./chunkStylesheets";

const chunk = (
  fileName: string,
  facade: string | null,
  imports: string[] = [],
  css: string[] = [],
) => ({
  fileName,
  facadeModuleId: facade && `/app/src/${facade}`,
  isDynamicEntry: facade !== null && fileName !== "assets/index-a.js",
  imports,
  viteMetadata: { importedCss: new Set(css) },
});

/** The page's entry, a dialog sharing a helper's stylesheet, and a panel with none. */
const BUNDLE = Object.fromEntries(
  [
    chunk("assets/index-a.js", "main.tsx", [], ["assets/index-b.css"]),
    chunk(
      "assets/NewTaskDialog-c.js",
      "features/tasks/NewTaskDialog.tsx",
      ["assets/helper-d.js"],
      ["assets/index-b.css"],
    ),
    chunk("assets/helper-d.js", null, [], ["assets/tasks-e.css"]),
    chunk("assets/BotInspector-f.js", "features/bots/BotInspector.tsx?x=1"),
  ].map((c) => [c.fileName, c]),
);

describe("each lazy chunk's stylesheets", () => {
  it("lists every chunk imported on demand by its module's name, less the page's stylesheets", () => {
    const list = chunkStylesheetList(BUNDLE, "assets/index-a.js");
    expect(list).toEqual({
      BotInspector: [],
      NewTaskDialog: ["assets/tasks-e.css"],
    });
    expect(formatStylesheetList(list)).toBe(
      "BotInspector=;NewTaskDialog=/assets/tasks-e.css",
    );
  });

  it("names every lazy part after the module it imports, the key the list uses", () => {
    const src = fileURLToPath(new URL("./src", import.meta.url));
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory()
          ? files(join(dir, entry.name))
          : /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)
            ? [join(dir, entry.name)]
            : [],
      );
    const parts = files(src).flatMap((file) => [
      ...readFileSync(file, "utf8").matchAll(
        /lazyComponent\(\s*"([^"]+)",\s*\(\)\s*=>\s*import\("([^"]+)"\)/g,
      ),
    ]);
    expect(parts.length).toBeGreaterThanOrEqual(9);
    for (const [, name, path] of parts) expect(basename(path ?? "")).toBe(name);
  });
});
