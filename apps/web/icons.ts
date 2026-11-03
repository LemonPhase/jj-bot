/**
 * The install icons of the web app (`npm run icons -w @jj/web`): PNGs of the
 * JJ Bot mark for the web manifest and iOS, written to `public/`. The mark
 * is read from `public/favicon.svg`, which PixelIcon.test.tsx keeps equal to
 * the brand grid, so the icons follow the brand. icons.test.ts fails when a
 * committed PNG no longer matches what this draws.
 *
 * The mark is the dark theme's: the head in its --ink on its --bg-app, the
 * eyes holes that show the ground, the antenna tip bot coral. Every cell is a
 * whole number of pixels, so the edges stay crisp.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";

const PUBLIC = fileURLToPath(new URL("./public", import.meta.url));

/** The dark theme's --bg-app and --ink (src/styles/tokens.css). */
const GROUND = "#0b0b0d";
const HEAD = "#ededf0";

export interface IconSpec {
  /** Path under `public/`, as the manifest and index.html link it. */
  file: string;
  size: number;
  /**
   * `any`: a rounded tile with transparent corners, the mark in its middle
   * 62%. `maskable`: the ground to every edge and the mark inside the
   * central 80% circle a launcher may crop to. `touch`: iOS, which rounds
   * the corners itself and shows transparency as black, so a full square.
   */
  shape: "any" | "maskable" | "touch";
}

export const ICONS: readonly IconSpec[] = [
  { file: "icons/icon-192.png", size: 192, shape: "any" },
  { file: "icons/icon-512.png", size: 512, shape: "any" },
  { file: "icons/icon-maskable-512.png", size: 512, shape: "maskable" },
  { file: "apple-touch-icon.png", size: 180, shape: "touch" },
];

type Rgba = [number, number, number, number];

const rgba = (hex: string): Rgba => {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255, 255];
};

/** The brand mark's cells, by colour, from favicon.svg's one-cell-high runs. */
export function brandCells(svg: string): { cells: Set<string>; fill: Rgba }[] {
  const paths = [...svg.matchAll(/<path\b([^>]*)\/>/g)].map(([, attrs]) => ({
    fill: attrs?.match(/\bfill="([^"]+)"/)?.[1] ?? "",
    head: /\bclass="head"/.test(attrs ?? ""),
    d: attrs?.match(/\bd="([^"]+)"/)?.[1] ?? "",
  }));
  if (paths.length !== 2) throw new Error("favicon.svg: expected two paths");
  return paths.map(({ fill, head, d }) => {
    const cells = new Set<string>();
    const runs = [...d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)];
    if (d.replace(/M(\d+) (\d+)h(\d+)v1h-\3z/g, "") !== "")
      throw new Error(`favicon.svg: not one-cell runs: ${d}`);
    for (const [, x, y, w] of runs)
      for (let i = 0; i < Number(w); i += 1)
        cells.add(`${Number(x) + i},${Number(y)}`);
    return { cells, fill: rgba(head ? HEAD : fill) };
  });
}

/** The cells' bounds, so the mark is centred on what it draws. */
function bounds(cells: Iterable<string>) {
  let [minX, minY, maxX, maxY] = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    0,
    0,
  ];
  for (const cell of cells) {
    const [x = 0, y = 0] = cell.split(",").map(Number);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return { minX, minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** How much of the pixel at (x, y) a rounded square of `size` covers, 0 to 1. */
function tileCoverage(x: number, y: number, size: number, radius: number) {
  const samples = 4;
  let inside = 0;
  for (let sy = 0; sy < samples; sy += 1)
    for (let sx = 0; sx < samples; sx += 1) {
      const px = x + (sx + 0.5) / samples;
      const py = y + (sy + 0.5) / samples;
      const cx = Math.min(Math.max(px, radius), size - radius);
      const cy = Math.min(Math.max(py, radius), size - radius);
      if ((px - cx) ** 2 + (py - cy) ** 2 <= radius ** 2) inside += 1;
    }
  return inside / samples ** 2;
}

/** One icon's pixels, RGBA row by row. */
export function renderIcon(spec: IconSpec, svg: string): Uint8Array {
  const { size, shape } = spec;
  const layers = brandCells(svg);
  const box = bounds(layers.flatMap(({ cells }) => [...cells]));
  // The share of the side the mark's taller edge may take.
  const share = shape === "maskable" ? 0.5 : 0.62;
  const cell = Math.floor((size * share) / Math.max(box.width, box.height));
  const left = Math.round((size - box.width * cell) / 2);
  const top = Math.round((size - box.height * cell) / 2);
  const ground = rgba(GROUND);
  const pixels = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1)
    for (let x = 0; x < size; x += 1) {
      const gx = Math.floor((x - left) / cell) + box.minX;
      const gy = Math.floor((y - top) / cell) + box.minY;
      const inMark = x >= left && y >= top;
      const layer = inMark
        ? layers.find(({ cells }) => cells.has(`${gx},${gy}`))
        : undefined;
      const colour = layer?.fill ?? ground;
      const alpha =
        shape === "any" ? tileCoverage(x, y, size, size * 0.1875) : 1;
      pixels.set(
        [colour[0], colour[1], colour[2], Math.round(255 * alpha)],
        (y * size + x) * 4,
      );
    }
  return pixels;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 255] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** An 8-bit RGBA PNG, every row unfiltered. */
export function encodePng(size: number, pixels: Uint8Array): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 6, 0, 0, 0], 8);
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y += 1)
    rows.set(
      pixels.subarray(y * size * 4, (y + 1) * size * 4),
      y * (size * 4 + 1) + 1,
    );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(rows, { level: 9 })),
    chunk("IEND", new Uint8Array()),
  ]);
}

export const readFavicon = (publicDir = PUBLIC) =>
  readFileSync(join(publicDir, "favicon.svg"), "utf8");

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const svg = readFavicon();
  for (const spec of ICONS) {
    writeFileSync(
      join(PUBLIC, spec.file),
      encodePng(spec.size, renderIcon(spec, svg)),
    );
    console.log(`wrote public/${spec.file} (${spec.size}×${spec.size})`);
  }
}
