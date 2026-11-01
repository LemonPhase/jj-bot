import { describe, expect, it } from "vitest";
import {
  BASE_HEIGHT,
  bubblePlacement,
  DESK_COLUMNS,
  DESK_WIDTH,
  huddleSpot,
  LANE_Y,
  officeLayout2D,
  type Pt,
  ROW_PITCH,
  route2D,
  SCENE_WIDTH,
  SPRITE,
  visitSpot,
} from "./layout2d";

const COUNTS = [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 13, 20];

/**
 * The table with its side stools. No sprite may stand on it or walk across
 * it (the small stools above and below the table may be overlapped, as in
 * the design's hallway).
 */
const TABLE = { x0: 60, x1: 108, y0: 49, y1: 63 };

/** Whether a sprite sweeping from (x0, y0) to (x1, y1) touches the table. */
const overlapsTable = (x0: number, y0: number, x1 = x0, y1 = y0) =>
  Math.max(x0, x1) + SPRITE > TABLE.x0 &&
  Math.min(x0, x1) < TABLE.x1 &&
  Math.max(y0, y1) + SPRITE > TABLE.y0 &&
  Math.min(y0, y1) < TABLE.y1;

describe("officeLayout2D: a desk grid that wraps for any number of bots", () => {
  it.each(COUNTS)("seats %i bots, each at their own desk", (n) => {
    const layout = officeLayout2D(n);
    expect(layout.desks.length).toBeGreaterThanOrEqual(n);
    expect(layout.desks.length % DESK_COLUMNS).toBe(0);
    expect(layout.rows).toBe(Math.max(2, Math.ceil(n / DESK_COLUMNS)));
    // No spare row: every row beyond the designed two holds at least one bot.
    if (n > 6) expect(layout.desks.length - n).toBeLessThan(DESK_COLUMNS);
    const homes = new Set(layout.desks.map((d) => `${d.home.x},${d.home.y}`));
    expect(homes.size).toBe(layout.desks.length);
  });

  it.each(COUNTS)("keeps %i bots' desks and sprites inside the room", (n) => {
    const { desks, height, width } = officeLayout2D(n);
    expect(width).toBe(SCENE_WIDTH);
    for (const d of desks) {
      expect(d.x0).toBeGreaterThanOrEqual(0);
      expect(d.x0 + DESK_WIDTH).toBeLessThanOrEqual(width);
      expect(d.deskY + 10).toBeLessThanOrEqual(height);
      expect(d.home.y + SPRITE).toBeLessThanOrEqual(height);
      expect(overlapsTable(d.home.x, d.home.y)).toBe(false);
    }
  });

  it("keeps the designed room for small teams and grows by one row per three bots", () => {
    expect(officeLayout2D(0).height).toBe(BASE_HEIGHT);
    expect(officeLayout2D(2).height).toBe(BASE_HEIGHT);
    expect(officeLayout2D(6).height).toBe(BASE_HEIGHT);
    expect(officeLayout2D(7).height).toBe(BASE_HEIGHT + ROW_PITCH);
    expect(officeLayout2D(13).height).toBe(BASE_HEIGHT + 3 * ROW_PITCH);
  });

  it("matches the design: back desks at x0 58/88/118 with homes at (x0+5, 29)", () => {
    const back = officeLayout2D(3).desks.filter((d) => d.kind === "back");
    expect(back.map((d) => d.home)).toEqual([
      { x: 63, y: 29 },
      { x: 93, y: 29 },
      { x: 123, y: 29 },
    ]);
    const front = officeLayout2D(6).desks.filter((d) => d.row === 1);
    expect(front.map((d) => [d.deskY, d.home.y])).toEqual([
      [88, 74],
      [88, 74],
      [88, 74],
    ]);
  });

  it("fills desks row by row, left to right, with no special case for two bots", () => {
    const desks = officeLayout2D(2).desks;
    expect(desks.slice(0, 2).map((d) => [d.row, d.col])).toEqual([
      [0, 0],
      [0, 1],
    ]);
    expect(officeLayout2D(4).desks[3]).toMatchObject({ row: 1, col: 0 });
  });
});

describe("route2D: Manhattan walks that avoid the table", () => {
  const layout = officeLayout2D(13);
  const spots: Pt[] = [
    ...layout.desks.map((d) => d.home),
    { x: 21, y: 17 },
    { x: 132, y: 44 },
    ...Array.from({ length: 9 }, (_, i) => huddleSpot(i)),
  ];

  it("uses the designed hallway between desks above the table", () => {
    expect(route2D({ x: 63, y: 29 }, { x: 21, y: 17 })).toEqual([
      { x: 63, y: LANE_Y },
      { x: 21, y: LANE_Y },
      { x: 21, y: 17 },
    ]);
  });

  it("goes nowhere when already there", () => {
    expect(route2D({ x: 63, y: 29 }, { x: 63, y: 29 })).toEqual([]);
  });

  it("walks axis-aligned segments, ends at the target, and never crosses the table", () => {
    for (const from of spots) {
      for (const to of spots) {
        const path = route2D(from, to);
        if (from.x === to.x && from.y === to.y) continue;
        expect(path.at(-1)).toEqual(to);
        let last = from;
        for (const p of path) {
          expect(p.x === last.x || p.y === last.y).toBe(true);
          expect(overlapsTable(last.x, last.y, p.x, p.y)).toBe(false);
          last = p;
        }
      }
    }
  });
});

describe("spots and bubbles", () => {
  it("puts the first three huddle spots where the design does", () => {
    expect([0, 1, 2].map(huddleSpot)).toEqual([
      { x: 66, y: 37 },
      { x: 79, y: 37 },
      { x: 92, y: 37 },
    ]);
    const many = Array.from({ length: 12 }, (_, i) => huddleSpot(i));
    expect(new Set(many.map((p) => `${p.x},${p.y}`)).size).toBe(12);
  });

  it("stands a visitor beside the bot, on the side they come from, inside the room", () => {
    expect(visitSpot({ x: 93, y: 29 }, { x: 63, y: 29 })).toEqual({
      x: 80,
      y: 29,
    });
    expect(visitSpot({ x: 93, y: 29 }, { x: 123, y: 29 })).toEqual({
      x: 106,
      y: 29,
    });
    expect(
      visitSpot({ x: 150, y: 29 }, { x: 155, y: 29 }).x,
    ).toBeLessThanOrEqual(SCENE_WIDTH - SPRITE);
  });

  it("places speech bubbles per the design and inside the scene", () => {
    const user = bubblePlacement("user", 104);
    expect(user.left).toBeCloseTo(0.57);
    expect(user.top).toBeCloseTo(0.5);
    expect(bubblePlacement({ x: 21, y: 17 }, 104)).toEqual({
      left: 0.02,
      top: 33 / 104,
    });
    const p = bubblePlacement({ x: 150, y: 29 }, 104);
    expect(p.left).toBeLessThanOrEqual(0.62);
    expect(p.top).toBeGreaterThanOrEqual(0.02);
  });
});
