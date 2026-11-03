import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { brandCells, ICONS, readFavicon, renderIcon } from "./icons";

const here = fileURLToPath(new URL(".", import.meta.url));
const read = (path: string) => readFileSync(join(here, path));

/** A PNG's size and RGBA pixels; only what icons.ts writes (8-bit RGBA, no filters). */
function decodePng(bytes: Buffer) {
  expect(bytes.subarray(0, 8)).toEqual(
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  );
  let offset = 8;
  let width = 0;
  let height = 0;
  const data: Buffer[] = [];
  while (offset < bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const body = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      expect([...body.subarray(8, 13)]).toEqual([8, 6, 0, 0, 0]);
    }
    if (type === "IDAT") data.push(body);
    offset += 12 + length;
  }
  const rows = inflateSync(Buffer.concat(data));
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const start = y * (width * 4 + 1);
    expect(rows[start]).toBe(0);
    pixels.set(rows.subarray(start + 1, start + 1 + width * 4), y * width * 4);
  }
  return { width, height, pixels };
}

describe("install icons", () => {
  const svg = readFavicon(join(here, "public"));

  it("read the brand mark from favicon.svg: the head and its coral tip", () => {
    const [head, tip] = brandCells(svg);
    expect(head?.cells.size).toBe(80);
    // The eyes are holes in the head.
    expect(head?.cells.has("3,5")).toBe(false);
    expect([...(tip?.cells ?? [])].sort()).toEqual(["5,0", "6,0"]);
    expect(tip?.fill).toEqual([0xff, 0x7a, 0x66, 255]);
  });

  for (const spec of ICONS)
    it(`public/${spec.file} is what icons.ts draws (npm run icons -w @jj/web)`, () => {
      const png = decodePng(read(`public/${spec.file}`));
      expect([png.width, png.height]).toEqual([spec.size, spec.size]);
      expect(Buffer.from(png.pixels).equals(renderIcon(spec, svg))).toBe(true);
    });

  it("are opaque where a launcher may crop or iOS fills, and round only the any icons", () => {
    for (const spec of ICONS) {
      const { pixels, width } = decodePng(read(`public/${spec.file}`));
      const corner = pixels[3];
      const middle = pixels[((width / 2) * width + width / 2) * 4 + 3];
      expect(middle, spec.file).toBe(255);
      expect(corner, spec.file).toBe(spec.shape === "any" ? 0 : 255);
    }
  });

  it("are the ones the manifest and index.html link", () => {
    const manifest = JSON.parse(read("public/manifest.webmanifest").toString());
    const linked = manifest.icons.map(
      (icon: { src: string; sizes: string; purpose: string }) =>
        `${icon.src} ${icon.sizes} ${icon.purpose}`,
    );
    expect(linked).toEqual(
      ICONS.filter((spec) => spec.shape !== "touch").map(
        (spec) =>
          `/${spec.file} ${spec.size}x${spec.size} ${spec.shape === "maskable" ? "maskable" : "any"}`,
      ),
    );
    const html = read("index.html").toString();
    expect(html).toContain(
      '<link rel="manifest" href="/manifest.webmanifest" />',
    );
    expect(html).toContain(
      '<link rel="apple-touch-icon" href="/apple-touch-icon.png" />',
    );
    expect(ICONS.find((spec) => spec.shape === "touch")?.file).toBe(
      "apple-touch-icon.png",
    );
  });
});
